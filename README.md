# RALPH Runner

**Autonomous migration agent for VS Code** — reads a migration plan, tracks progress in a state file, and drives Copilot Chat to execute each step in an automated loop.

RALPH (Run Autonomous Loops Per Handoff) is a VS Code extension that orchestrates multi-step code migrations by combining a declarative plan with Copilot-powered execution. It reads step definitions from `MIGRATION_PLAN.md`, maintains persistent progress in `MIGRATION_STATE.md`, and loops autonomously — sending tasks to Copilot Chat, running terminal commands, and creating files — until the migration is complete or the configured loop limit is reached.

## Features

- **Autonomous looping** — Executes up to 2 migration steps per run (configurable), then pauses so you can review before continuing.
- **Three action types:**
  - `copilot_task` — Sends a detailed prompt to Copilot Chat and waits for it to finish making changes.
  - `run_terminal` — Opens a terminal, runs a shell command, and waits for completion.
  - `create_file` — Delegates file creation to Copilot with contextual instructions.
- **Activity-based completion detection** — Monitors workspace events (file edits, file creation, terminal activity) to determine when Copilot has finished processing a step.
- **Persistent state tracking** — All progress is written to `MIGRATION_STATE.md` so you can stop, restart VS Code, or resume at any time.
- **Smart skip detection** — Before executing a step, RALPH checks whether the outcome already exists (e.g., file already created, directory already exists, `node_modules` already installed) and skips it automatically.
- **Fully resumable** — If a step is left `in-progress`, RALPH picks it up on the next start. Failed steps are logged and skipped so the pipeline continues.

## Requirements

- **VS Code** 1.109.0 or later
- **GitHub Copilot Chat** extension installed and signed in — RALPH delegates code tasks to Copilot via the chat API.
- Two markdown files in your workspace root:
  - **`MIGRATION_PLAN.md`** — Contains a fenced ` ```json ` block with a `{ "steps": [...] }` array defining each migration step.
  - **`MIGRATION_STATE.md`** — A markdown table tracking the status of each step (`pending`, `in-progress`, `done`, `failed`, `skipped`) along with timestamps and notes. Also includes a quick-status summary section that RALPH updates automatically.

### MIGRATION_PLAN.md format

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
      "phase": "Migration",
      "action": "copilot_task",
      "instruction": "Convert all EJB session beans to Spring @Service classes...",
      "description": "Migrate EJB services to Spring"
    }
  ]
}
```

| Field         | Required | Description                                                  |
| ------------- | -------- | ------------------------------------------------------------ |
| `id`          | Yes      | Unique numeric step identifier                               |
| `phase`       | Yes      | Logical grouping label (e.g., "Setup", "Migration")          |
| `action`      | Yes      | One of `run_terminal`, `create_file`, or `copilot_task`      |
| `description` | Yes      | Human-readable summary of what the step does                 |
| `command`     | If `run_terminal` | Shell command to execute                            |
| `path`        | If `create_file`  | Workspace-relative path of the file to create       |
| `instruction` | If `copilot_task` | Detailed instructions for Copilot to follow         |

### MIGRATION_STATE.md format

The state file should contain a markdown table with columns for step ID, phase, action/description, status, timestamp, and notes. RALPH parses rows matching this pattern:

```
| 1 | Setup | `run_terminal` — Create directories | `pending` |  |  |
```

It also looks for a quick-status summary section with lines like `| Total Steps | 10 |` and `**Current Phase:** Step 1` to keep an at-a-glance overview updated.

## Usage

1. Create `MIGRATION_PLAN.md` and `MIGRATION_STATE.md` in your workspace root (see formats above).
2. Open the Command Palette (`Ctrl+Shift+P`) and run one of the RALPH commands.
3. RALPH will begin processing pending steps, logging progress to the **RALPH Runner** output channel.
4. After the configured number of steps (default: 2), RALPH pauses — review the changes, then run **RALPH: Start Migration** again to continue.

## Commands

| Command                    | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `RALPH: Start Migration`   | Begin (or resume) the autonomous migration loop from the next pending step. |
| `RALPH: Stop Migration`    | Cancel the current run immediately.                                         |
| `RALPH: Show Status`       | Display a summary of step progress in the output channel and as a notification. |
| `RALPH: Reset Step`        | Pick a completed, failed, or in-progress step and reset it back to `pending`. |

## How it works

1. **Parse** — RALPH reads the JSON step definitions from `MIGRATION_PLAN.md` and the current state from `MIGRATION_STATE.md`.
2. **Find next step** — It looks for the first `in-progress` step (to resume) or the first `pending` step.
3. **Verify** — Before executing, it checks whether the step's outcome already exists in the workspace (smart skip).
4. **Execute** — Depending on the action type, RALPH either runs a terminal command, or sends a prompt to Copilot Chat and waits.
5. **Wait for completion** — For Copilot tasks, RALPH monitors workspace activity (file edits, saves, terminal events). Once no activity is detected for 30 seconds (after a minimum 15-second wait), it considers the step complete.
6. **Update state** — The step is marked `done` or `failed` in `MIGRATION_STATE.md`, and the quick-status summary is refreshed.
7. **Loop** — Repeat from step 2 until the loop limit is reached or all steps are done.

## Known Issues

- Copilot completion detection is heuristic-based (workspace activity monitoring). In rare cases, RALPH may consider Copilot done prematurely if there is a long pause between file edits, or it may wait unnecessarily if unrelated workspace activity occurs.
- Terminal command completion relies on timeouts rather than exit-code detection, so long-running commands may be marked complete before they finish.

## Release Notes

### 0.0.1

- Initial release with autonomous loop, Copilot Chat integration, activity-based completion detection, persistent state tracking, and smart skip verification.
