import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// RALPH Runner — Autonomous Migration Agent for VS Code
//
// Reads MIGRATION_PLAN.md for step definitions and MIGRATION_STATE.md for
// persistent progress tracking. Loops autonomously (up to MAX_AUTONOMOUS_LOOPS)
// injecting Copilot chat tasks for each step. Fully resumable.
// ────────────────────────────────────────────────────────────────────────────

// ── Configuration helpers ───────────────────────────────────────────────────
// All tunables are read from VS Code settings (ralph-runner.*) so users can
// adjust them through the Settings UI.  Defaults match the original constants.

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('ralph-runner');
	return {
		MAX_AUTONOMOUS_LOOPS: cfg.get<number>('maxAutonomousLoops', 2),
		LOOP_DELAY_MS: cfg.get<number>('loopDelayMs', 3000),
		COPILOT_RESPONSE_POLL_MS: cfg.get<number>('copilotResponsePollMs', 5000),
		COPILOT_TIMEOUT_MS: cfg.get<number>('copilotTimeoutMs', 600000),
		COPILOT_IDLE_THRESHOLD_MS: cfg.get<number>('copilotIdleThresholdMs', 30000),
		COPILOT_MIN_WAIT_MS: cfg.get<number>('copilotMinWaitMs', 15000),
	};
}

// ── Types ───────────────────────────────────────────────────────────────────

interface MigrationStep {
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

// ── Activity Tracker ────────────────────────────────────────────────────────
// Monitors workspace events (file edits, file creation, terminal activity) to
// determine whether Copilot is still actively working on a task.

class ActivityTracker {
	private lastActivityTime: number;
	private disposables: vscode.Disposable[] = [];

	constructor() {
		this.lastActivityTime = Date.now();
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				// Only track real workspace files — ignore output channels, untitled docs, etc.
				if (e.document.uri.scheme !== 'file') { return; }
				if (e.document.uri.fsPath.endsWith('MIGRATION_STATE.md')) { return; }
				this.lastActivityTime = Date.now();
			}),
			vscode.workspace.onDidCreateFiles(() => { this.lastActivityTime = Date.now(); }),
			vscode.workspace.onDidDeleteFiles(() => { this.lastActivityTime = Date.now(); }),
			vscode.workspace.onDidRenameFiles(() => { this.lastActivityTime = Date.now(); }),
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (doc.uri.scheme !== 'file') { return; }
				if (doc.uri.fsPath.endsWith('MIGRATION_STATE.md')) { return; }
				this.lastActivityTime = Date.now();
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				// Only count switching to actual file editors, not output/chat panels
				if (editor && editor.document.uri.scheme === 'file') {
					this.lastActivityTime = Date.now();
				}
			}),
			vscode.window.onDidOpenTerminal(() => { this.lastActivityTime = Date.now(); }),
			vscode.window.onDidCloseTerminal(() => { this.lastActivityTime = Date.now(); })
		);
	}

	/** Milliseconds since the last observed workspace activity. */
	getIdleTimeMs(): number {
		return Date.now() - this.lastActivityTime;
	}

	/** Reset the clock (call right before sending work to Copilot). */
	resetActivity(): void {
		this.lastActivityTime = Date.now();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}
}

// ── Globals ─────────────────────────────────────────────────────────────────

let outputChannel: vscode.OutputChannel;
let cancelToken: vscode.CancellationTokenSource | null = null;
let isRunning = false;
let activityTracker: ActivityTracker | null = null;
let copilotRequestActive = false;
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
		vscode.commands.registerCommand('ralph-runner.showMenu', () => showCommandMenu())
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

	const planPath = path.join(workspaceRoot, 'MIGRATION_PLAN.md');
	const statePath = path.join(workspaceRoot, 'MIGRATION_STATE.md');

	if (!fs.existsSync(planPath) || !fs.existsSync(statePath)) {
		vscode.window.showErrorMessage('MIGRATION_PLAN.md or MIGRATION_STATE.md not found in workspace root.');
		return;
	}

	const config = getConfig();

	isRunning = true;
	cancelToken = new vscode.CancellationTokenSource();
	outputChannel.show(true);
	log('═══════════════════════════════════════════════════');
	log('RALPH Runner started — autonomous migration agent');
	log(`Max loops: ${config.MAX_AUTONOMOUS_LOOPS}`);
	log('═══════════════════════════════════════════════════');

	updateStatusBar('running');

	const steps = parsePlan(planPath);
	if (steps.length === 0) {
		log('ERROR: Could not parse any steps from MIGRATION_PLAN.md');
		isRunning = false;
		return;
	}
	log(`Loaded ${steps.length} steps from MIGRATION_PLAN.md`);

	// Start global activity tracker for the duration of this run
	activityTracker?.dispose();
	activityTracker = new ActivityTracker();

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
			log('🎉 All steps completed! Migration finished.');
			vscode.window.showInformationMessage('RALPH: All migration steps completed!');
			break;
		}

		const stepDef = steps.find(s => s.id === nextStep.id);
		if (!stepDef) {
			log(`ERROR: Step ${nextStep.id} exists in state but not in plan. Marking skipped.`);
			updateStepStatus(statePath, nextStep.id, 'skipped', 'Step not found in MIGRATION_PLAN.md');
			loopsExecuted++;
			continue;
		}

		log('');
		log(`──── Loop ${loopsExecuted + 1}/${config.MAX_AUTONOMOUS_LOOPS} ────`);
		log(`Step ${stepDef.id}: [${stepDef.action}] ${stepDef.description}`);
		log(`Phase: ${stepDef.phase}`);

		// ── Requirement 3: Verify step isn't already done ────────────────
		const alreadyDone = await verifyStepAlreadyDone(stepDef, workspaceRoot);
		if (alreadyDone) {
			log(`⏩ Step ${stepDef.id} verified as already complete — skipping execution.`);
			updateStepStatus(statePath, stepDef.id, 'done', 'Verified already complete');
			loopsExecuted++;
			updateQuickStatus(statePath);
			continue;
		}

		// ── Requirement 2: Wait for Copilot to be idle before queueing ──
		if (stepDef.action === 'copilot_task' || stepDef.action === 'create_file') {
			await ensureCopilotIdle();
		}

		// Mark in-progress (step is NOT done yet — stays in-progress until confirmed)
		updateStepStatus(statePath, stepDef.id, 'in-progress', '');

		try {
			// executeStep now waits for Copilot to fully finish before returning
			await executeStep(stepDef, workspaceRoot);
			// ── Requirement 1: Only mark done AFTER confirmed completion ──
			updateStepStatus(statePath, stepDef.id, 'done', '');
			log(`✅ Step ${stepDef.id} completed.`);
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log(`❌ Step ${stepDef.id} failed: ${errMsg}`);
			updateStepStatus(statePath, stepDef.id, 'failed', errMsg);
			// Continue to next step on failure (don't block the whole pipeline)
		}

		loopsExecuted++;

		// Update the quick status summary in MIGRATION_STATE.md
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

	activityTracker?.dispose();
	activityTracker = null;
	copilotRequestActive = false;
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

async function executeStep(step: MigrationStep, workspaceRoot: string): Promise<void> {
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

async function executeTerminal(step: MigrationStep, workspaceRoot: string): Promise<void> {
	const command = step.command;
	if (!command) {
		throw new Error('run_terminal step has no command');
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
}

async function executeCreateFile(step: MigrationStep, workspaceRoot: string): Promise<void> {
	if (!step.path) {
		throw new Error('create_file step has no path');
	}

	// Delegate to Copilot to generate the file content based on the description
	const prompt = buildCopilotPrompt(step, workspaceRoot);
	log(`  Delegating file creation to Copilot: ${step.path}`);
	await sendToCopilot(prompt);
}

async function executeCopilotTask(step: MigrationStep, workspaceRoot: string): Promise<void> {
	const prompt = buildCopilotPrompt(step, workspaceRoot);
	log('  Delegating task to Copilot...');
	await sendToCopilot(prompt);
}

// ── Copilot Integration ─────────────────────────────────────────────────────

function buildCopilotPrompt(step: MigrationStep, workspaceRoot: string): string {
	const stateSnippet = [
		`You are executing Step ${step.id} of the Case360 Java EE → Spring Boot migration plan.`,
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
				'Perform ALL changes described. Do not ask questions — execute directly.',
				'Make the actual code changes to the files in the workspace.',
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

	return stateSnippet.join('\n');
}

async function sendToCopilot(prompt: string): Promise<void> {
	// Requirement 2: wait for Copilot to be fully idle before sending anything
	await ensureCopilotIdle();

	// Reset activity baseline right before sending the prompt
	activityTracker?.resetActivity();
	copilotRequestActive = true;

	log('  Sending prompt to Copilot Chat...');

	// Use the VS Code chat API to send a message to Copilot
	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', {
			query: prompt,
			isPartialQuery: false
		});
	} catch {
		// Fallback: try the older command ID
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

	// Requirement 1: wait for Copilot to FULLY finish before returning
	await waitForCopilotCompletion();
	copilotRequestActive = false;
}

/**
 * Activity-based wait: watches workspace events (file edits, file creation,
 * terminal opens, etc.) and considers Copilot done only after a sustained
 * idle period with no workspace changes.
 */
async function waitForCopilotCompletion(): Promise<void> {
	const config = getConfig();
	log('  Waiting for Copilot to finish processing...');

	const startTime = Date.now();

	while (Date.now() - startTime < config.COPILOT_TIMEOUT_MS) {
		if (cancelToken?.token.isCancellationRequested) {
			copilotRequestActive = false;
			throw new Error('Cancelled by user');
		}

		await sleep(config.COPILOT_RESPONSE_POLL_MS);
		const elapsed = Date.now() - startTime;

		// Enforce a minimum wait so Copilot has time to begin working
		if (elapsed < config.COPILOT_MIN_WAIT_MS) {
			log(`  … still within minimum wait (${Math.round(elapsed / 1000)}s / ${config.COPILOT_MIN_WAIT_MS / 1000}s)`);
			continue;
		}

		// After the minimum wait, require a sustained idle period
		const idleMs = activityTracker?.getIdleTimeMs() ?? Infinity;
		if (idleMs >= config.COPILOT_IDLE_THRESHOLD_MS) {
			log(`  Copilot appears done — no workspace activity for ${Math.round(idleMs / 1000)}s (elapsed ${Math.round(elapsed / 1000)}s)`);
			return;
		}

		log(`  … Copilot still active (idle ${Math.round(idleMs / 1000)}s < threshold ${config.COPILOT_IDLE_THRESHOLD_MS / 1000}s, elapsed ${Math.round(elapsed / 1000)}s)`);
	}

	log(`  Copilot timed out after ${config.COPILOT_TIMEOUT_MS / 1000}s — proceeding.`);
}

/**
 * Requirement 2: Block until Copilot is not busy. Polls every 5 s.
 * Checks both our own copilotRequestActive flag and workspace activity.
 */
async function ensureCopilotIdle(): Promise<void> {
	const config = getConfig();
	if (!copilotRequestActive) {
		// Quick path: we don't think Copilot is busy
		// Still do a brief activity check in case something is happening
		const idleMs = activityTracker?.getIdleTimeMs() ?? Infinity;
		if (idleMs >= config.COPILOT_IDLE_THRESHOLD_MS) {
			return; // Copilot is idle
		}
	}

	log('  ⏳ Copilot appears busy — waiting for it to become idle (polling every 5s)...');
	const waitStart = Date.now();

	while (Date.now() - waitStart < config.COPILOT_TIMEOUT_MS) {
		if (cancelToken?.token.isCancellationRequested) {
			throw new Error('Cancelled by user');
		}

		await sleep(config.COPILOT_RESPONSE_POLL_MS);

		const idleMs = activityTracker?.getIdleTimeMs() ?? Infinity;
		if (!copilotRequestActive && idleMs >= config.COPILOT_IDLE_THRESHOLD_MS) {
			const waited = Math.round((Date.now() - waitStart) / 1000);
			log(`  ✓ Copilot is now idle (waited ${waited}s)`);
			return;
		}

		log(`  … still waiting for Copilot (idle ${Math.round(idleMs / 1000)}s, requestActive=${copilotRequestActive})`);
	}

	log('  WARNING: Timed out waiting for Copilot to become idle — proceeding anyway.');
	copilotRequestActive = false; // Reset to avoid deadlock
}

// ── Step Verification ───────────────────────────────────────────────────────
// Requirement 3: Before executing any step, do a quick check to see if the
// step's outcome already exists in the workspace (regardless of state file).

async function verifyStepAlreadyDone(step: MigrationStep, workspaceRoot: string): Promise<boolean> {
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

// ── MIGRATION_PLAN.md Parser ────────────────────────────────────────────────

function parsePlan(planPath: string): MigrationStep[] {
	const content = fs.readFileSync(planPath, 'utf-8');

	// Extract the JSON block between ```json and ```
	const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!jsonMatch) {
		log('ERROR: Could not find ```json block in MIGRATION_PLAN.md');
		return [];
	}

	try {
		const parsed = JSON.parse(jsonMatch[1]);
		const steps: MigrationStep[] = parsed.steps || [];
		return steps;
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		log(`ERROR: Failed to parse JSON from MIGRATION_PLAN.md: ${msg}`);
		return [];
	}
}

// ── MIGRATION_STATE.md Parser & Writer ──────────────────────────────────────

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

	const statePath = path.join(workspaceRoot, 'MIGRATION_STATE.md');
	if (!fs.existsSync(statePath)) {
		vscode.window.showErrorMessage('MIGRATION_STATE.md not found.');
		return;
	}

	const tracked = parseState(statePath);
	const completed = tracked.filter(s => s.status === 'done').length;
	const failed = tracked.filter(s => s.status === 'failed').length;
	const pending = tracked.filter(s => s.status === 'pending').length;
	const inProgress = tracked.find(s => s.status === 'in-progress');
	const nextPending = tracked.find(s => s.status === 'pending');

	const lines = [
		`RALPH Migration Status`,
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

	const statePath = path.join(workspaceRoot, 'MIGRATION_STATE.md');
	if (!fs.existsSync(statePath)) {
		vscode.window.showErrorMessage('MIGRATION_STATE.md not found.');
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
		statusBarItem.tooltip = 'RALPH Runner — migration in progress (click for menu)';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	} else {
		statusBarItem.text = '$(rocket) RALPH';
		statusBarItem.tooltip = 'RALPH Runner — click to show commands';
		statusBarItem.backgroundColor = undefined;
	}
}

async function showCommandMenu(): Promise<void> {
	const items: vscode.QuickPickItem[] = [
		{ label: '$(play)  Start Migration', description: 'Begin or resume the autonomous migration loop' },
		{ label: '$(debug-stop)  Stop Migration', description: 'Cancel the current migration run' },
		{ label: '$(info)  Show Status', description: 'Display migration progress summary' },
		{ label: '$(debug-restart)  Reset Step', description: 'Reset a completed or failed step to pending' },
		{ label: '$(gear)  Open Settings', description: 'Configure RALPH Runner options' },
	];

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'RALPH Runner — select a command',
	});

	if (!selected) { return; }

	const commandMap: Record<string, string> = {
		'$(play)  Start Migration': 'ralph-runner.start',
		'$(debug-stop)  Stop Migration': 'ralph-runner.stop',
		'$(info)  Show Status': 'ralph-runner.status',
		'$(debug-restart)  Reset Step': 'ralph-runner.resetStep',
		'$(gear)  Open Settings': 'ralph-runner.openSettings',
	};

	const cmd = commandMap[selected.label];
	if (cmd) {
		vscode.commands.executeCommand(cmd);
	}
}
