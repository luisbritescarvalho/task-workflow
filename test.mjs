import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = new URL('./task.mjs', import.meta.url).pathname;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function makeFixture({ authenticated = true, branchExists = false, checkedOut = false, defaultBranch = 'master', unpushable = false, invalidWorktree = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workflow-test-'));
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const log = path.join(root, 'calls.jsonl');
  const stub = path.join(root, 'stub.mjs');
  fs.mkdirSync(bin);
  fs.mkdirSync(repo);

  fs.writeFileSync(stub, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const command = process.argv[2];
const args = process.argv.slice(3);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args }) + '\\n');

if (command === 'acli') {
  if (args.join(' ') === 'jira auth status') process.exit(process.env.FAKE_AUTH === 'ok' ? 0 : 1);
  if (args.slice(0, 4).join(' ') === 'jira workitem view XING-123') {
    console.log(JSON.stringify({
      key: 'XING-123',
      fields: {
        summary: 'Improve recommendation tracking',
        description: {
          type: 'doc',
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Track all clicks.' },
              { type: 'inlineCard', attrs: { url: 'https://www.figma.com/file/example/recommendation-tracking' } },
            ],
          }],
        },
      },
    }));
    process.exit(0);
  }
}

if (command === 'git') {
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') console.log(process.env.FAKE_REPO);
  else if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
    if (args[2].includes('@{upstream}') && process.env.FAKE_UNPUSHABLE === 'yes') process.exit(1);
    console.log('origin/' + args[2].split('@')[0]);
  }
  else if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') console.log('git@github.com:xing-com/crate.git');
  else if (args[0] === 'fetch') {
    if (args[2] === 'master' && process.env.FAKE_DEFAULT_BRANCH === 'main') process.exit(1);
  }
  else if (args[0] === 'rev-parse' && args[1] === '--verify') {
    if (args[2] === 'origin/master' && process.env.FAKE_DEFAULT_BRANCH === 'main') process.exit(1);
    console.log('0123456789abcdef');
  }
  else if (args[0] === 'rev-list' && args[1] === '--left-right') console.log('0\t0');
  else if (args[0] === 'rev-list' && args[1] === '--count') {
    if (process.env.FAKE_UNPUSHABLE === 'yes') process.exit(1);
    console.log('0');
  }
  else if (args[0] === 'check-ref-format') process.exit(0);
  else if (args[0] === 'show-ref') process.exit(process.env.FAKE_BRANCH_EXISTS === 'yes' ? 0 : 1);
  else if (args[0] === 'worktree' && args[1] === 'list') {
    const blocks = ['worktree ' + process.env.FAKE_REPO + '\\nHEAD 0123456789abcdef\\nbranch refs/heads/master'];
    if (process.env.FAKE_CHECKED_OUT === 'yes') {
      blocks.push('worktree ' + process.env.FAKE_EXISTING_WORKTREE + '\\nHEAD fedcba9876543210\\nbranch refs/heads/already-started');
    }
    console.log(blocks.join('\\n\\n'));
  }
  else if (args[0] === 'worktree' && args[1] === 'add') {
    const branchIndex = args.indexOf('-b');
    const worktree = branchIndex === -1 ? args[2] : args[branchIndex + 2];
    fs.mkdirSync(worktree, { recursive: true });
  }
  else if (args[0] === 'status' && process.env.FAKE_INVALID_WORKTREE === 'yes') process.exit(1);
  else if (args[0] === 'worktree' && args[1] === 'remove') {
    if (process.env.FAKE_INVALID_WORKTREE === 'yes') process.exit(1);
    fs.rmSync(args[2], { recursive: true, force: true });
  }
  process.exit(0);
}

if (command === 'herdr') {
  if (args[0] === 'status') process.exit(0);
  if (args[0] === 'workspace' && args[1] === 'get') {
    process.exit(process.env.FAKE_WORKSPACE_EXISTS === 'yes' ? 0 : 1);
  }
  if (args[0] === 'workspace' && args[1] === 'close') process.exit(0);
  if (args[0] === 'workspace' && args[1] === 'create') {
    console.log(JSON.stringify({ result: {
      workspace: { workspace_id: 'wT' },
      tab: { tab_id: 'wT:t1' },
      root_pane: { pane_id: 'wT:p1' },
    } }));
    process.exit(0);
  }
  if (args[0] === 'tab' && args[1] === 'list') {
    console.log(JSON.stringify({ result: { tabs: [{ tab_id: 'wT:t1', label: 'codex' }] } }));
    process.exit(0);
  }
  if (args[0] === 'agent' && args[1] === 'get') process.exit(1);
  console.log(JSON.stringify({ result: {} }));
  process.exit(0);
}

if (command === 'code' || command === 'codex' || command === 'open' || command === 'osascript' || command === 'watch-pr-checks') process.exit(0);
process.exit(2);
`);

  for (const command of ['git', 'herdr', 'acli', 'code', 'codex', 'open', 'osascript', 'watch-pr-checks']) {
    const wrapper = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(stub)} ${shellQuote(command)} "$@"\n`;
    const file = path.join(bin, command);
    fs.writeFileSync(file, wrapper, { mode: 0o755 });
  }

  const env = {
    ...process.env,
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    TASK_WORKFLOW_HOME: state,
    FAKE_AUTH: authenticated ? 'ok' : 'no',
    FAKE_LOG: log,
    FAKE_REPO: repo,
    FAKE_ROOT: root,
    FAKE_BRANCH_EXISTS: branchExists ? 'yes' : 'no',
    FAKE_DEFAULT_BRANCH: defaultBranch,
    FAKE_UNPUSHABLE: unpushable ? 'yes' : 'no',
    FAKE_INVALID_WORKTREE: invalidWorktree ? 'yes' : 'no',
    FAKE_CHECKED_OUT: checkedOut ? 'yes' : 'no',
    FAKE_WORKSPACE_EXISTS: 'yes',
    FAKE_EXISTING_WORKTREE: path.join(root, 'existing-worktree'),
    TASK_WORKFLOW_WORKTREE_DIR: path.join(root, 'worktrees'),
  };

  if (checkedOut) fs.mkdirSync(env.FAKE_EXISTING_WORKTREE);

  return { root, repo, state, log, env };
}

function calls(fixture) {
  if (!fs.existsSync(fixture.log)) return [];
  return fs.readFileSync(fixture.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('creates a registered task from JIRA and origin/master', () => {
  const fixture = makeFixture();
  const result = spawnSync(process.execPath, [cli, 'XING-123'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(fixture.state, 'tasks.json'), 'utf8'));
  const task = registry.tasks['XING-123'];
  assert.equal(task.branch, 'XING-123-improve-recommendation-tracking');
  assert.equal(task.status, 'ready');
  assert.equal(task.color.hex, '#3A7CA5');
  assert.equal('description' in task, false);

  const workspace = JSON.parse(fs.readFileSync(task.vscodeWorkspace, 'utf8'));
  assert.equal(workspace.folders[0].path, task.worktree);
  assert.equal(workspace.settings['peacock.color'], task.color.hex);

  const recorded = calls(fixture);
  const authIndex = recorded.findIndex(({ command, args }) => command === 'acli' && args.join(' ') === 'jira auth status');
  const fetchIndex = recorded.findIndex(({ command, args }) => command === 'git' && args[0] === 'fetch');
  const worktreeIndex = recorded.findIndex(({ command, args }) => command === 'git' && args.slice(0, 2).join(' ') === 'worktree add');
  const workspaceIndex = recorded.findIndex(({ command, args }) => command === 'herdr' && args.slice(0, 2).join(' ') === 'workspace create');
  assert.ok(authIndex >= 0 && authIndex < fetchIndex && fetchIndex < worktreeIndex && worktreeIndex < workspaceIndex);

  const worktreeCreate = recorded[worktreeIndex].args;
  assert.deepEqual(worktreeCreate.slice(-2), [task.worktree, 'origin/master']);
  assert.equal(worktreeCreate[worktreeCreate.indexOf('-b') + 1], task.branch);
  const workspaceCreate = recorded[workspaceIndex].args;
  assert.equal(workspaceCreate[workspaceCreate.indexOf('--cwd') + 1], task.worktree);
  assert.equal(recorded.some(({ command, args }) => command === 'herdr' && args[0] === 'worktree'), false);
  const prompt = recorded.find(({ command, args }) => command === 'herdr' && args.slice(0, 2).join(' ') === 'agent prompt');
  assert.match(prompt.args[3], /Track all clicks\./);
});

test('opens JIRA and Figma links in a ticket-named Brave window', () => {
  const fixture = makeFixture();
  const jira = spawnSync(process.execPath, [cli, 'jira', 'XING-123'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(jira.status, 0, jira.stderr);

  const figma = spawnSync(process.execPath, [cli, 'figma', 'XING-123'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(figma.status, 0, figma.stderr);

  const browserCalls = calls(fixture).filter(({ command }) => command === 'osascript');
  assert.equal(browserCalls.length, 2);
  assert.equal(browserCalls[0].args[2], '--');
  assert.equal(browserCalls[0].args[3], 'XING-123');
  assert.equal(browserCalls[0].args[4], 'https://new-work.atlassian.net/browse/XING-123');
  assert.equal(browserCalls[1].args[2], '--');
  assert.equal(browserCalls[1].args[3], 'XING-123');
  assert.equal(browserCalls[1].args[4], 'https://www.figma.com/file/example/recommendation-tracking');
});

test('authentication failure aborts before Git fetch or Herdr mutation', () => {
  const fixture = makeFixture({ authenticated: false });
  const result = spawnSync(process.execPath, [cli, 'XING-123'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /acli jira auth login --web/);
  const recorded = calls(fixture);
  assert.equal(recorded.some(({ command, args }) => command === 'git' && args[0] === 'fetch'), false);
  assert.equal(recorded.some(({ command, args }) => command === 'herdr' && args[0] === 'worktree'), false);
});

test('creates a Git worktree and standalone Herdr workspace for an existing local branch', () => {
  const fixture = makeFixture({ branchExists: true });
  const result = spawnSync(process.execPath, [cli, 'XING-123', '--branch', 'already-started'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(fixture.state, 'tasks.json'), 'utf8'));
  assert.equal(registry.tasks['XING-123'].branch, 'already-started');

  const recorded = calls(fixture);
  assert.equal(recorded.some(({ command, args }) => command === 'git' && args[0] === 'fetch'), false);
  const create = recorded.find(({ command, args }) => command === 'git' && args.slice(0, 2).join(' ') === 'worktree add');
  assert.ok(create);
  assert.equal(create.args.includes('-b'), false);
  assert.equal(create.args.at(-1), 'already-started');
  const workspace = recorded.find(({ command, args }) => command === 'herdr' && args.slice(0, 2).join(' ') === 'workspace create');
  assert.ok(workspace);
  assert.equal(recorded.some(({ command, args }) => command === 'herdr' && args[0] === 'worktree'), false);
});

test('adopts the existing worktree when the local branch is already checked out', () => {
  const fixture = makeFixture({ branchExists: true, checkedOut: true });
  const result = spawnSync(process.execPath, [cli, 'XING-123', '--branch', 'already-started'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(fixture.state, 'tasks.json'), 'utf8'));
  assert.equal(registry.tasks['XING-123'].worktree, fixture.env.FAKE_EXISTING_WORKTREE);

  const recorded = calls(fixture);
  assert.equal(recorded.some(({ command, args }) => command === 'git' && args[0] === 'fetch'), false);
  assert.equal(recorded.some(({ command, args }) => command === 'git' && args.slice(0, 2).join(' ') === 'worktree add'), false);
  const workspace = recorded.find(({ command, args }) => command === 'herdr' && args.slice(0, 2).join(' ') === 'workspace create');
  assert.equal(workspace.args[workspace.args.indexOf('--cwd') + 1], fixture.env.FAKE_EXISTING_WORKTREE);
  assert.equal(recorded.some(({ command, args }) => command === 'herdr' && args[0] === 'worktree'), false);
});

test('recreates a missing Herdr workspace as a standalone workspace', () => {
  const fixture = makeFixture();
  const worktree = path.join(fixture.root, 'existing-worktree');
  const vscodeWorkspace = path.join(fixture.state, 'vscode', 'XING-123.code-workspace');
  fs.mkdirSync(path.dirname(vscodeWorkspace), { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(vscodeWorkspace, '{}\n');
  fs.writeFileSync(path.join(fixture.state, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: {
      'XING-123': {
        ticket: 'XING-123',
        title: 'Improve recommendation tracking',
        repo: fixture.repo,
        branch: 'already-started',
        worktree,
        label: 'XING-123 · Improve recommendation tracking',
        herdrWorkspaceId: 'missing',
        vscodeWorkspace,
        color: { name: 'blue', hex: '#3A7CA5' },
        status: 'ready',
      },
    },
  }));

  const result = spawnSync(process.execPath, [cli, 'open', 'XING-123'], {
    cwd: fixture.repo,
    env: { ...fixture.env, FAKE_WORKSPACE_EXISTS: 'no' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(fixture.state, 'tasks.json'), 'utf8'));
  assert.equal(registry.tasks['XING-123'].herdrWorkspaceId, 'wT');
  assert.equal(registry.tasks['XING-123'].herdrWorkspaceMode, 'standalone');
  const recorded = calls(fixture);
  const workspace = recorded.find(({ command, args }) => command === 'herdr' && args.slice(0, 2).join(' ') === 'workspace create');
  assert.equal(workspace.args[workspace.args.indexOf('--cwd') + 1], worktree);
  assert.equal(recorded.some(({ command, args }) => command === 'herdr' && args[0] === 'worktree'), false);
});

test('task code resolves an explicit Herdr workspace ID and reapplies its color', () => {
  const fixture = makeFixture();
  const worktree = path.join(fixture.root, 'worktree');
  const vscodeWorkspace = path.join(fixture.state, 'vscode', 'XING-123.code-workspace');
  fs.mkdirSync(path.dirname(vscodeWorkspace), { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(vscodeWorkspace, '{}\n');
  fs.writeFileSync(path.join(fixture.state, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: {
      'XING-123': {
        ticket: 'XING-123',
        title: 'Improve recommendation tracking',
        worktree,
        herdrWorkspaceId: 'wT',
        vscodeWorkspace,
        color: { name: 'blue', hex: '#3A7CA5' },
      },
    },
  }));

  const result = spawnSync(process.execPath, [cli, 'code', '--herdr-workspace', 'wT'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const recorded = calls(fixture);
  const colorCall = recorded.find(({ command, args }) => command === 'herdr' && args.slice(0, 2).join(' ') === 'workspace report-metadata');
  assert.deepEqual(colorCall.args, [
    'workspace', 'report-metadata', 'wT',
    '--source', 'task-cli',
    '--clear-token', 'task_purple',
    '--clear-token', 'task_teal',
    '--clear-token', 'task_orange',
    '--clear-token', 'task_red',
    '--clear-token', 'task_green',
    '--clear-token', 'task_indigo',
    '--clear-token', 'task_brown',
    '--token', 'task_blue=▌',
  ]);
  const codeCall = recorded.find(({ command }) => command === 'code');
  assert.deepEqual(codeCall.args, [vscodeWorkspace]);
});

test('task checks infers the registered branch and forwards the one-shot retry option', () => {
  const fixture = makeFixture();
  const worktree = path.join(fixture.root, 'worktree');
  fs.mkdirSync(worktree);
  fs.mkdirSync(fixture.state, { recursive: true });
  fs.writeFileSync(path.join(fixture.state, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: {
      'XING-123': {
        ticket: 'XING-123',
        title: 'Improve recommendation tracking',
        repo: fixture.repo,
        branch: 'XING-123-improve-recommendation-tracking',
        worktree,
      },
    },
  }));

  const result = spawnSync(process.execPath, [cli, 'checks', '--retry-once'], {
    cwd: worktree,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const watcher = calls(fixture).find(({ command }) => command === 'watch-pr-checks');
  assert.deepEqual(watcher.args, [
    'XING-123-improve-recommendation-tracking',
    'xing-com/crate',
    '--retry-once',
  ]);
});

test('task checks accepts an explicit pull request number without a registered task', () => {
  const fixture = makeFixture();
  const result = spawnSync(process.execPath, [cli, 'checks', '12345'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const watcher = calls(fixture).find(({ command }) => command === 'watch-pr-checks');
  assert.deepEqual(watcher.args, ['12345', 'xing-com/crate']);
});

test('creates a local task without JIRA and uses origin/master', () => {
  const fixture = makeFixture();
  const result = spawnSync(process.execPath, [cli, 'local', 'Investigate', 'checkout', 'timeout'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(fixture.state, 'tasks.json'), 'utf8'));
  const task = registry.tasks['NO-TICKET-INVESTIGATE-CHECKOUT-TIMEOUT'];
  assert.equal(task.kind, 'local');
  assert.equal(task.ticket, null);
  assert.equal(task.title, 'Investigate checkout timeout');
  assert.equal(task.branch, 'investigate-checkout-timeout');

  const recorded = calls(fixture);
  assert.equal(recorded.some(({ command }) => command === 'acli'), false);
  const fetch = recorded.find(({ command, args }) => command === 'git' && args[0] === 'fetch');
  assert.ok(fetch);
  const worktree = recorded.find(({ command, args }) => command === 'git' && args.slice(0, 2).join(' ') === 'worktree add');
  assert.deepEqual(worktree.args.slice(-2), [task.worktree, 'origin/master']);
  const prompt = recorded.find(({ command, args }) => command === 'herdr' && args.slice(0, 2).join(' ') === 'agent prompt');
  assert.match(prompt.args[3], /local development task/);
});

test('falls back to origin/main when origin/master is unavailable', () => {
  const fixture = makeFixture({ defaultBranch: 'main' });
  const result = spawnSync(process.execPath, [cli, 'local', 'Investigate', 'main', 'checkout'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(fixture.state, 'tasks.json'), 'utf8'));
  const task = registry.tasks['NO-TICKET-INVESTIGATE-MAIN-CHECKOUT'];
  const fetches = calls(fixture).filter(({ command, args }) => command === 'git' && args[0] === 'fetch');
  assert.deepEqual(fetches.map(({ args }) => args), [['fetch', 'origin', 'master'], ['fetch', 'origin', 'main']]);
  const worktree = calls(fixture).find(({ command, args }) => command === 'git' && args.slice(0, 2).join(' ') === 'worktree add');
  assert.deepEqual(worktree.args.slice(-2), [task.worktree, 'origin/main']);
});

test('adopts an existing local branch and worktree without JIRA', () => {
  const fixture = makeFixture({ branchExists: true, checkedOut: true });
  const result = spawnSync(process.execPath, [cli, 'local', '--branch', 'already-started', 'Fix checkout'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(fixture.state, 'tasks.json'), 'utf8'));
  const task = registry.tasks['NO-TICKET-FIX-CHECKOUT'];
  assert.equal(task.branch, 'already-started');
  assert.equal(task.worktree, fixture.env.FAKE_EXISTING_WORKTREE);

  const recorded = calls(fixture);
  assert.equal(recorded.some(({ command }) => command === 'acli'), false);
  assert.equal(recorded.some(({ command, args }) => command === 'git' && args[0] === 'fetch'), false);
  assert.equal(recorded.some(({ command, args }) => command === 'git' && args.slice(0, 2).join(' ') === 'worktree add'), false);
  const workspace = recorded.find(({ command, args }) => command === 'herdr' && args.slice(0, 2).join(' ') === 'workspace create');
  assert.equal(workspace.args[workspace.args.indexOf('--cwd') + 1], fixture.env.FAKE_EXISTING_WORKTREE);
});

test('previews and safely deletes a clean task while preserving its branch', () => {
  const fixture = makeFixture();
  const created = spawnSync(process.execPath, [cli, 'XING-123'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);

  const registryFile = path.join(fixture.state, 'tasks.json');
  const task = JSON.parse(fs.readFileSync(registryFile, 'utf8')).tasks['XING-123'];
  const preview = spawnSync(process.execPath, [cli, 'delete', 'XING-123'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Nothing was removed/);
  assert.ok(fs.existsSync(task.worktree));
  assert.ok(fs.existsSync(task.vscodeWorkspace));

  const deleted = spawnSync(process.execPath, [cli, 'delete', 'XING-123', '--yes'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(fs.existsSync(task.worktree), false);
  assert.equal(fs.existsSync(task.vscodeWorkspace), false);
  assert.equal(JSON.parse(fs.readFileSync(registryFile, 'utf8')).tasks['XING-123'], undefined);

  const recorded = calls(fixture);
  assert.ok(recorded.some(({ command, args }) => command === 'herdr' && args.join(' ') === 'workspace close wT'));
  assert.ok(recorded.some(({ command, args }) => command === 'git' && args.join(' ') === `worktree remove ${task.worktree}`));
});

test('allows explicit force deletion when Git push status cannot be verified', () => {
  const fixture = makeFixture({ unpushable: true });
  const created = spawnSync(process.execPath, [cli, 'local', 'SEPA XING copy'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);

  const registryFile = path.join(fixture.state, 'tasks.json');
  const task = JSON.parse(fs.readFileSync(registryFile, 'utf8')).tasks['NO-TICKET-SEPA-XING-COPY'];
  const blocked = spawnSync(process.execPath, [cli, 'delete', 'NO-TICKET-SEPA-XING-COPY'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /no branch upstream is configured/);

  const forced = spawnSync(process.execPath, [cli, 'delete', 'NO-TICKET-SEPA-XING-COPY', '--yes', '--force'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /Skipping the pushed-commit check/);
  assert.equal(fs.existsSync(task.worktree), false);
  assert.equal(JSON.parse(fs.readFileSync(registryFile, 'utf8')).tasks['NO-TICKET-SEPA-XING-COPY'], undefined);
});

test('force deletes a stale worktree whose Git metadata is gone', () => {
  const fixture = makeFixture({ invalidWorktree: true });
  const created = spawnSync(process.execPath, [cli, 'local', 'Stale checkout'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);

  const registryFile = path.join(fixture.state, 'tasks.json');
  const task = JSON.parse(fs.readFileSync(registryFile, 'utf8')).tasks['NO-TICKET-STALE-CHECKOUT'];
  const blocked = spawnSync(process.execPath, [cli, 'delete', 'NO-TICKET-STALE-CHECKOUT', '--yes'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Could not inspect worktree status/);

  const forced = spawnSync(process.execPath, [cli, 'delete', 'NO-TICKET-STALE-CHECKOUT', '--yes', '--force'], {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /managed path directly/);
  assert.equal(fs.existsSync(task.worktree), false);
  assert.equal(JSON.parse(fs.readFileSync(registryFile, 'utf8')).tasks['NO-TICKET-STALE-CHECKOUT'], undefined);
});
