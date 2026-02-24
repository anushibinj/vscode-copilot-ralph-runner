import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// RALPH Runner — Autonomous Task Runner for VS Code
//
// Reads prd.json for user story definitions and tracks progress inline.
// Loops autonomously (up to MAX_AUTONOMOUS_LOOPS) injecting Copilot chat
// tasks for each user story. Fully resumable.
//
// Task execution state is persisted in the .ralph directory:
//   .ralph/task-<id>-status  →  "inprogress" | "completed"
// This provides a reliable, crash-safe lock that prevents overlapping tasks.
// ────────────────────────────────────────────────────────────────────────────

// ── Configuration helpers ───────────────────────────────────────────────────

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('ralph-runner');
	return {
		MAX_AUTONOMOUS_LOOPS: cfg.get<number>('maxAutonomousLoops', 2),
		LOOP_DELAY_MS: cfg.get<number>('loopDelayMs', 3000),
		COPILOT_RESPONSE_POLL_MS: cfg.get<number>('copilotResponsePollMs', 5000),
		COPILOT_TIMEOUT_MS: cfg.get<number>('copilotTimeoutMs', 600000),
		COPILOT_MIN_WAIT_MS: cfg.get<number>('copilotMinWaitMs', 15000),
	};
}

// ── Types ───────────────────────────────────────────────────────────────────

interface PrdFile {
	project: string;
	branchName: string;
	description: string;
	userStories: UserStory[];
}

interface UserStory {
	id: string;           // e.g. "US-001"
	title: string;
	description: string;
	acceptanceCriteria: string[];
	priority: number;
}

// ── Filesystem Task State Manager ────────────────────────────────────────────
// Manages .ralph/task-<id>-status files to provide a durable, process-safe
// execution lock.  File content is either "inprogress" or "completed".

const RALPH_DIR = '.ralph';
const PRD_FILENAME = 'prd.json';
const PROGRESS_FILENAME = 'progress.txt';

class RalphStateManager {

	/** Absolute path to the .ralph directory for the workspace. */
	static getRalphDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, RALPH_DIR);
	}

	/** Absolute path to the status file for a given task id. */
	static getTaskStatusPath(workspaceRoot: string, taskId: string): string {
		return path.join(RalphStateManager.getRalphDir(workspaceRoot), `task-${taskId}-status`);
	}

	/**
	 * Ensure the .ralph directory exists.  Safe to call multiple times.
	 */
	static ensureDir(workspaceRoot: string): void {
		const dir = RalphStateManager.getRalphDir(workspaceRoot);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	/**
	 * Write "inprogress" for the given task.
	 * Creates the .ralph directory if it does not yet exist.
	 * Overwrites any previous state for this task id.
	 */
	static setInProgress(workspaceRoot: string, taskId: string): void {
		RalphStateManager.ensureDir(workspaceRoot);
		fs.writeFileSync(
			RalphStateManager.getTaskStatusPath(workspaceRoot, taskId),
			'inprogress',
			{ encoding: 'utf-8', flag: 'w' }
		);
	}

	/**
	 * Write "completed" for the given task.
	 * Safe to call even if the file does not already exist.
	 */
	static setCompleted(workspaceRoot: string, taskId: string): void {
		RalphStateManager.ensureDir(workspaceRoot);
		fs.writeFileSync(
			RalphStateManager.getTaskStatusPath(workspaceRoot, taskId),
			'completed',
			{ encoding: 'utf-8', flag: 'w' }
		);
	}

	/**
	 * Read the current task state from disk.
	 * Returns "inprogress" | "completed" | "none" (file absent or unreadable).
	 */
	static getTaskStatus(workspaceRoot: string, taskId: string): 'inprogress' | 'completed' | 'none' {
		const filePath = RalphStateManager.getTaskStatusPath(workspaceRoot, taskId);
		try {
			const content = fs.readFileSync(filePath, 'utf-8').trim();
			if (content === 'inprogress' || content === 'completed') { return content; }
		} catch { /* file missing or unreadable */ }
		return 'none';
	}

	/**
	 * Returns the id of the first task whose status file contains "inprogress",
	 * or null if no task is currently active.
	 */
	static getInProgressTaskId(workspaceRoot: string): string | null {
		const dir = RalphStateManager.getRalphDir(workspaceRoot);
		if (!fs.existsSync(dir)) { return null; }

		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return null;
		}

		for (const entry of entries) {
			const match = entry.match(/^task-(.+)-status$/);
			if (!match) { continue; }
			const taskId = match[1];
			if (RalphStateManager.getTaskStatus(workspaceRoot, taskId) === 'inprogress') {
				return taskId;
			}
		}
		return null;
	}

	/** True if any task status file currently contains "inprogress". */
	static isAnyInProgress(workspaceRoot: string): boolean {
		return RalphStateManager.getInProgressTaskId(workspaceRoot) !== null;
	}

	/**
	 * Reset a stalled inprogress task back to "none" by deleting its file.
	 * Used during startup recovery when a previous RALPH session crashed.
	 */
	static clearStalledTask(workspaceRoot: string, taskId: string): void {
		const filePath = RalphStateManager.getTaskStatusPath(workspaceRoot, taskId);
		try {
			if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
		} catch { /* ignore */ }
	}

	/**
	 * Ensure `.ralph/` is present in the workspace's .gitignore.
	 * Creates .gitignore if it does not exist. Safe to call multiple times.
	 */
	static ensureGitignore(workspaceRoot: string): void {
		const gitignorePath = path.join(workspaceRoot, '.gitignore');
		const entriesToIgnore = ['.ralph/'];

		try {
			let content = '';
			if (fs.existsSync(gitignorePath)) {
				content = fs.readFileSync(gitignorePath, 'utf-8');
			}

			const missing: string[] = [];
			for (const entry of entriesToIgnore) {
				// Build a regex that matches the entry (with optional trailing slash/backslash)
				const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const pattern = new RegExp(`^\\s*${escaped}\\s*$`, 'm');
				if (!pattern.test(content)) {
					missing.push(entry);
				}
			}

			if (missing.length === 0) { return; }

			// Append with a leading newline if the file doesn't already end with one
			const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
			const block = missing.join('\n');
			fs.writeFileSync(gitignorePath, `${content}${separator}\n# RALPH Runner task state\n${block}\n`, 'utf-8');
			log(`  Added to .gitignore: ${missing.join(', ')}`);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`  WARNING: Could not update .gitignore: ${msg}`);
		}
	}
}

// ── PRD File Operations ─────────────────────────────────────────────────────

function getPrdPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, PRD_FILENAME);
}

function parsePrd(workspaceRoot: string): PrdFile | null {
	const prdPath = getPrdPath(workspaceRoot);
	try {
		const content = fs.readFileSync(prdPath, 'utf-8');
		return JSON.parse(content) as PrdFile;
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		log(`ERROR: Failed to read/parse prd.json: ${msg}`);
		return null;
	}
}

// ── Progress File Operations ─────────────────────────────────────────────────
// progress.txt tracks which user stories have been completed or failed.
// Each line is: <storyId> | <status> | <timestamp> | <notes>
// e.g.: US-001 | done | 2026-02-24 12:00:00 | Completed successfully

interface ProgressEntry {
	id: string;
	status: 'done' | 'failed';
	timestamp: string;
	notes: string;
}

function getProgressPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, PROGRESS_FILENAME);
}

function readProgress(workspaceRoot: string): ProgressEntry[] {
	const progressPath = getProgressPath(workspaceRoot);
	if (!fs.existsSync(progressPath)) { return []; }

	try {
		const content = fs.readFileSync(progressPath, 'utf-8');
		const entries: ProgressEntry[] = [];

		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) { continue; }

			const parts = trimmed.split('|').map(p => p.trim());
			if (parts.length >= 2) {
				entries.push({
					id: parts[0],
					status: parts[1] as 'done' | 'failed',
					timestamp: parts[2] || '',
					notes: parts[3] || '',
				});
			}
		}

		return entries;
	} catch {
		return [];
	}
}

function writeProgressEntry(workspaceRoot: string, id: string, status: 'done' | 'failed', notes: string): void {
	const progressPath = getProgressPath(workspaceRoot);
	const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
	const line = `${id} | ${status} | ${timestamp} | ${notes}`;

	let content = '';
	if (fs.existsSync(progressPath)) {
		content = fs.readFileSync(progressPath, 'utf-8');

		// Remove any existing entry for this id so we don't duplicate
		const lines = content.split('\n').filter(l => {
			const trimmed = l.trim();
			if (!trimmed || trimmed.startsWith('#')) { return true; }
			const entryId = trimmed.split('|')[0].trim();
			return entryId !== id;
		});
		content = lines.join('\n');
	} else {
		content = '# RALPH Runner Progress\n# Format: <storyId> | <status> | <timestamp> | <notes>\n';
	}

	if (!content.endsWith('\n')) { content += '\n'; }
	content += line + '\n';

	fs.writeFileSync(progressPath, content, 'utf-8');
}

function removeProgressEntry(workspaceRoot: string, id: string): void {
	const progressPath = getProgressPath(workspaceRoot);
	if (!fs.existsSync(progressPath)) { return; }

	const content = fs.readFileSync(progressPath, 'utf-8');
	const lines = content.split('\n').filter(l => {
		const trimmed = l.trim();
		if (!trimmed || trimmed.startsWith('#')) { return true; }
		const entryId = trimmed.split('|')[0].trim();
		return entryId !== id;
	});
	fs.writeFileSync(progressPath, lines.join('\n') + '\n', 'utf-8');
}

function getStoryProgress(workspaceRoot: string, storyId: string): ProgressEntry | undefined {
	const entries = readProgress(workspaceRoot);
	return entries.find(e => e.id === storyId);
}

function findNextPendingStory(prd: PrdFile, workspaceRoot: string): UserStory | null {
	const progress = readProgress(workspaceRoot);
	const doneIds = new Set(progress.filter(e => e.status === 'done').map(e => e.id));

	// Sort by priority (ascending — lower number = higher priority)
	const sorted = [...prd.userStories].sort((a, b) => a.priority - b.priority);
	return sorted.find(s => !doneIds.has(s.id)) || null;
}

// ── Globals ─────────────────────────────────────────────────────────────────

let outputChannel: vscode.OutputChannel;
let cancelToken: vscode.CancellationTokenSource | null = null;
let isRunning = false;
let statusBarItem: vscode.StatusBarItem;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('RALPH Runner');

	// ── Status bar icon ────────────────────────────────────────────────────
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.text = '$(rocket) RALPH';
	statusBarItem.tooltip = 'RALPH Runner — click to show commands';
	statusBarItem.command = 'ralph-runner.showMenu';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	context.subscriptions.push(
		vscode.commands.registerCommand('ralph-runner.start', () => startRalph()),
		vscode.commands.registerCommand('ralph-runner.stop', () => stopRalph()),
		vscode.commands.registerCommand('ralph-runner.status', () => showStatus()),
		vscode.commands.registerCommand('ralph-runner.resetStep', () => resetStory()),
		vscode.commands.registerCommand('ralph-runner.openSettings', () => {
			vscode.commands.executeCommand('workbench.action.openSettings', 'ralph-runner');
		}),
		vscode.commands.registerCommand('ralph-runner.showMenu', () => showCommandMenu()),
		vscode.commands.registerCommand('ralph-runner.quickStart', () => quickStart())
	);

	log('RALPH Runner extension activated.');
}

export function deactivate() {
	stopRalph();
	statusBarItem?.dispose();
	outputChannel?.dispose();
}

// ── Core Loop ───────────────────────────────────────────────────────────────

async function startRalph(): Promise<void> {
	if (isRunning) {
		vscode.window.showWarningMessage('RALPH is already running.');
		return;
	}

	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}

	const prdPath = getPrdPath(workspaceRoot);
	if (!fs.existsSync(prdPath)) {
		vscode.window.showErrorMessage('prd.json not found in workspace root.');
		return;
	}

	// ── Startup: ensure .ralph/ dir exists and is gitignored in the workspace ──
	RalphStateManager.ensureDir(workspaceRoot);
	RalphStateManager.ensureGitignore(workspaceRoot);

	const stalledTaskId = RalphStateManager.getInProgressTaskId(workspaceRoot);
	if (stalledTaskId !== null) {
		const action = await vscode.window.showWarningMessage(
			`RALPH: Task ${stalledTaskId} was left "inprogress" from a previous interrupted run.`,
			'Clear & Retry', 'Cancel'
		);
		if (action !== 'Clear & Retry') {
			log(`Startup aborted — stalled task ${stalledTaskId} left untouched.`);
			return;
		}
		RalphStateManager.clearStalledTask(workspaceRoot, stalledTaskId);
		log(`Cleared stalled inprogress state for task ${stalledTaskId}.`);
	}

	const config = getConfig();

	isRunning = true;
	cancelToken = new vscode.CancellationTokenSource();
	outputChannel.show(true);
	log('═══════════════════════════════════════════════════');
	log('RALPH Runner started — autonomous task runner');
	log(`Max loops: ${config.MAX_AUTONOMOUS_LOOPS}`);
	log('═══════════════════════════════════════════════════');

	updateStatusBar('running');

	let loopsExecuted = 0;

	while (loopsExecuted < config.MAX_AUTONOMOUS_LOOPS && isRunning) {
		if (cancelToken?.token.isCancellationRequested) {
			log('Cancelled by user.');
			break;
		}

		// Re-read PRD each iteration (it may have been modified externally)
		const prd = parsePrd(workspaceRoot);
		if (!prd) {
			log('ERROR: Could not parse prd.json');
			break;
		}

		if (prd.userStories.length === 0) {
			log('ERROR: No user stories found in prd.json');
			break;
		}

		log(`Loaded ${prd.userStories.length} user stories from prd.json`);

		const nextStory = findNextPendingStory(prd, workspaceRoot);

		if (!nextStory) {
			log('🎉 All user stories completed!');
			vscode.window.showInformationMessage('RALPH: All user stories completed!');
			break;
		}

		log('');
		log(`──── Loop ${loopsExecuted + 1}/${config.MAX_AUTONOMOUS_LOOPS} ────`);
		log(`Story ${nextStory.id}: ${nextStory.title}`);
		log(`Description: ${nextStory.description}`);
		log(`Priority: ${nextStory.priority}`);

		// Guard: ensure no other task is inprogress before queuing this one.
		await ensureNoActiveTask(workspaceRoot);

		// ── Persist "inprogress" state to .ralph/task-<id>-status ───────────
		RalphStateManager.setInProgress(workspaceRoot, nextStory.id);
		log(`  Task state written: .ralph/task-${nextStory.id}-status = inprogress`);

		try {
			// executeStory returns only after Copilot has written "completed"
			// to .ralph/task-<id>-status (or after a timeout).
			await executeStory(nextStory, workspaceRoot);

			// Safety net: ensure the lock is always cleared on success
			RalphStateManager.setCompleted(workspaceRoot, nextStory.id);

			// Write completion to progress.txt (prd.json is never modified)
			writeProgressEntry(workspaceRoot, nextStory.id, 'done', 'Completed successfully');

			log(`✅ Story ${nextStory.id} completed.`);
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log(`❌ Story ${nextStory.id} failed: ${errMsg}`);

			// Always release the inprogress lock so the loop can advance
			RalphStateManager.setCompleted(workspaceRoot, nextStory.id);

			// Write failure to progress.txt (prd.json is never modified)
			writeProgressEntry(workspaceRoot, nextStory.id, 'failed', errMsg);
		}

		loopsExecuted++;

		// Small delay to let VS Code settle
		await sleep(config.LOOP_DELAY_MS);
	}

	if (loopsExecuted >= config.MAX_AUTONOMOUS_LOOPS && isRunning) {
		log(`Reached MAX_AUTONOMOUS_LOOPS (${config.MAX_AUTONOMOUS_LOOPS}). Pausing. Run 'RALPH: Start' to continue.`);
		vscode.window.showInformationMessage(
			`RALPH paused after ${config.MAX_AUTONOMOUS_LOOPS} steps. Run 'RALPH: Start' to resume.`
		);
	}

	isRunning = false;
	cancelToken = null;
	updateStatusBar('idle');
}

function stopRalph(): void {
	if (!isRunning) {
		vscode.window.showInformationMessage('RALPH is not running.');
		return;
	}
	cancelToken?.cancel();
	isRunning = false;
	log('RALPH Runner stopped by user.');
	vscode.window.showInformationMessage('RALPH stopped.');
	updateStatusBar('idle');
}

// ── Story Execution ─────────────────────────────────────────────────────────

async function executeStory(story: UserStory, workspaceRoot: string): Promise<void> {
	const prompt = buildCopilotPromptForStory(story, workspaceRoot);
	log('  Delegating user story to Copilot...');
	await sendToCopilot(prompt, story.id, workspaceRoot);
}

// ── Copilot Integration ─────────────────────────────────────────────────────

function buildCopilotPromptForStory(story: UserStory, workspaceRoot: string): string {
	const lines = [
		`You are executing User Story ${story.id} of the current PRD.`,
		`Title: ${story.title}`,
		`Description: ${story.description}`,
		`Priority: ${story.priority}`,
		`Workspace root: ${workspaceRoot}`,
		'',
		'Acceptance Criteria:',
		...story.acceptanceCriteria.map((ac, i) => `  ${i + 1}. ${ac}`),
		'',
		'Execute the following task:',
		'',
		story.description,
		'',
		'Greedily execute as many sub-tasks as possible in a single pass.',
		'If something partially fails, keep all the parts that passed and do not revert them.',
		'Do not ask questions — execute directly.',
		'Make the actual code changes to the files in the workspace.',
		'After completing all changes, confirm what was done.',
		'',
		'⚠️ IMPORTANT: Do NOT modify prd.json. Never edit, overwrite, or update prd.json for any reason.',
		'Progress is tracked separately — your only responsibility is to execute the task and write the completion signal below.',
		'',
		'━━━ TASK COMPLETION SIGNAL (REQUIRED) ━━━',
		`When you have fully completed ALL work for this task, write the exact text \`completed\``,
		`(nothing else, no newline) to the file: ${path.join(workspaceRoot, RALPH_DIR, `task-${story.id}-status`).replace(/\\/g, '/')}`,
		'This is how RALPH knows the task is done and can move to the next step.',
		'Do NOT skip this step — without it RALPH will time out waiting.',
	];

	return lines.join('\n');
}

async function sendToCopilot(prompt: string, taskId: string, workspaceRoot: string): Promise<void> {
	log('  Sending prompt to Copilot Chat...');

	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', {
			query: prompt,
			isPartialQuery: false
		});
	} catch {
		// Fallback: try older command API
		try {
			await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
			await sleep(1000);
			await vscode.commands.executeCommand('workbench.action.chat.open', prompt);
		} catch {
			log('  WARNING: Could not programmatically send to Copilot. Copying to clipboard.');
			await vscode.env.clipboard.writeText(prompt);
			await vscode.commands.executeCommand('workbench.action.chat.open');
			log('  Prompt copied to clipboard. Paste into Copilot Chat.');
		}
	}

	// Poll the .ralph status file until Copilot writes "completed" to it
	await waitForCopilotCompletion(taskId, workspaceRoot);
}

/**
 * Polls .ralph/task-<id>-status until Copilot writes "completed" to it.
 * Enforces a minimum wait (copilotMinWaitMs) before checking so that Copilot
 * has time to begin working before the first read.
 * Throws if the timeout is exceeded without seeing "completed".
 */
async function waitForCopilotCompletion(taskId: string, workspaceRoot: string): Promise<void> {
	const config = getConfig();
	log(`  Waiting for Copilot to write "completed" to .ralph/task-${taskId}-status...`);

	const startTime = Date.now();

	while (Date.now() - startTime < config.COPILOT_TIMEOUT_MS) {
		if (cancelToken?.token.isCancellationRequested) {
			throw new Error('Cancelled by user');
		}

		await sleep(config.COPILOT_RESPONSE_POLL_MS);
		const elapsed = Date.now() - startTime;

		// Enforce a minimum wait before the first status check
		if (elapsed < config.COPILOT_MIN_WAIT_MS) {
			log(`  … minimum wait in progress (${Math.round(elapsed / 1000)}s / ${Math.round(config.COPILOT_MIN_WAIT_MS / 1000)}s)`);
			continue;
		}

		const status = RalphStateManager.getTaskStatus(workspaceRoot, taskId);
		if (status === 'completed') {
			log(`  ✓ Copilot wrote "completed" to .ralph/task-${taskId}-status (elapsed ${Math.round(elapsed / 1000)}s)`);
			return;
		}

		log(`  … still waiting for Copilot to complete task ${taskId} (status: ${status}, elapsed ${Math.round(elapsed / 1000)}s)`);
	}

	log(`  ⚠ Copilot timed out after ${Math.round(config.COPILOT_TIMEOUT_MS / 1000)}s without writing "completed" — proceeding.`);
	throw new Error(`Copilot timed out on task ${taskId}`);
}

/**
 * Block until no .ralph/task-*-status file contains "inprogress".
 * Under normal sequential operation this resolves immediately.
 * Polls every COPILOT_RESPONSE_POLL_MS and times out after COPILOT_TIMEOUT_MS.
 */
async function ensureNoActiveTask(workspaceRoot: string): Promise<void> {
	const config = getConfig();

	if (!RalphStateManager.isAnyInProgress(workspaceRoot)) {
		return; // Fast path — no active task
	}

	const activeId = RalphStateManager.getInProgressTaskId(workspaceRoot);
	log(`  ⏳ Task ${activeId} is still inprogress on disk — waiting for it to complete...`);

	const waitStart = Date.now();

	while (Date.now() - waitStart < config.COPILOT_TIMEOUT_MS) {
		if (cancelToken?.token.isCancellationRequested) {
			throw new Error('Cancelled by user');
		}

		await sleep(config.COPILOT_RESPONSE_POLL_MS);

		if (!RalphStateManager.isAnyInProgress(workspaceRoot)) {
			const waited = Math.round((Date.now() - waitStart) / 1000);
			log(`  ✓ No active task on disk — proceeding (waited ${waited}s)`);
			return;
		}

		const stillActive = RalphStateManager.getInProgressTaskId(workspaceRoot);
		log(`  … still waiting for task ${stillActive} to clear inprogress state`);
	}

	// Timed out — clear the lock to prevent a permanent deadlock
	const timedOutId = RalphStateManager.getInProgressTaskId(workspaceRoot);
	if (timedOutId !== null) {
		log(`  WARNING: Timed out waiting for task ${timedOutId} — clearing stale lock and proceeding.`);
		RalphStateManager.clearStalledTask(workspaceRoot, timedOutId);
	}
}

// ── Status & Reset Commands ─────────────────────────────────────────────────

async function showStatus(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) { return; }

	const prd = parsePrd(workspaceRoot);
	if (!prd) {
		vscode.window.showErrorMessage('prd.json not found or invalid.');
		return;
	}

	const progress = readProgress(workspaceRoot);
	const doneIds = new Set(progress.filter(e => e.status === 'done').map(e => e.id));
	const failedIds = new Set(progress.filter(e => e.status === 'failed').map(e => e.id));

	const total = prd.userStories.length;
	const completed = prd.userStories.filter(s => doneIds.has(s.id)).length;
	const failed = prd.userStories.filter(s => failedIds.has(s.id)).length;
	const pending = total - completed;
	const inProgress = RalphStateManager.getInProgressTaskId(workspaceRoot);
	const nextPending = findNextPendingStory(prd, workspaceRoot);

	const lines = [
		`RALPH Status — ${prd.project}`,
		``,
		`✅ Completed: ${completed}/${total}`,
		`❌ Failed: ${failed}`,
		`⏳ Pending: ${pending}`,
		`🔄 In Progress: ${inProgress || 'None'}`,
		`📍 Next: ${nextPending ? `${nextPending.id} — ${nextPending.title}` : 'All done!'}`,
		``,
		`Running: ${isRunning ? 'Yes' : 'No'}`
	];

	outputChannel.show(true);
	log(lines.join('\n'));
	vscode.window.showInformationMessage(
		`RALPH: ${completed}/${total} stories done. ` +
		`Next: ${nextPending ? nextPending.id : 'Complete!'}`
	);
}

async function resetStory(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) { return; }

	const prd = parsePrd(workspaceRoot);
	if (!prd) {
		vscode.window.showErrorMessage('prd.json not found or invalid.');
		return;
	}

	const progress = readProgress(workspaceRoot);
	const trackedIds = new Set(progress.map(e => e.id));
	const trackedStories = prd.userStories.filter(s => trackedIds.has(s.id));

	if (trackedStories.length === 0) {
		vscode.window.showInformationMessage('No completed or failed stories to reset.');
		return;
	}

	const items = trackedStories.map(s => {
		const entry = progress.find(e => e.id === s.id);
		return {
			label: `${s.id} — ${s.title}`,
			description: entry ? `[${entry.status}] ${entry.notes}` : '',
			storyId: s.id
		};
	});

	const selection = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a user story to reset'
	});

	if (selection) {
		removeProgressEntry(workspaceRoot, selection.storyId);
		// Also clear the .ralph status file if present
		RalphStateManager.clearStalledTask(workspaceRoot, selection.storyId);
		vscode.window.showInformationMessage(`Story ${selection.storyId} reset.`);
		log(`Story ${selection.storyId} reset by user.`);
	}
}

// ── Utilities ───────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) { return undefined; }
	// Use the first workspace folder
	return folders[0].uri.fsPath;
}

function log(message: string): void {
	const timestamp = new Date().toISOString().slice(11, 19);
	outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function updateStatusBar(state: 'idle' | 'running'): void {
	if (!statusBarItem) { return; }
	if (state === 'running') {
		statusBarItem.text = '$(sync~spin) RALPH';
		statusBarItem.tooltip = 'RALPH Runner — task in progress (click for menu)';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	} else {
		statusBarItem.text = '$(rocket) RALPH';
		statusBarItem.tooltip = 'RALPH Runner — click to show commands';
		statusBarItem.backgroundColor = undefined;
	}
}

async function showCommandMenu(): Promise<void> {
	const items: vscode.QuickPickItem[] = [
		{ label: '$(zap)  Generate PRD', description: 'Generate prd.json via Copilot' },
		{ label: '$(play)  Start', description: 'Begin or resume the autonomous task loop' },
		{ label: '$(debug-stop)  Stop', description: 'Cancel the current run' },
		{ label: '$(info)  Show Status', description: 'Display user story progress summary' },
		{ label: '$(debug-restart)  Reset Story', description: 'Reset a completed user story' },
		{ label: '$(gear)  Open Settings', description: 'Configure RALPH Runner options' },
	];

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'RALPH Runner — select a command',
	});

	if (!selected) { return; }

	const commandMap: Record<string, string> = {
		'$(zap)  Generate PRD': 'ralph-runner.quickStart',
		'$(play)  Start': 'ralph-runner.start',
		'$(debug-stop)  Stop': 'ralph-runner.stop',
		'$(info)  Show Status': 'ralph-runner.status',
		'$(debug-restart)  Reset Story': 'ralph-runner.resetStep',
		'$(gear)  Open Settings': 'ralph-runner.openSettings',
	};

	const cmd = commandMap[selected.label];
	if (cmd) {
		vscode.commands.executeCommand(cmd);
	}
}

// ── Quick Start ─────────────────────────────────────────────────────────────
// Guides the user through setting up prd.json.
// 1. Checks if prd.json already exists in the workspace root.
// 2. If missing, asks the user to provide a path to an existing file.
// 3. If the user doesn't have one, asks what they want to accomplish and
//    uses Copilot to generate prd.json in the expected format.

async function quickStart(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}

	outputChannel.show(true);
	log('═══════════════════════════════════════════════════');
	log('RALPH Generate PRD');
	log('═══════════════════════════════════════════════════');

	const prdPath = getPrdPath(workspaceRoot);
	const prdExists = fs.existsSync(prdPath);

	// ── Case 1: File already exists ─────────────────────────────────────────
	if (prdExists) {
		log('prd.json already exists.');
		const action = await vscode.window.showInformationMessage(
			'RALPH: prd.json already exists in the workspace root.',
			'Start', 'Open PRD'
		);
		if (action === 'Start') {
			vscode.commands.executeCommand('ralph-runner.start');
		} else if (action === 'Open PRD') {
			const doc = await vscode.workspace.openTextDocument(prdPath);
			vscode.window.showTextDocument(doc);
		}
		return;
	}

	// ── Case 2: File missing — ask user how to proceed ──────────────────────
	log('prd.json not found — prompting user.');

	const choice = await vscode.window.showQuickPick(
		[
			{
				label: '$(file-directory) I have this file — let me provide the path',
				description: 'Browse for an existing prd.json file',
				value: 'provide'
			},
			{
				label: '$(sparkle) I don\'t have it — generate via Copilot',
				description: 'Describe your goal and let Copilot create prd.json',
				value: 'generate'
			}
		],
		{ placeHolder: 'prd.json not found in workspace root. How would you like to proceed?' }
	);

	if (!choice) { return; }

	if (choice.value === 'provide') {
		await quickStartProvideFile(prdPath);
	} else {
		await quickStartGenerate(workspaceRoot);
	}
}

/**
 * Let the user browse for an existing prd.json file
 * and copy it into the workspace root.
 */
async function quickStartProvideFile(prdPath: string): Promise<void> {
	const uris = await vscode.window.showOpenDialog({
		title: 'Select your prd.json file',
		canSelectMany: false,
		canSelectFolders: false,
		filters: { 'JSON': ['json'], 'All Files': ['*'] },
		openLabel: 'Select prd.json'
	});

	if (!uris || uris.length === 0) {
		vscode.window.showWarningMessage('RALPH: Cancelled — no prd.json selected.');
		return;
	}

	const srcPath = uris[0].fsPath;
	fs.copyFileSync(srcPath, prdPath);
	log(`Copied prd.json from ${srcPath}`);
	vscode.window.showInformationMessage('RALPH: prd.json is ready! You can now run "RALPH: Start".');
	log('Generate PRD complete — file placed in workspace root.');
}

/**
 * Ask the user what they want to accomplish, then send a Copilot prompt that
 * generates prd.json in the expected format used by the RALPH Runner extension.
 */
async function quickStartGenerate(workspaceRoot: string): Promise<void> {
	const userGoal = await vscode.window.showInputBox({
		title: 'RALPH Generate PRD — Describe your goal',
		prompt: 'What are you trying to accomplish? (e.g. "Fix all TypeScript errors", "Add unit tests for all services", "Migrate from jQuery to React")',
		placeHolder: 'Describe what you want to accomplish…',
		ignoreFocusOut: true
	});

	if (!userGoal || userGoal.trim().length === 0) {
		vscode.window.showWarningMessage('RALPH: Cancelled — no goal provided.');
		return;
	}

	log(`User goal: ${userGoal}`);
	log('Sending generation prompt to Copilot…');

	const prompt = buildQuickStartPrompt(userGoal, workspaceRoot);

	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', {
			query: prompt,
			isPartialQuery: false
		});
	} catch {
		try {
			await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
			await sleep(1000);
			await vscode.commands.executeCommand('workbench.action.chat.open', prompt);
		} catch {
			log('WARNING: Could not programmatically send to Copilot. Copying to clipboard.');
			await vscode.env.clipboard.writeText(prompt);
			await vscode.commands.executeCommand('workbench.action.chat.open');
			vscode.window.showInformationMessage('RALPH: Prompt copied to clipboard — paste it into Copilot Chat.');
		}
	}

	vscode.window.showInformationMessage(
		'RALPH: Copilot is generating your prd.json. Once it appears in the workspace root, run "RALPH: Start".'
	);
	log('Generate PRD prompt sent to Copilot. Waiting for file generation…');
}

/**
 * Builds the Copilot prompt that instructs it to generate prd.json
 * in the exact format the RALPH Runner expects.
 */
function buildQuickStartPrompt(userGoal: string, workspaceRoot: string): string {
	return [
		'Go through entire codebase and understand the code.',
		`The user wants to accomplish the following goal: ${userGoal}`,
		``,
		`Workspace root: ${workspaceRoot}`,
		``,
		`Please analyze the workspace and generate one file in the workspace root called prd.json following the syntax below.`,
		``,
		'```json',
		'{',
		'  "project": "<ProjectName>",',
		'  "branchName": "ralph/<branchName>",',
		'  "description": "<Short Description of user request>",',
		'  "userStories": [',
		'    {',
		'      "id": "US-001",',
		'      "title": "Setup Project Structure and Enums",',
		'      "description": "Setup Project Structure and Enums",',
		'      "acceptanceCriteria": ["Setup Project Structure and Enums"],',
		'      "priority": 1',
		'    }',
		'  ]',
		'}',
		'```',
		``,
		`INSTRUCTIONS:`,
		`- If the user forgot to provide a goal, ask him again to provide one. A goal is mandatory. If the provided goal is generic/placeholder/not clear enough. Ask again.`,
		`- The json should have a logical sequence of user stories organized into phases.`,
		`- Each user story should be granular enough to be independently executable and verifiable.`,
		`- Number user stories sequentially starting from "US-001".`,
		`- Do NOT include "passes" or "notes" fields in the user stories. Progress is tracked separately.`,
		`- After EVERY user story, insert a git commit user story. This story should stage all changes and commit them with a meaningful message describing what was done in the preceding user story. For example: { "id": "US-002", "title": "Git Commit: Setup Project Structure", "description": "Stage all changes and commit to git with message: 'feat: setup project structure and enums'", "acceptanceCriteria": ["All changes are staged", "Changes are committed with a descriptive message"], "priority": 2 }.`,
		`- The git commit stories must use conventional commit message format (feat:, fix:, refactor:, docs:, chore:, etc.).`,
		``,
		`IMPORTANT:`,
		`- DO NOT use any absolute, user-specific, or local system-specific paths, directories, namespaces, or usernames in any command or file path.`,
		`- All file paths and commands must be relative and portable, so the plan works for any user on any system.`,
		`- Avoid referencing any local folders outside the workspace root.`,
		`- Do not use commands that reference your own username, home directory, or machine-specific details.`,
		`- The plan must be fully shareable and portable.`,
		``,
		`IMPORTANT:`,
		`- Create the file at the workspace root: ${workspaceRoot}`,
		`- Be thorough: include all necessary user stories for the user's goal`,
		`- Actually create the file — do not just show its content`,
	].join('\n');
}
