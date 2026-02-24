# RALPH Runner

**Autonomous task runner for VS Code** — reads user stories from a PRD, tracks progress persistently, and drives Copilot Chat to execute each story in an automated loop.

RALPH (Run Autonomous Loops Per Handoff) is a VS Code extension that orchestrates multi-step coding tasks by delegating user stories to GitHub Copilot Chat. It reads story definitions from `prd.json`, maintains persistent progress in `progress.txt`, and uses file-based execution locks in a `.ralph/` directory — looping autonomously until all stories are complete or the configured loop limit is reached.

Use it for migrations, bug fixes, feature implementation, refactoring, test creation, or any multi-step workflow you can describe as user stories.

## Features

- **Autonomous looping** — Executes user stories in automated loops, prioritized by the `priority` field. Configurable loop limits via VS Code settings.
- **Copilot-powered execution** — Each user story is sent to Copilot Chat as a detailed prompt including title, description, acceptance criteria, and context. Copilot makes the code changes directly in your workspace.
- **File-based completion signaling** — Copilot writes `completed` to `.ralph/task-<id>-status` when it finishes a story. RALPH polls this file to detect completion, with configurable polling interval, minimum wait time, and timeout.
- **Persistent progress tracking** — Completion status is recorded in `progress.txt` (format: `<storyId> | <status> | <timestamp> | <notes>`). Stop, restart VS Code, or resume at any time.
- **Crash-safe execution locks** — The `.ralph/` directory stores per-task status files (`inprogress` / `completed`) that prevent overlapping tasks and survive process crashes. Stalled tasks are detected and recoverable on restart.
- **Fully resumable** — On startup, detects stalled in-progress tasks from a previous session and offers to clear and retry. Failed stories are logged and skipped so the pipeline continues.
- **Generate PRD workflow** — Use the built-in Generate PRD command to create `prd.json`. Either import an existing file or describe your goal and let Copilot generate user stories automatically. Generated PRDs automatically include a git commit story after every user story, using conventional commit message format.
- **Enhanced status bar integration** — Visual state indicators (🚀 idle / 🔄 running) with one-click access to the command menu.
- **Automatic .gitignore management** — The `.ralph/` directory is automatically added to `.gitignore` to keep task state out of version control.

## Requirements

- **VS Code** 1.109.0 or later
- **GitHub Copilot Chat** extension installed and signed in — RALPH delegates all code tasks to Copilot via the chat command API.
- A JSON file in your workspace root:
    - **`prd.json`** — Contains the project definition and user stories (see format below).

### prd.json format

The PRD file defines your project and an array of user stories. Each story is delegated to Copilot as an independent task.

```json
{
  "project": "MyProject",
  "branchName": "ralph/feature-branch",
  "description": "Short description of the project goal",
  "userStories": [
    {
      "id": "US-001",
      "title": "Setup Project Structure",
      "description": "Create the initial project directory structure and configuration files",
      "acceptanceCriteria": [
        "Project directories exist",
        "Configuration files are created"
      ],
      "priority": 1
    },
    {
      "id": "US-002",
      "title": "Implement User Authentication",
      "description": "Add login and registration endpoints with JWT token support",
      "acceptanceCriteria": [
        "Login endpoint returns a JWT token",
        "Registration endpoint creates a new user",
        "Invalid credentials return 401"
      ],
      "priority": 2
    }
  ]
}
```

| Field                | Required | Description                                                        |
| -------------------- | -------- | ------------------------------------------------------------------ |
| `project`            | Yes      | Project name                                                       |
| `branchName`         | Yes      | Suggested Git branch name                                          |
| `description`        | Yes      | Short description of the overall goal                              |
| `userStories`        | Yes      | Array of user story objects                                        |
| `userStories[].id`   | Yes      | Unique string identifier (e.g., `"US-001"`)                       |
| `userStories[].title`| Yes      | Short title for the story                                          |
| `userStories[].description` | Yes | Detailed description of what to accomplish                  |
| `userStories[].acceptanceCriteria` | Yes | Array of strings defining acceptance criteria        |
| `userStories[].priority` | Yes  | Numeric priority (lower number = higher priority, executed first)  |

### progress.txt format

RALPH automatically creates and maintains `progress.txt` to track which stories have been completed or failed. Each line follows this format:

```
US-001 | done | 2026-02-24 12:00:00 | Completed successfully
US-002 | failed | 2026-02-24 12:05:00 | Copilot timed out on task US-002
```

### .ralph/ directory

RALPH creates a `.ralph/` directory in your workspace root to store execution state:

- `task-<id>-status` — Contains `inprogress` while a story is being executed, or `completed` once Copilot finishes. This file-based lock prevents overlapping tasks and enables crash recovery.

This directory is automatically added to `.gitignore`.

## Usage

1. **Setup**: Create `prd.json` in your workspace root (see format above), or use **RALPH: Generate PRD** from the status bar menu to generate it via Copilot.
2. **Run RALPH**: Open Command Palette (`Ctrl+Shift+P`) → type "RALPH: Start", or click the RALPH status bar icon → "Start".
3. **Monitor progress**: RALPH logs all activity to the **RALPH Runner** output channel and updates the status bar icon (🚀 idle → 🔄 running).
4. **Continue execution**: After the configured number of stories, RALPH pauses — review changes, then run "RALPH: Start" again to continue with the next batch.

## Commands

### Available Commands

| Command (Command Palette) | Status Bar Menu Label          | Description                                                                                                               |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `RALPH: Start`            | $(play) Start                  | **Begin or resume** the autonomous loop from the next pending story. Processes up to the configured number of stories.    |
| `RALPH: Stop`             | $(debug-stop) Stop             | **Cancel immediately** — stops the current execution.                                                                     |
| `RALPH: Show Status`      | $(info) Show Status            | **View progress summary** — displays story counts and next pending story in both output channel and notification.         |
| `RALPH: Reset Story`      | $(debug-restart) Reset Story   | **Reset story status** — choose any completed or failed story to reset for re-execution.                                  |
| `RALPH: Generate PRD`     | $(zap) Generate PRD            | **Setup wizard** — import an existing `prd.json` or describe your goal and let Copilot generate one.                      |
| `RALPH: Open Settings`    | $(gear) Open Settings          | **Configure behavior** — opens VS Code settings for RALPH Runner.                                                        |

### Access Methods

- **Command Palette**: `Ctrl+Shift+P` then type "RALPH" to see all commands
- **Status Bar**: Click the RALPH icon (🚀 when idle, 🔄 when running) for the quick menu

### Configurable Settings

Access via `RALPH: Open Settings` or VS Code Settings → Extensions → RALPH Runner:

| Setting                  | Default   | Description                                                          |
| ------------------------ | --------- | -------------------------------------------------------------------- |
| `maxAutonomousLoops`     | 2         | Maximum stories to execute per run before pausing                    |
| `loopDelayMs`            | 3000      | Settle time between stories (milliseconds)                           |
| `copilotResponsePollMs`  | 5000      | How often to poll the task status file (milliseconds)                |
| `copilotTimeoutMs`       | 3600000   | Maximum time to wait for Copilot per story (default: 1 hour)        |
| `copilotMinWaitMs`       | 15000     | Minimum wait before first status check, giving Copilot time to start |

## How it works

1. **Parse** — RALPH reads user stories from `prd.json` and completion records from `progress.txt`.
2. **Find next story** — Selects the highest-priority story (lowest `priority` number) that hasn't been marked `done` in `progress.txt`.
3. **Guard** — Ensures no other task is currently in-progress by checking `.ralph/task-*-status` files. Waits or clears stale locks if needed.
4. **Lock** — Writes `inprogress` to `.ralph/task-<id>-status` to claim the execution slot.
5. **Execute** — Builds a detailed prompt from the story's title, description, and acceptance criteria, then sends it to Copilot Chat. The prompt instructs Copilot to make code changes and write `completed` to the task status file when done.
6. **Poll for completion** — RALPH polls `.ralph/task-<id>-status` at the configured interval (`copilotResponsePollMs`). A minimum wait (`copilotMinWaitMs`) is enforced before the first check. If Copilot doesn't complete within the timeout (`copilotTimeoutMs`), the story is marked as failed.
7. **Record result** — The story outcome (`done` or `failed`) is appended to `progress.txt` with a timestamp and notes.
8. **Loop** — Repeat from step 2 until the loop limit is reached or all stories are complete.

## Known Issues

- **Copilot completion detection** relies on Copilot writing `completed` to the `.ralph/task-<id>-status` file. If Copilot does not write this signal (e.g., due to an error or unexpected behavior), the story will time out and be marked as failed.
- **Copilot prompt delivery** tries multiple VS Code command APIs to open chat. If programmatic delivery fails, the prompt is copied to the clipboard for manual pasting.
- **Single workspace folder** — RALPH uses the first workspace folder. Multi-root workspaces are not explicitly supported.

## Release Notes

### 0.0.3

- Current release with autonomous loop, Copilot Chat integration, file-based completion signaling, persistent progress tracking, crash-safe execution locks, Generate PRD workflow, and status bar integration.
