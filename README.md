# JIRA → Git worktree → Herdr → Codex → VS Code/Peacock

A tiny dependency-free Node CLI for the workflow:

```text
task XING-12345
  → read JIRA title + description
  → git fetch origin master
  → branch from latest origin/master
  → Git worktree + independent Herdr workspace
  → Herdr tabs: codex + terminal
  → start Codex and send JIRA context
  → assign a persistent curated task color
  → show the same color as a Herdr sidebar stripe
  → generate a .code-workspace with peacock.color
  → open VS Code automatically
```

## Development

The project has no package dependencies. Run its syntax check and isolated CLI
integration tests with:

```bash
npm run check
```

The tests replace Git, JIRA, Herdr, Codex, and VS Code with temporary command
stubs. They do not create real branches, worktrees, workspaces, or JIRA changes.

## 1. Prerequisites

Required commands:

- `git`
- `node`
- `herdr`
- `codex`
- `code` (VS Code shell command)
- `acli` (Atlassian CLI)
- Peacock installed in VS Code

Install ACLI on macOS:

```bash
brew tap atlassian/homebrew-acli
brew install acli
acli jira auth login --web
acli jira auth status
```

The CLI checks JIRA authentication before fetching Git refs or creating a
worktree. If OAuth has expired, task creation stops and asks you to run the
login command again. A Codex/ChatGPT Atlassian connector login is separate
from the local `acli` login.

If `code` is not on PATH, in VS Code run **Shell Command: Install 'code' command in PATH** from the Command Palette.

## 2. Install the task command

Pick a directory already on your PATH. For example:

```bash
mkdir -p ~/.local/bin
cp task.mjs ~/.local/bin/task
chmod +x ~/.local/bin/task
```

If needed, add this to `~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then:

```bash
task doctor
```

> If you already have another executable named `task` (for example go-task), rename this script to `worktask` and replace `$HOME/.local/bin/task code` in the Herdr snippet accordingly.

## 3. Configure Herdr

Merge `herdr-config-snippet.toml` into:

```text
~/.config/herdr/config.toml
```

Then reload:

```bash
herdr server reload-config
```

The snippet deliberately clears Herdr's built-in `prefix+o`
`open_notification_target` binding before assigning that chord to the task
workflow. Run `herdr config check` before reloading.

The sidebar gets a narrow colored `▌` identity marker. The same palette/hex value is written to the VS Code workspace for Peacock.

Herdr workspace metadata is runtime state, so the CLI re-applies the marker on
task creation, `task open`, and `task code` whenever the registered Herdr
workspace is live.

## 4. Use it

From the repository that should own the task:

```bash
cd ~/code/my-repo
task XING-12345
```

The branch will look like:

```text
XING-12345-jira-ticket-summary
```

and is always created from the freshly fetched `origin/master`.

Later:

```bash
task open XING-12345
task list
```

To register an existing local branch:

```bash
task XING-12345 --branch existing-branch-name
```

If that branch is already checked out in a Git worktree, the CLI adopts it.
Otherwise, Git creates a worktree for the existing branch. This mode never
fetches, resets, rebases, or recreates the branch; the `origin/master` base
applies only when the CLI creates a new branch. The command refuses branches
or worktrees already registered to another task.

The CLI deliberately uses `git worktree add` followed by `herdr workspace
create`. Herdr's `worktree create/open` commands group linked worktree
workspaces under the repository's primary workspace; ordinary workspace
creation keeps every task as an independent top-level Herdr workspace.

Inside the task worktree or from the active Herdr workspace:

```bash
task code
```

In Herdr, the custom shortcut is:

```text
Ctrl+B, O
```

(default Herdr prefix + `o`). This opens/focuses the matching VS Code `.code-workspace`.
The binding passes Herdr's explicit active workspace ID, so it does not depend
on the detached command's working directory.

## State

The persistent registry and generated VS Code workspaces live under:

```text
~/.local/share/task-workflow/
  tasks.json
  worktrees/
  vscode/
    XING-12345.code-workspace
```

Set `TASK_WORKFLOW_HOME` if you want these elsewhere.

## Current v1 behavior / intentional limitations

- The command must be started from inside the source Git repository when creating a new task.
- Base is hard-coded to `origin/master` as requested.
- `--branch` accepts an existing local branch and preserves its current history.
- A registered task keeps its assigned color.
- New tasks prefer palette colors not currently used by registered worktrees
  that still exist.
- JIRA descriptions are passed to the initial Codex prompt but are not retained
  in `tasks.json`; a missing Herdr workspace causes the description to be
  fetched again.
- If Herdr's server/session loses the workspace but the Git worktree still exists, `task open XING-12345` reopens it and bootstraps fresh `codex` and `terminal` tabs.
- Cleanup (`task done`) is intentionally not included yet; it's safer to add after the create/open flow has been used for a few real tasks.
