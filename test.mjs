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

function makeFixture({ authenticated = true, branchExists = false, checkedOut = false } = {}) {
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
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Track all clicks.' }] }] },
      },
    }));
    process.exit(0);
  }
}

if (command === 'git') {
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') console.log(process.env.FAKE_REPO);
  else if (args[0] === 'rev-parse' && args[1] === '--verify') console.log('0123456789abcdef');
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
  process.exit(0);
}

if (command === 'herdr') {
  if (args[0] === 'status') process.exit(0);
  if (args[0] === 'workspace' && args[1] === 'get') {
    process.exit(process.env.FAKE_WORKSPACE_EXISTS === 'yes' ? 0 : 1);
  }
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

if (command === 'code' || command === 'codex') process.exit(0);
process.exit(2);
`);

  for (const command of ['git', 'herdr', 'acli', 'code', 'codex']) {
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
