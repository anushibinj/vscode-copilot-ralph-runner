# RALPH Runner

**Autonomous task runner for VS Code** — reads a step-by-step plan, tracks progress in a status file, and drives Copilot Chat to execute each step in an automated loop.

RALPH (Run Autonomous Loops Per Handoff) is a VS Code extension that orchestrates multi-step coding tasks by combining a declarative plan with Copilot-powered execution. It reads step definitions from `PLAN.md`, maintains persistent progress in `STATUS.md`, and loops autonomously — sending tasks to Copilot Chat, running terminal commands, and creating files — until all steps are complete or the configured loop limit is reached.

Use it for migrations, bug fixes, feature implementation, refactoring, test creation, or any multi-step workflow you can describe in a plan.

## Features

- **Autonomous looping** — Executes steps in automated loops with fully configurable parameters through VS Code settings.
- **Comprehensive configuration system** — All behavior parameters are configurable via VS Code settings:
    - Maximum loops per run (default: 2)
    - Loop delays and polling intervals
    - Copilot timeout and idle thresholds
    - Minimum wait times
- **Three action types:**
    - `copilot_task` — Sends detailed prompts to Copilot Chat with intelligent completion detection.
    - `run_terminal` — Opens terminals, executes shell commands with **PowerShell compatibility** (auto-converts `&&` to `;`).
    - `create_file` — Delegates file creation to Copilot with contextual instructions.
- **Advanced Activity Tracker** — Monitors comprehensive workspace events to detect when Copilot is actively working:
    - File edits, creation, deletion, and renames
    - File saves and active editor changes
    - Terminal opens and closes
    - Intelligently excludes status file updates and non-workspace files
- **Intelligent Copilot integration** — Ensures reliable task handoffs:
    - Waits for Copilot to be idle before sending new tasks
    - Activity-based completion detection with configurable thresholds
    - Timeout protection and minimum wait enforcement
- **Persistent status tracking** — All progress is written to `STATUS.md` so you can stop, restart VS Code, or resume at any time.
- **Smart skip detection** — Before executing a step, RALPH verifies whether the outcome already exists and skips automatically.
- **Fully resumable** — Picks up in-progress steps on restart. Failed steps are logged and skipped so pipelines continue.
- **Quick Start workflow** — Generate or import `PLAN.md` and `STATUS.md` using built-in Quick Start with Copilot-powered plan generation.
- **Enhanced status bar integration** — Visual state indicators (idle/running) with one-click access to the command menu.
- **Comprehensive management tools** — View progress, reset steps, and configure settings through command palette or status bar.

## Requirements

- **VS Code** 1.109.0 or later
- **GitHub Copilot Chat** extension installed and signed in — RALPH delegates code tasks to Copilot via the chat API.
- Two markdown files in your workspace root:
    - **`PLAN.md`** — Contains a fenced ` ```json ` block with a `{ "steps": [...] }` array defining each step.
    - **`STATUS.md`** — A markdown table tracking the status of each step (`pending`, `in-progress`, `done`, `failed`, `skipped`) along with timestamps and notes. Also includes a quick-status summary section that RALPH updates automatically.

### PLAN.md format

The plan file must contain a fenced JSON block with a `steps` array. Each step has the following fields:

```json
{
	"steps": [
		{
			"id": 1,
			"phase": "Setup",
			"action": "run_terminal",
			"command": "mkdir -p src/main/java",
			"description": "Create project directory structure"
		},
		{
			"id": 2,
			"phase": "Configuration",
			"action": "create_file",
			"path": "src/main/resources/application.properties",
			"description": "Create Spring Boot application properties"
		},
		{
			"id": 3,
			"phase": "Implementation",
			"action": "copilot_task",
			"instruction": "Add unit tests for all service classes in src/services/...",
			"description": "Create unit tests for services"
		}
	]
}
```

| Field         | Required          | Description                                              |
| ------------- | ----------------- | -------------------------------------------------------- |
| `id`          | Yes               | Unique numeric step identifier                           |
| `phase`       | Yes               | Logical grouping label (e.g., "Setup", "Implementation") |
| `action`      | Yes               | One of `run_terminal`, `create_file`, or `copilot_task`  |
| `description` | Yes               | Human-readable summary of what the step does             |
| `command`     | If `run_terminal` | Shell command to execute                                 |
| `path`        | If `create_file`  | Workspace-relative path of the file to create            |
| `instruction` | If `copilot_task` | Detailed instructions for Copilot to follow              |

### STATUS.md format

The status file should contain a markdown table with columns for step ID, phase, action/description, status, timestamp, and notes. RALPH parses rows matching this pattern:

```
| 1 | Setup | `run_terminal` — Create directories | `pending` |  |  |
```

It also looks for a quick-status summary section with lines like `| Total Steps | 10 |` and `**Current Phase:** Step 1` to keep an at-a-glance overview updated.

## Usage

1. **Setup files**: Create `PLAN.md` and `STATUS.md` in your workspace root (see formats above), or use **RALPH: Quick Start** (appears as "Generate plan" in status bar menu) to set them up automatically.
2. **Run RALPH**: Open Command Palette (`Ctrl+Shift+P`) → type "RALPH: Start", or click the RALPH status bar icon → "Start".
3. **Monitor progress**: RALPH logs all activity to the **RALPH Runner** output channel and updates the status bar icon (🚀 idle → 🔄 running).
4. **Continue execution**: After the configured number of steps, RALPH pauses — review changes, then run "RALPH: Start" again to continue with the next batch of steps.

## Commands

### Available Commands

| Command (Command Palette) | Status Bar Menu Label       | Description                                                                                                                                                   |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALPH: Start`            | $(play) Start               | **Begin or resume** the autonomous loop from the next pending/in-progress step. Processes up to the configured number of steps before pausing.                |
| `RALPH: Stop`             | $(debug-stop) Stop          | **Cancel immediately** — stops the current execution and marks the running step as failed.                                                                    |
| `RALPH: Show Status`      | $(info) Show Status         | **View progress summary** — displays step counts, current phase, and next pending step in both output channel and notification.                               |
| `RALPH: Reset Step`       | $(debug-restart) Reset Step | **Reset step status** — choose any completed, failed, or in-progress step to reset back to `pending` for re-execution.                                        |
| `RALPH: Quick Start`      | $(zap) Generate plan        | **Setup wizard** — guides you through creating `PLAN.md` and `STATUS.md`. Can import existing files or generate new ones via Copilot from a goal description. |
| `RALPH: Open Settings`    | $(gear) Open Settings       | **Configure behavior** — opens VS Code settings for RALPH Runner to adjust timeouts, loop limits, thresholds, and delays.                                     |

### Access Methods

- **Command Palette**: `Ctrl+Shift+P` then type "RALPH" to see all commands
- **Status Bar**: Click the RALPH icon (🚀 when idle, 🔄 when running) for the quick menu
- **Keyboard**: All commands are available through VS Code's command palette and can be assigned keyboard shortcuts

### Configurable Settings

Access via `RALPH: Open Settings` or VS Code Settings → Extensions → RALPH Runner:

| Setting                  | Default | Description                                          |
| ------------------------ | ------- | ---------------------------------------------------- |
| `maxAutonomousLoops`     | 2       | Maximum steps to execute per run before pausing      |
| `loopDelayMs`            | 3000    | Delay between steps (milliseconds)                   |
| `copilotResponsePollMs`  | 5000    | How often to check Copilot status (milliseconds)     |
| `copilotTimeoutMs`       | 600000  | Maximum time to wait for Copilot (10 minutes)        |
| `copilotIdleThresholdMs` | 30000   | Idle time before considering Copilot done (30s)      |
| `copilotMinWaitMs`       | 15000   | Minimum wait time for Copilot to start working (15s) |

## How it works

1. **Parse** — RALPH reads JSON step definitions from `PLAN.md` and current status from `STATUS.md`.
2. **Find next step** — Locates the first `in-progress` step (to resume) or first `pending` step in sequence.
3. **Verify** — Before executing, checks whether the step's outcome already exists in the workspace (smart skip).
4. **Wait for idle state** — For Copilot tasks, ensures Copilot is not busy before sending new work.
5. **Execute** — Depending on action type:
    - `run_terminal`: Creates terminal, runs command (with PowerShell compatibility), waits for completion marker
    - `create_file` or `copilot_task`: Sends contextual prompt to Copilot Chat
6. **Monitor completion** — For Copilot tasks, uses advanced activity tracking:
    - Monitors file edits, saves, creates, deletes, renames
    - Tracks editor changes and terminal activity
    - Enforces minimum wait time (15s) for Copilot to begin
    - Considers task complete after sustained idle period (30s with no workspace activity)
    - Times out after maximum period (10 minutes) if needed
7. **Update status** — Step is marked `done` or `failed` in `STATUS.md`, quick-status summary refreshed.
8. **Loop** — Repeat from step 2 until loop limit reached or all steps complete.

## Known Issues

- **Copilot completion detection** is heuristic-based (workspace activity monitoring). The advanced activity tracker minimizes false positives, but rare edge cases may occur:
    - Premature completion if Copilot pauses longer than the idle threshold (configurable)
    - Delayed completion if unrelated workspace activity occurs during idle detection
- **Terminal command completion** uses completion markers rather than exit-code detection. Commands that don't respond to input may appear to hang.
- **PowerShell compatibility** automatically converts `&&` to `;`, but other shell-specific syntax differences may require manual plan adjustments.

## Release Notes

### 0.0.1

- Initial release with autonomous loop, Copilot Chat integration, activity-based completion detection, persistent status tracking, smart skip verification, Quick Start workflow, and status bar integration.
