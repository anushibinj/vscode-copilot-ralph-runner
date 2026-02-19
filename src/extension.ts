import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// RALPH Runner — Autonomous Task Runner for VS Code
//
// Reads PLAN.md for step definitions and STATUS.md for persistent progress
// tracking. Loops autonomously (up to MAX_AUTONOMOUS_LOOPS) injecting
// Copilot chat tasks for each step. Fully resumable.
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

interface PlanStep {
	id: number;
	phase: string;
	action: string; // "run_terminal" | "create_file" | "copilot_task"
	command?: string;
	path?: string;
	instruction?: string;
	description: string;
}

type StepStatus = 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped';

interface TrackedStep {
	id: number;
	status: StepStatus;
	timestamp: string;
	notes: string;
}

// ── Filesystem Task State Manager ────────────────────────────────────────────
// Manages .ralph/task-<id>-status files to provide a durable, process-safe
// execution lock.  File content is either "inprogress" or "completed".

const RALPH_DIR = '.ralph';

class RalphStateManager {

	/** Absolute path to the .ralph directory for the workspace. */
	static getRalphDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, RALPH_DIR);
	}

	/** Absolute path to the status file for a given task id. */
	static getTaskStatusPath(workspaceRoot: string, taskId: number): string {
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
	static setInProgress(workspaceRoot: string, taskId: number): void {
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
	static setCompleted(workspaceRoot: string, taskId: number): void {
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
	static getTaskStatus(workspaceRoot: string, taskId: number): 'inprogress' | 'completed' | 'none' {
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
	static getInProgressTaskId(workspaceRoot: string): number | null {
		const dir = RalphStateManager.getRalphDir(workspaceRoot);
		if (!fs.existsSync(dir)) { return null; }

		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return null;
		}

		for (const entry of entries) {
			const match = entry.match(/^task-(\d+)-status$/);
			if (!match) { continue; }
			const taskId = parseInt(match[1], 10);
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
	static clearStalledTask(workspaceRoot: string, taskId: number): void {
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
		const entry = '.ralph/';

		try {
			let content = '';
			if (fs.existsSync(gitignorePath)) {
				content = fs.readFileSync(gitignorePath, 'utf-8');
			}

			// Check for any variant: .ralph/ .ralph .ralph/* etc.
			const alreadyIgnored = /^\s*\.ralph[/\\]?\s*$/m.test(content);
			if (alreadyIgnored) { return; }

			// Append with a leading newline if the file doesn't already end with one
			const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
			fs.writeFileSync(gitignorePath, `${content}${separator}\n# RALPH Runner task state\n${entry}\n`, 'utf-8');
			log(`  Added ${entry} to workspace .gitignore`);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`  WARNING: Could not update .gitignore: ${msg}`);
		}
	}
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
		vscode.commands.registerCommand('ralph-runner.resetStep', () => resetStep()),
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

	const planPath = path.join(workspaceRoot, 'PLAN.md');
	const statePath = path.join(workspaceRoot, 'STATUS.md');

	if (!fs.existsSync(planPath) || !fs.existsSync(statePath)) {
		vscode.window.showErrorMessage('PLAN.md or STATUS.md not found in workspace root.');
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

	const steps = parsePlan(planPath);
	if (steps.length === 0) {
		log('ERROR: Could not parse any steps from PLAN.md');
		isRunning = false;
		return;
	}
	log(`Loaded ${steps.length} steps from PLAN.md`);

	let loopsExecuted = 0;

	while (loopsExecuted < config.MAX_AUTONOMOUS_LOOPS && isRunning) {
		if (cancelToken?.token.isCancellationRequested) {
			log('Cancelled by user.');
			break;
		}

		// Re-read state each iteration (it may have been modified externally)
		const trackedSteps = parseState(statePath);
		const nextStep = findNextPending(trackedSteps);

		if (!nextStep) {
			log('🎉 All steps completed!');
			vscode.window.showInformationMessage('RALPH: All steps completed!');
			break;
		}

		const stepDef = steps.find(s => s.id === nextStep.id);
		if (!stepDef) {
			log(`ERROR: Step ${nextStep.id} exists in state but not in plan. Marking skipped.`);
			updateStepStatus(statePath, nextStep.id, 'skipped', 'Step not found in PLAN.md');
			loopsExecuted++;
			continue;
		}

		log('');
		log(`──── Loop ${loopsExecuted + 1}/${config.MAX_AUTONOMOUS_LOOPS} ────`);
		log(`Step ${stepDef.id}: [${stepDef.action}] ${stepDef.description}`);
		log(`Phase: ${stepDef.phase}`);

		// Verify step isn't already done (idempotency guard)
		const alreadyDone = await verifyStepAlreadyDone(stepDef, workspaceRoot);
		if (alreadyDone) {
			log(`⏩ Step ${stepDef.id} verified as already complete — skipping execution.`);
			updateStepStatus(statePath, stepDef.id, 'done', 'Verified already complete');
			loopsExecuted++;
			updateQuickStatus(statePath);
			continue;
		}

		// Guard: ensure no other task is inprogress before queuing this one.
		// Under normal sequential operation this resolves immediately; it only
		// blocks if a stale file somehow slipped through startup recovery.
		await ensureNoActiveTask(workspaceRoot);

		// ── Persist "inprogress" state to .ralph/task-<id>-status ───────────
		RalphStateManager.setInProgress(workspaceRoot, stepDef.id);
		updateStepStatus(statePath, stepDef.id, 'in-progress', '');
		log(`  Task state written: .ralph/task-${stepDef.id}-status = inprogress`);

		try {
			// executeStep returns only after Copilot has written "completed"
			// to .ralph/task-<id>-status (or after a terminal step finishes).
			await executeStep(stepDef, workspaceRoot);

			// Safety net: ensure the lock is always cleared on success,
			// even if Copilot neglected to write the file (idempotent for all types).
			RalphStateManager.setCompleted(workspaceRoot, stepDef.id);
			updateStepStatus(statePath, stepDef.id, 'done', '');
			log(`✅ Step ${stepDef.id} completed.`);
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log(`❌ Step ${stepDef.id} failed: ${errMsg}`);
			// Always release the inprogress lock so the loop can advance
			RalphStateManager.setCompleted(workspaceRoot, stepDef.id);
			updateStepStatus(statePath, stepDef.id, 'failed', errMsg);
		}

		loopsExecuted++;

		// Update the quick status summary in STATUS.md
		updateQuickStatus(statePath);

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

// ── Step Execution ──────────────────────────────────────────────────────────

async function executeStep(step: PlanStep, workspaceRoot: string): Promise<void> {
	switch (step.action) {
		case 'run_terminal':
			await executeTerminal(step, workspaceRoot);
			break;
		case 'create_file':
			await executeCreateFile(step, workspaceRoot);
			break;
		case 'copilot_task':
			await executeCopilotTask(step, workspaceRoot);
			break;
		default:
			throw new Error(`Unknown action type: ${step.action}`);
	}
}

async function executeTerminal(step: PlanStep, workspaceRoot: string): Promise<void> {
	let command = step.command;
	if (!command) {
		throw new Error('run_terminal step has no command');
	}

	// Detect the default shell and adjust command chaining for PowerShell
	const shell = vscode.workspace.getConfiguration('terminal').get<string>('integrated.defaultProfile.windows');
	if (shell && shell.toLowerCase().includes('powershell')) {
		// Replace '&&' with ';' for PowerShell compatibility
		command = command.replace(/&&/g, ';');
	}

	log(`  Running: ${command}`);

	return new Promise<void>((resolve, reject) => {
		const terminal = vscode.window.createTerminal({
			name: `RALPH Step ${step.id}`,
			cwd: workspaceRoot
		});
		terminal.show(false);
		terminal.sendText(command);
		// We use a marker to detect completion
		const marker = `__RALPH_DONE_${step.id}_${Date.now()}__`;
		terminal.sendText(`echo ${marker}`);

		// Wait for the terminal to finish (poll-based since VS Code API doesn't
		// offer a direct "command finished" event for sendText)
		const timeout = setTimeout(() => {
			terminal.dispose();
			resolve(); // Best-effort: assume it completed
		}, 60_000); // 60s timeout for terminal commands

		const closeListener = vscode.window.onDidCloseTerminal(t => {
			if (t === terminal) {
				clearTimeout(timeout);
				closeListener.dispose();
				resolve();
			}
		});

		// Auto-close after a reasonable wait for non-interactive commands
		setTimeout(() => {
			clearTimeout(timeout);
			closeListener.dispose();
			terminal.dispose();
			resolve();
		}, 15_000);
	});

	// Terminal steps are fully controlled by RALPH — write completed now.
	RalphStateManager.setCompleted(workspaceRoot, step.id);
	log(`  Task state written: .ralph/task-${step.id}-status = completed`);
}

async function executeCreateFile(step: PlanStep, workspaceRoot: string): Promise<void> {
	if (!step.path) {
		throw new Error('create_file step has no path');
	}

	// Delegate to Copilot to generate the file content based on the description
	const prompt = buildCopilotPrompt(step, workspaceRoot);
	log(`  Delegating file creation to Copilot: ${step.path}`);
	await sendToCopilot(prompt, step.id, workspaceRoot);
}

async function executeCopilotTask(step: PlanStep, workspaceRoot: string): Promise<void> {
	const prompt = buildCopilotPrompt(step, workspaceRoot);
	log('  Delegating task to Copilot...');
	await sendToCopilot(prompt, step.id, workspaceRoot);
}

// ── Copilot Integration ─────────────────────────────────────────────────────

function buildCopilotPrompt(step: PlanStep, workspaceRoot: string): string {
	const stateSnippet = [
		`You are executing Step ${step.id} of the current plan.`,
		`Phase: ${step.phase}`,
		`Action: ${step.action}`,
		`Description: ${step.description}`,
		`Workspace root: ${workspaceRoot}`,
		''
	];

	switch (step.action) {
		case 'create_file':
			stateSnippet.push(
				`Create the file at: ${step.path}`,
				`File purpose: ${step.description}`,
				'',
				'Generate the COMPLETE file content and create it. Do not ask questions — infer best practices.',
				'After creating the file, confirm it was created.'
			);
			break;

		case 'copilot_task':
			stateSnippet.push(
				'Execute the following task:',
				'',
				step.instruction || step.description,
				'',
				'Greedily execute as many sub-tasks as possible in a single pass.',
				'If something partially fails, keep all the parts that passed and do not revert them.',
				'Do not ask questions — execute directly.',
				'Make the actual code changes to the files in the workspace.',
				'Mark the task as in-progress in STATUS.md and exit when done.',
				'After completing all changes, confirm what was done.'
			);
			break;

		case 'run_terminal':
			stateSnippet.push(
				`Run the following command in the terminal:`,
				`\`\`\``,
				step.command || '',
				`\`\`\``,
				'',
				'Execute the command and report the result.'
			);
			break;
	}

	// ── Completion signal ───────────────────────────────────────────────────
	// RALPH polls this file to know when Copilot has finished the task.
	// Copilot MUST write this file as the very last action of its response.
	stateSnippet.push(
		'',
		'━━━ TASK COMPLETION SIGNAL (REQUIRED) ━━━',
		`When you have fully completed ALL work for this task, write the exact text \`completed\``,
		`(nothing else, no newline) to the file: ${path.join(workspaceRoot, RALPH_DIR, `task-${step.id}-status`).replace(/\\/g, '/')}`,
		'This is how RALPH knows the task is done and can move to the next step.',
		'Do NOT skip this step — without it RALPH will time out waiting.',
	);

	return stateSnippet.join('\n');
}

async function sendToCopilot(prompt: string, taskId: number, workspaceRoot: string): Promise<void> {
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
async function waitForCopilotCompletion(taskId: number, workspaceRoot: string): Promise<void> {
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
 * It only waits if a stale lock file was not cleared during startup recovery
 * (e.g. the directory was manually created or a concurrent process wrote it).
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

// ── Step Verification ───────────────────────────────────────────────────────
// Requirement 3: Before executing any step, do a quick check to see if the
// step's outcome already exists in the workspace (regardless of state file).

async function verifyStepAlreadyDone(step: PlanStep, workspaceRoot: string): Promise<boolean> {
	switch (step.action) {
		case 'create_file': {
			if (!step.path) { return false; }
			const fullPath = path.join(workspaceRoot, step.path);
			if (fs.existsSync(fullPath)) {
				try {
					const stat = fs.statSync(fullPath);
					if (stat.size > 0) {
						log(`  ✓ Verified: File already exists: ${step.path} (${stat.size} bytes)`);
						return true;
					}
				} catch { /* file vanished between exists and stat — not done */ }
			}
			return false;
		}

		case 'run_terminal': {
			if (!step.command) { return false; }
			// mkdir: check if directory already exists
			const mkdirMatch = step.command.match(/mkdir\s+(?:-p\s+)?["']?([^"'\s]+)["']?/);
			if (mkdirMatch) {
				const dir = path.isAbsolute(mkdirMatch[1])
					? mkdirMatch[1]
					: path.join(workspaceRoot, mkdirMatch[1]);
				if (fs.existsSync(dir)) {
					log(`  ✓ Verified: Directory already exists: ${mkdirMatch[1]}`);
					return true;
				}
			}
			// npm install: check for node_modules and package-lock.json
			if (/npm\s+(install|i|ci)\b/.test(step.command)) {
				const lockFile = path.join(workspaceRoot, 'package-lock.json');
				const nodeModules = path.join(workspaceRoot, 'node_modules');
				if (fs.existsSync(lockFile) && fs.existsSync(nodeModules)) {
					log('  ✓ Verified: node_modules and package-lock.json already exist');
					return true;
				}
			}
			// git init: check for .git directory
			if (/git\s+init\b/.test(step.command)) {
				if (fs.existsSync(path.join(workspaceRoot, '.git'))) {
					log('  ✓ Verified: .git directory already exists');
					return true;
				}
			}
			return false;
		}

		case 'copilot_task': {
			// Copilot tasks are general-purpose — we cannot reliably verify their
			// outcome without understanding the task detail. Return false so the
			// step is always re-evaluated.
			return false;
		}

		default:
			return false;
	}
}

// ── PLAN.md Parser ──────────────────────────────────────────────────────────

function parsePlan(planPath: string): PlanStep[] {
	const content = fs.readFileSync(planPath, 'utf-8');

	// Extract the JSON block between ```json and ```
	const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!jsonMatch) {
		log('ERROR: Could not find ```json block in PLAN.md');
		return [];
	}

	try {
		const parsed = JSON.parse(jsonMatch[1]);
		const steps: PlanStep[] = parsed.steps || [];
		return steps;
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		log(`ERROR: Failed to parse JSON from PLAN.md: ${msg}`);
		return [];
	}
}

// ── STATUS.md Parser & Writer ────────────────────────────────────────────────

function parseState(statePath: string): TrackedStep[] {
	const content = fs.readFileSync(statePath, 'utf-8');
	const steps: TrackedStep[] = [];

	// Match table rows: | 1 | Phase ... | `action` — desc | `status` | timestamp | notes |
	const rowRegex = /^\|\s*(\d+)\s*\|[^|]*\|[^|]*\|\s*`(\w[\w-]*)`\s*\|([^|]*)\|([^|]*)\|$/gm;
	let match: RegExpExecArray | null;

	while ((match = rowRegex.exec(content)) !== null) {
		steps.push({
			id: parseInt(match[1], 10),
			status: match[2].trim() as StepStatus,
			timestamp: match[3].trim(),
			notes: match[4].trim()
		});
	}

	return steps;
}

function findNextPending(tracked: TrackedStep[]): TrackedStep | null {
	// Sort by step ID so we always scan from Step 1 upward
	const sorted = [...tracked].sort((a, b) => a.id - b.id);

	// Walk through every step in order and return the first one that
	// is NOT done and NOT skipped. This catches earlier steps that were
	// missed even if later steps are already complete.
	return sorted.find(s => s.status !== 'done' && s.status !== 'skipped') || null;
}

function updateStepStatus(statePath: string, stepId: number, status: StepStatus, notes: string): void {
	let content = fs.readFileSync(statePath, 'utf-8');
	const timestamp = status === 'done' || status === 'failed'
		? new Date().toISOString().replace('T', ' ').slice(0, 19)
		: '';

	// Match the specific row for this step ID
	// Pattern: | <id> | <phase> | <action> | `<old_status>` | <old_timestamp> | <old_notes> |
	const rowRegex = new RegExp(
		`^(\\|\\s*${stepId}\\s*\\|[^|]*\\|[^|]*\\|)\\s*\`\\w[\\w-]*\`\\s*\\|([^|]*)\\|([^|]*)\\|$`,
		'm'
	);

	const replacement = `$1 \`${status}\` | ${timestamp} | ${notes} |`;
	content = content.replace(rowRegex, replacement);
	fs.writeFileSync(statePath, content, 'utf-8');
}

function updateQuickStatus(statePath: string): void {
	const tracked = parseState(statePath);
	const total = tracked.length;
	const completed = tracked.filter(s => s.status === 'done').length;
	const inProgress = tracked.filter(s => s.status === 'in-progress').length;
	const failed = tracked.filter(s => s.status === 'failed').length;
	const pending = tracked.filter(s => s.status === 'pending').length;
	const skipped = tracked.filter(s => s.status === 'skipped').length;

	let content = fs.readFileSync(statePath, 'utf-8');

	// Update the Quick Status counts
	content = content.replace(/\| Total Steps \| \d+ \|/, `| Total Steps | ${total} |`);
	content = content.replace(/\| Completed \| \d+ \|/, `| Completed | ${completed} |`);
	content = content.replace(/\| In Progress \| \d+ \|/, `| In Progress | ${inProgress} |`);
	content = content.replace(/\| Failed \| \d+ \|/, `| Failed | ${failed} |`);
	content = content.replace(/\| Pending \| \d+ \|/, `| Pending | ${pending + skipped} |`);

	// Update current phase
	const lastDone = [...tracked].reverse().find(s => s.status === 'done');
	const currentStep = tracked.find(s => s.status === 'in-progress' || s.status === 'pending');
	const currentPhase = currentStep ? `Step ${currentStep.id}` : 'All Complete';
	const lastCompleted = lastDone ? `Step ${lastDone.id}` : '—';

	content = content.replace(
		/\*\*Current Phase:\*\* .*/,
		`**Current Phase:** ${currentPhase}`
	);
	content = content.replace(
		/\*\*Last Completed Step:\*\* .*/,
		`**Last Completed Step:** ${lastCompleted}`
	);

	fs.writeFileSync(statePath, content, 'utf-8');
	log(`  State updated: ${completed} done, ${failed} failed, ${pending} pending`);
}

// ── Status & Reset Commands ─────────────────────────────────────────────────

async function showStatus(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) { return; }

	const statePath = path.join(workspaceRoot, 'STATUS.md');
	if (!fs.existsSync(statePath)) {
		vscode.window.showErrorMessage('STATUS.md not found.');
		return;
	}

	const tracked = parseState(statePath);
	const completed = tracked.filter(s => s.status === 'done').length;
	const failed = tracked.filter(s => s.status === 'failed').length;
	const pending = tracked.filter(s => s.status === 'pending').length;
	const inProgress = tracked.find(s => s.status === 'in-progress');
	const nextPending = tracked.find(s => s.status === 'pending');

	const lines = [
		`RALPH Status`,
		``,
		`✅ Completed: ${completed}/${tracked.length}`,
		`❌ Failed: ${failed}`,
		`⏳ Pending: ${pending}`,
		`🔄 In Progress: ${inProgress ? `Step ${inProgress.id}` : 'None'}`,
		`📍 Next: ${nextPending ? `Step ${nextPending.id}` : 'All done!'}`,
		``,
		`Running: ${isRunning ? 'Yes' : 'No'}`
	];

	outputChannel.show(true);
	log(lines.join('\n'));
	vscode.window.showInformationMessage(
		`RALPH: ${completed}/${tracked.length} steps done. ${failed} failed. ` +
		`Next: ${nextPending ? `Step ${nextPending.id}` : 'Complete!'}`
	);
}

async function resetStep(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) { return; }

	const statePath = path.join(workspaceRoot, 'STATUS.md');
	if (!fs.existsSync(statePath)) {
		vscode.window.showErrorMessage('STATUS.md not found.');
		return;
	}

	const tracked = parseState(statePath);
	const failedOrDone = tracked.filter(s => s.status === 'failed' || s.status === 'done' || s.status === 'in-progress');
	if (failedOrDone.length === 0) {
		vscode.window.showInformationMessage('No steps to reset.');
		return;
	}

	const items = failedOrDone.map(s => ({
		label: `Step ${s.id}`,
		description: `[${s.status}] ${s.notes || ''}`,
		stepId: s.id
	}));

	const selection = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a step to reset to pending'
	});

	if (selection) {
		updateStepStatus(statePath, selection.stepId, 'pending', '');
		updateQuickStatus(statePath);
		vscode.window.showInformationMessage(`Step ${selection.stepId} reset to pending.`);
		log(`Step ${selection.stepId} reset to pending by user.`);
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
		{ label: '$(zap)  Generate plan', description: 'Initialize plan & status files (or generate them via Copilot)' },
		{ label: '$(play)  Start', description: 'Begin or resume the autonomous task loop' },
		{ label: '$(debug-stop)  Stop', description: 'Cancel the current run' },
		{ label: '$(info)  Show Status', description: 'Display step progress summary' },
		{ label: '$(debug-restart)  Reset Step', description: 'Reset a completed or failed step to pending' },
		{ label: '$(gear)  Open Settings', description: 'Configure RALPH Runner options' },
	];

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'RALPH Runner — select a command',
	});

	if (!selected) { return; }

	const commandMap: Record<string, string> = {
		'$(zap)  Generate plan': 'ralph-runner.quickStart',
		'$(play)  Start': 'ralph-runner.start',
		'$(debug-stop)  Stop': 'ralph-runner.stop',
		'$(info)  Show Status': 'ralph-runner.status',
		'$(debug-restart)  Reset Step': 'ralph-runner.resetStep',
		'$(gear)  Open Settings': 'ralph-runner.openSettings',
	};

	const cmd = commandMap[selected.label];
	if (cmd) {
		vscode.commands.executeCommand(cmd);
	}
}

// ── Quick Start ─────────────────────────────────────────────────────────────
// Guides the user through setting up PLAN.md and STATUS.md.
// 1. Checks if the files already exist in the workspace root.
// 2. If missing, asks the user to provide paths to existing files.
// 3. If the user doesn't have them, asks what they want to accomplish and
//    uses Copilot to generate both files in the expected format.

async function quickStart(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}

	outputChannel.show(true);
	log('═══════════════════════════════════════════════════');
	log('RALPH Generate Plan');
	log('═══════════════════════════════════════════════════');

	const planPath = path.join(workspaceRoot, 'PLAN.md');
	const statePath = path.join(workspaceRoot, 'STATUS.md');

	const planExists = fs.existsSync(planPath);
	const stateExists = fs.existsSync(statePath);

	// ── Case 1: Both files already exist ────────────────────────────────────
	if (planExists && stateExists) {
		log('Both PLAN.md and STATUS.md already exist.');
		const action = await vscode.window.showInformationMessage(
			'RALPH: PLAN.md and STATUS.md already exist in the workspace root.',
			'Start', 'Open Plan', 'Open Status'
		);
		if (action === 'Start') {
			vscode.commands.executeCommand('ralph-runner.start');
		} else if (action === 'Open Plan') {
			const doc = await vscode.workspace.openTextDocument(planPath);
			vscode.window.showTextDocument(doc);
		} else if (action === 'Open Status') {
			const doc = await vscode.workspace.openTextDocument(statePath);
			vscode.window.showTextDocument(doc);
		}
		return;
	}

	// ── Case 2: One or both files missing — ask user how to proceed ─────────
	const missingFiles: string[] = [];
	if (!planExists) { missingFiles.push('PLAN.md'); }
	if (!stateExists) { missingFiles.push('STATUS.md'); }

	log(`Missing: ${missingFiles.join(', ')}`);

	const choice = await vscode.window.showQuickPick(
		[
			{
				label: '$(file-directory) I have these files — let me provide the path',
				description: 'Browse for existing PLAN.md and STATUS.md files',
				value: 'provide'
			},
			{
				label: '$(sparkle) I don\'t have them — generate via Copilot',
				description: 'Describe your goal and let Copilot create both files',
				value: 'generate'
			}
		],
		{ placeHolder: `${missingFiles.join(' and ')} not found in workspace root. How would you like to proceed?` }
	);

	if (!choice) { return; }

	if (choice.value === 'provide') {
		await quickStartProvideFiles(planPath, statePath, planExists, stateExists);
	} else {
		await quickStartGenerate(planPath, statePath, workspaceRoot);
	}
}

/**
 * Let the user browse for existing PLAN.md / STATUS.md files
 * and copy them into the workspace root.
 */
async function quickStartProvideFiles(
	planPath: string, statePath: string,
	planExists: boolean, stateExists: boolean
): Promise<void> {
	if (!planExists) {
		const uris = await vscode.window.showOpenDialog({
			title: 'Select your PLAN.md file',
			canSelectMany: false,
			canSelectFolders: false,
			filters: { 'Markdown': ['md'], 'All Files': ['*'] },
			openLabel: 'Select PLAN.md'
		});
		if (!uris || uris.length === 0) {
			vscode.window.showWarningMessage('RALPH Generate Plan cancelled — no PLAN.md selected.');
			return;
		}
		const srcPath = uris[0].fsPath;
		fs.copyFileSync(srcPath, planPath);
		log(`Copied PLAN.md from ${srcPath}`);
	}

	if (!stateExists) {
		const uris = await vscode.window.showOpenDialog({
			title: 'Select your STATUS.md file',
			canSelectMany: false,
			canSelectFolders: false,
			filters: { 'Markdown': ['md'], 'All Files': ['*'] },
			openLabel: 'Select STATUS.md'
		});
		if (!uris || uris.length === 0) {
			vscode.window.showWarningMessage('RALPH Generate Plan cancelled — no STATUS.md selected.');
			return;
		}
		const srcPath = uris[0].fsPath;
		fs.copyFileSync(srcPath, statePath);
		log(`Copied STATUS.md from ${srcPath}`);
	}

	vscode.window.showInformationMessage('RALPH: Plan and status files are ready! You can now run "RALPH: Start".');
	log('Generate Plan complete — files placed in workspace root.');
}

/**
 * Ask the user what they want to accomplish, then send a Copilot prompt that
 * generates both PLAN.md and STATUS.md in the expected
 * formats used by the RALPH Runner extension.
 */
async function quickStartGenerate(
	planPath: string, statePath: string, workspaceRoot: string
): Promise<void> {
	const userGoal = await vscode.window.showInputBox({
		title: 'RALPH Generate Plan — Describe your goal',
		prompt: 'What are you trying to accomplish? (e.g. "Fix all TypeScript errors", "Add unit tests for all services", "Migrate from jQuery to React")',
		placeHolder: 'Describe what you want to accomplish…',
		ignoreFocusOut: true
	});

	if (!userGoal || userGoal.trim().length === 0) {
		vscode.window.showWarningMessage('RALPH Generate Plan cancelled — no goal provided.');
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
		'RALPH: Copilot is generating your plan files. Once they appear in the workspace root, run "RALPH: Start".'
	);
	log('Generate Plan prompt sent to Copilot. Waiting for file generation…');
}

/**
 * Builds the Copilot prompt that instructs it to generate PLAN.md
 * and STATUS.md in the exact formats the RALPH Runner expects.
 */
function buildQuickStartPrompt(userGoal: string, workspaceRoot: string): string {
	return [
		`The user wants to accomplish the following goal:`,
		``,
		`> ${userGoal}`,
		``,
		`Workspace root: ${workspaceRoot}`,
		``,
		`Please analyze the workspace and generate TWO files in the workspace root:`,
		``,
		`────────────────────────────────────────────────────`,
		`FILE 1: PLAN.md`,
		`────────────────────────────────────────────────────`,
		``,
		`This file must contain a \`\`\`json code block with the following structure:`,
		``,
		'```',
		`{`,
		`  "steps": [`,
		`    {`,
		`      "id": 1,`,
		`      "phase": "Phase name (e.g. Setup, Analysis, Implementation, Testing)",`,
		`      "action": "run_terminal | create_file | copilot_task",`,
		`      "command": "(only for run_terminal) the shell command to run",`,
		`      "path": "(only for create_file) relative path of the file to create",`,
		`      "instruction": "(only for copilot_task) detailed instruction for Copilot",`,
		`      "description": "Human-readable description of what this step does"`,
		`    }`,
		`  ]`,
		`}`,
		'```',
		``,
		`Action types:`,
		`- "run_terminal": executes a shell command (requires "command" field)`,
		`- "create_file": creates a file at the given path (requires "path" field)`,
		`- "copilot_task": a general Copilot coding task (requires "instruction" field)`,
		``,
		`The plan should have a logical sequence of steps organized into phases.`,
		`Each step should be granular enough to be independently executable and verifiable.`,
		`Number steps sequentially starting from 1.`,
		``,
		`IMPORTANT:`,
		`- DO NOT use any absolute, user-specific, or local system-specific paths, directories, namespaces, or usernames in any command or file path.`,
		`- All file paths and commands must be relative and portable, so the plan works for any user on any system.`,
		`- Avoid referencing any local folders outside the workspace root.`,
		`- Do not use commands that reference your own username, home directory, or machine-specific details.`,
		`- The plan must be fully shareable and portable.`,
		``,
		`────────────────────────────────────────────────────`,
		`FILE 2: STATUS.md`,
		`────────────────────────────────────────────────────`,
		``,
		`This file tracks progress. It MUST contain:`,
		``,
		`1. A Quick Status section with this exact table format:`,
		``,
		`| Metric | Count |`,
		`|--------|-------|`,
		`| Total Steps | <N> |`,
		`| Completed | 0 |`,
		`| In Progress | 0 |`,
		`| Failed | 0 |`,
		`| Pending | <N> |`,
		``,
		`**Current Phase:** Step 1`,
		`**Last Completed Step:** —`,
		``,
		`2. A detailed step tracking table with this exact format:`,
		``,
		`| Step | Phase | Action | Status | Timestamp | Notes |`,
		`|------|-------|--------|--------|-----------|-------|`,
		`| 1 | Phase name | \`action\` — description | \`pending\` | | |`,
		``,
		`One row per step matching the plan. All steps should start as \`pending\`.`,
		``,
		`────────────────────────────────────────────────────`,
		``,
		`IMPORTANT:`,
		`- Create BOTH files at the workspace root: ${workspaceRoot}`,
		`- The JSON in PLAN.md must be inside a \`\`\`json fenced code block`,
		`- The state table rows must follow the exact pipe-delimited format shown above`,
		`- Be thorough: include all necessary steps for the user's goal`,
		`- Actually create the files — do not just show their content`,
	].join('\n');
}
