# Developer task bootstrap → Git worktree → Herdr → Codex → VS Code/Peacock

A tiny Node CLI plus a small GitHub checks watcher for the workflow:

```text
task XING-12345
  → read JIRA title + description
  → git fetch origin master (or origin main)
  → branch from the latest available origin/master or origin/main
  → Git worktree + independent Herdr workspace
  → Herdr tabs: codex + terminal
  → start Codex and send JIRA context
  → assign a persistent curated task color
  → show the same color as a Herdr sidebar stripe
  → generate a .code-workspace with peacock.color
  → open VS Code automatically
```

Tasks do not have to come from JIRA. For local work, use:

```text
task local "Investigate checkout timeout"
  → the same Git worktree, Herdr, Codex, VS Code, and color workflow
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

Required for all tasks:

- `git`
- `node`
- `herdr`
- `codex`
- `code` (VS Code shell command)
- Peacock installed in VS Code

`task checks` additionally uses the GitHub CLI (`gh`) and the companion
`watch-pr-checks` script. `jq` improves failure summaries and is optional.

JIRA-backed tasks additionally require `acli` (Atlassian CLI).

Install ACLI on macOS:

```bash
brew tap atlassian/homebrew-acli
brew install acli
acli jira auth login --web
acli jira auth status
```

JIRA task creation checks authentication before fetching Git refs or creating a
worktree. If OAuth has expired, JIRA task creation stops and asks you to run
the login command again. Local tasks do not use JIRA or `acli`. A
Codex/ChatGPT Atlassian connector login is separate from the local `acli`
login.

If `code` is not on PATH, in VS Code run **Shell Command: Install 'code' command in PATH** from the Command Palette.

## 2. Install the task command

Pick a directory already on your PATH. For example:

```bash
mkdir -p ~/.local/bin
cp task.mjs ~/.local/bin/task
cp watch-pr-checks ~/.local/bin/watch-pr-checks
chmod +x ~/.local/bin/task
chmod +x ~/.local/bin/watch-pr-checks
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

and is always created from the freshly fetched `origin/master`, falling back to
`origin/main` when the repository has no master branch.

Later:

```bash
task open XING-12345
task list
task jira XING-12345
task figma XING-12345
task checks XING-12345
task checks XING-12345 --retry-once
task checks 12345
task watch
```

When run inside a registered JIRA task worktree, the ticket argument can be
omitted. `task jira` opens the ticket URL and `task figma` finds the first Figma
URL in the ticket description. Both reuse a Brave window named after the ticket,
focus the matching tab, and add new URLs as tabs. If Brave automation is
unavailable, the CLI falls back to opening the URL with macOS `open` in the
default browser.

`task checks` watches the pull request checks and, when the PR is in GitHub's
merge queue, follows its temporary merge-group workflow runs too. It sends a
macOS notification when checks pass or fail. The target can be a
registered task ID, a PR number/URL, or a branch; a PR number/URL works even
without a JIRA task. When omitted it is inferred
from the current task worktree. `--retry-once` reruns failed GitHub Actions
jobs only when the run is a `merge_group` or
an infrastructure-like `workflow_dispatch` run (Docker/container/runner/cache/
setup/queue), then watches the result once more. Deterministic test failures
and external checks are reported without an automatic retry. `task
watch` is an alias.

For work without a JIRA ticket:

```bash
task local "Investigate checkout timeout"
task local --branch chore/checkout-timeout "Investigate checkout timeout"
```

No-ticket tasks use an ID such as `NO-TICKET-INVESTIGATE-CHECKOUT-TIMEOUT`, skip JIRA
authentication and lookup, and otherwise use the same workflow. When no branch
is supplied, the branch is created from the latest `origin/master` (or
`origin/main` when master is unavailable) as
`investigate-checkout-timeout`.

To register an existing local branch:

```bash
task XING-12345 --branch existing-branch-name
```

If that branch is already checked out in a Git worktree, the CLI adopts it.
Otherwise, Git creates a worktree for the existing branch. This mode never
fetches, resets, rebases, or recreates the branch; the default origin base
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

To remove a task's local Herdr workspace, Git worktree, VS Code workspace file,
and registry entry, preview the cleanup first:

```bash
task delete TASK-ID
task delete TASK-ID --yes
# Only when Git cannot verify push status; the branch is still preserved.
task delete TASK-ID --yes --force
```

Deletion refuses dirty worktrees, branches with unpushed commits, and the
repository's primary checkout. `--force` explicitly skips the pushed-commit
verification. If the worktree's Git metadata is stale or missing, it can also
remove that managed worktree path directly. The Git branch itself is preserved,
so it can be adopted again later with `--branch`.

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
- Base prefers `origin/master` and falls back to `origin/main` when master is
  unavailable.
- `--branch` accepts an existing local branch and preserves its current history.
- `task local` creates the same task environment without requiring a JIRA ticket.
- A registered task keeps its assigned color.
- New tasks prefer palette colors not currently used by registered worktrees
  that still exist.
- JIRA descriptions are passed to the initial Codex prompt but are not retained
  in `tasks.json`; a missing Herdr workspace causes the description to be
  fetched again.
- If Herdr's server/session loses the workspace but the Git worktree still exists, `task open XING-12345` reopens it and bootstraps fresh `codex` and `terminal` tabs.
- Deletion is intentionally conservative: it requires `--yes`, refuses dirty
  or unpushed work, and preserves the Git branch.
