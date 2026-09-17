#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const STATE_DIR = process.env.TASK_WORKFLOW_HOME || path.join(HOME, '.local', 'share', 'task-workflow');
const VSCODE_DIR = path.join(STATE_DIR, 'vscode');
const REGISTRY_FILE = path.join(STATE_DIR, 'tasks.json');
const HERDR_CONFIG_FILE = process.env.HERDR_CONFIG_PATH || path.join(HOME, '.config', 'herdr', 'config.toml');
const JIRA_LOGIN_COMMAND = 'acli jira auth login --web';

const PALETTE = [
  { name: 'blue',   hex: '#3A7CA5' },
  { name: 'purple', hex: '#7158A6' },
  { name: 'teal',   hex: '#398B83' },
  { name: 'orange', hex: '#B56B3D' },
  { name: 'red',    hex: '#A94F5D' },
  { name: 'green',  hex: '#5B8255' },
  { name: 'indigo', hex: '#5569A8' },
  { name: 'brown',  hex: '#8A6748' },
];

function fail(message, code = 1) {
  console.error(`\n✗ ${message}`);
  process.exit(code);
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    if (options.allowFailure) return result;
    fail(`Could not run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }

  return result;
}

function output(command, args = [], options = {}) {
  return (run(command, args, options).stdout || '').trim();
}

function commandExists(command) {
  return run('sh', ['-c', `command -v ${shellQuote(command)} >/dev/null 2>&1`], { allowFailure: true }).status === 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function ensureDirs() {
  try {
    fs.mkdirSync(VSCODE_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail(`Cannot create state directory ${VSCODE_DIR}: ${error.message}`);
  }
}

function loadRegistry() {
  ensureDirs();
  if (!fs.existsSync(REGISTRY_FILE)) return { version: 1, tasks: {} };
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    if (!data.tasks) data.tasks = {};
    return data;
  } catch (error) {
    fail(`Cannot read registry ${REGISTRY_FILE}: ${error.message}`);
  }
}

function saveRegistry(registry) {
  ensureDirs();
  const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, REGISTRY_FILE);
}

function parseJson(text, label) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
    }
    fail(`Could not parse JSON returned by ${label}.\n${trimmed}`);
  }
}

function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

function textFromAdf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  const chunks = [];
  function walk(node) {
    if (!node) return;
    if (typeof node === 'string') { chunks.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      if (typeof node.text === 'string') chunks.push(node.text);
      if (node.type === 'hardBreak' || node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem') chunks.push('\n');
      if (node.content) walk(node.content);
    }
  }
  walk(value);
  return chunks.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function jiraLookup(ticket) {
  console.log(`→ JIRA ${ticket}`);
  const result = run('acli', ['jira', 'workitem', 'view', ticket, '--fields', 'summary,description', '--json'], { allowFailure: true });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    if (/unauthori[sz]ed|auth(?:entication)?/i.test(detail)) {
      fail(`JIRA authentication is required. Run:\n  ${JIRA_LOGIN_COMMAND}`);
    }
    fail(`Could not read ${ticket} from JIRA${detail ? `:\n${detail}` : '.'}`);
  }
  const raw = result.stdout || '';
  const issue = parseJson(raw, 'acli');
  const fields = issue.fields || issue;
  const summary = fields.summary || issue.summary;
  if (!summary) fail(`JIRA returned no summary for ${ticket}.`);
  const description = textFromAdf(fields.description ?? issue.description);
  return { key: issue.key || ticket, summary: String(summary).trim(), description };
}

function jiraAuthStatus() {
  return run('acli', ['jira', 'auth', 'status'], { allowFailure: true });
}

function requireJiraAuth() {
  const result = jiraAuthStatus();
  if (result.status !== 0) {
    fail(`JIRA authentication is required. Run:\n  ${JIRA_LOGIN_COMMAND}`);
  }
}

function currentRepo() {
  const root = output('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), allowFailure: true });
  if (!root) fail('Run this from inside the Git repository you want to work on.');
  return root;
}

function fetchMaster(repo) {
  console.log('→ Fetch origin/master');
  run('git', ['fetch', 'origin', 'master'], { cwd: repo, inherit: true });
  run('git', ['rev-parse', '--verify', 'origin/master'], { cwd: repo });
}

function localBranchExists(repo, branch) {
  return run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, allowFailure: true }).status === 0;
}

function validateBranchName(repo, branch) {
  if (!branch || run('git', ['check-ref-format', '--branch', branch], { cwd: repo, allowFailure: true }).status !== 0) {
    fail(`Invalid branch name: ${branch || '(empty)'}`);
  }
}

function findWorktree(repo, branch) {
  const raw = output('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
  let worktree = null;
  for (const block of raw.split(/\n\n+/)) {
    const lines = block.split('\n');
    const wt = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    const br = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
    if (wt && br === `refs/heads/${branch}`) {
      worktree = wt;
      break;
    }
  }
  return worktree;
}

function chooseColor(registry) {
  const used = new Set(
    Object.values(registry.tasks)
      .filter((task) => task.worktree && fs.existsSync(task.worktree))
      .map((task) => task.color?.name)
      .filter(Boolean),
  );
  return PALETTE.find((color) => !used.has(color.name)) || PALETTE[Object.keys(registry.tasks).length % PALETTE.length];
}

function requireHerdrServer() {
  const result = run('herdr', ['status', 'server'], { allowFailure: true });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`Herdr server is not available${detail ? `:\n${detail}` : '.'}`);
  }
}

function hasTaskHerdrConfig() {
  if (!fs.existsSync(HERDR_CONFIG_FILE)) return false;
  const config = fs.readFileSync(HERDR_CONFIG_FILE, 'utf8');
  return config.includes('$task_blue')
    && config.includes('key = "prefix+o"')
    && config.includes('--herdr-workspace')
    && /open_notification_target\s*=\s*""/.test(config);
}

function herdrResultIds(raw, label) {
  const json = parseJson(raw, label);
  const result = json.result || json;
  return {
    workspaceId: result.workspace?.workspace_id || result.worktree?.open_workspace_id || result.workspace_id,
    tabId: result.tab?.tab_id || result.tab_id,
    paneId: result.root_pane?.pane_id || result.pane?.pane_id || result.pane_id,
    worktree: result.worktree?.path || result.path,
  };
}

function herdrCreateWorktree(repo, branch, label, base) {
  console.log('→ Herdr worktree');
  const args = [
    'worktree', 'create',
    '--cwd', repo,
    '--branch', branch,
    '--label', label,
    '--focus',
  ];
  if (base) args.splice(6, 0, '--base', base);
  return herdrResultIds(output('herdr', args), 'herdr worktree create');
}

function herdrOpenWorktree(repo, worktree, label) {
  console.log('→ Open existing worktree in Herdr');
  const ids = herdrResultIds(output('herdr', [
    'worktree', 'open',
    '--cwd', repo,
    '--path', worktree,
    '--label', label,
    '--focus',
  ]), 'herdr worktree open');

  if (ids.workspaceId && (!ids.tabId || !ids.paneId)) {
    const tabIds = herdrResultIds(output('herdr', [
      'tab', 'create',
      '--workspace', ids.workspaceId,
      '--cwd', worktree,
      '--label', 'codex',
      '--focus',
    ]), 'herdr tab create');
    ids.tabId = tabIds.tabId;
    ids.paneId = tabIds.paneId;
  }

  ids.worktree ||= worktree;
  return ids;
}

function herdrWorkspaceExists(workspaceId) {
  if (!workspaceId) return false;
  return run('herdr', ['workspace', 'get', workspaceId], { allowFailure: true }).status === 0;
}

function applyHerdrColor(workspaceId, color) {
  const args = ['workspace', 'report-metadata', workspaceId, '--source', 'task-cli'];
  for (const item of PALETTE) {
    if (item.name !== color.name) args.push('--clear-token', `task_${item.name}`);
  }
  args.push('--token', `task_${color.name}=▌`);
  run('herdr', args);
}

function herdrTabs(workspaceId) {
  const json = parseJson(output('herdr', ['tab', 'list', '--workspace', workspaceId]), 'herdr tab list');
  return json.result?.tabs || json.tabs || [];
}

function bootstrapHerdr(task, ids, description) {
  if (!ids.workspaceId || !ids.tabId || !ids.paneId) {
    fail('Herdr did not return the workspace/tab/pane IDs expected by the CLI.');
  }

  run('herdr', ['tab', 'rename', ids.tabId, 'codex']);

  if (!herdrTabs(ids.workspaceId).some((tab) => tab.label === 'terminal')) {
    console.log('→ Herdr terminal tab');
    run('herdr', [
      'tab', 'create',
      '--workspace', ids.workspaceId,
      '--cwd', task.worktree,
      '--label', 'terminal',
      '--no-focus',
    ]);
  }

  const agentName = `codex-${task.ticket.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 32).replace(/-+$/g, '');
  const existingAgent = run('herdr', ['agent', 'get', ids.paneId], { allowFailure: true });
  if (existingAgent.status !== 0) {
    console.log('→ Start Codex');
    run('herdr', ['agent', 'start', agentName, '--kind', 'codex', '--pane', ids.paneId, '--timeout', '60000']);
  }

  const prompt = [
    `We are working on JIRA ticket ${task.ticket}.`,
    '',
    `Title: ${task.title}`,
    description ? `\nDescription:\n${description}` : '',
    '',
    `The repository worktree is ${task.worktree}.`,
    '',
    'First inspect the relevant implementation and tests. Understand the existing approach before making substantial changes. Then propose a concise implementation plan and proceed with the task.',
  ].filter(Boolean).join('\n');

  run('herdr', ['agent', 'prompt', ids.paneId, prompt]);
  run('herdr', ['tab', 'focus', ids.tabId]);
  run('herdr', ['workspace', 'focus', ids.workspaceId]);
  return agentName;
}

function writeVsCodeWorkspace(task) {
  ensureDirs();
  const file = path.join(VSCODE_DIR, `${task.ticket}.code-workspace`);
  const workspace = {
    folders: [{ name: task.ticket, path: task.worktree }],
    settings: {
      'peacock.color': task.color.hex,
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(workspace, null, 2)}\n`);
  return file;
}

function openVsCode(file) {
  console.log('→ VS Code');
  run('code', [file]);
}

function createTask(ticketInput, options = {}) {
  const ticket = ticketInput.toUpperCase();
  const registry = loadRegistry();
  if (registry.tasks[ticket]) {
    if (options.branch && registry.tasks[ticket].branch !== options.branch) {
      fail(`${ticket} is already registered with branch ${registry.tasks[ticket].branch}.`);
    }
    console.log(`${ticket} already exists — opening it.`);
    return openTask(ticket);
  }

  for (const dep of ['git', 'herdr', 'acli', 'code', 'codex']) {
    if (!commandExists(dep)) fail(`Missing command: ${dep}`);
  }

  const repo = currentRepo();
  requireJiraAuth();
  requireHerdrServer();
  const jira = jiraLookup(ticket);

  let branch;
  let existingWorktree = null;
  if (options.branch) {
    validateBranchName(repo, options.branch);
    if (!localBranchExists(repo, options.branch)) {
      fail(`Local branch ${options.branch} does not exist in ${repo}.`);
    }
    branch = options.branch;
    existingWorktree = findWorktree(repo, branch);
  } else {
    fetchMaster(repo);
    const slug = slugify(jira.summary) || 'task';
    branch = `${ticket}-${slug}`;
    if (localBranchExists(repo, branch)) {
      fail(`Local branch ${branch} already exists but is not registered. Use: task ${ticket} --branch ${branch}`);
    }
  }

  const branchOwner = Object.values(registry.tasks).find((task) => task.repo === repo && task.branch === branch);
  if (branchOwner) {
    fail(`Branch ${branch} is already registered to ${branchOwner.ticket}.`);
  }
  const worktreeOwner = existingWorktree && Object.values(registry.tasks).find((task) => task.worktree === existingWorktree);
  if (worktreeOwner) {
    fail(`Worktree ${existingWorktree} is already registered to ${worktreeOwner.ticket}.`);
  }

  const color = chooseColor(registry);
  const label = `${ticket} · ${jira.summary}`;
  const ids = existingWorktree
    ? herdrOpenWorktree(repo, existingWorktree, label)
    : herdrCreateWorktree(repo, branch, label, options.branch ? null : 'origin/master');
  const worktree = existingWorktree || ids.worktree || findWorktree(repo, branch);
  if (!worktree) fail(`Created ${branch}, but could not locate its worktree.`);

  const task = {
    ticket,
    title: jira.summary,
    repo,
    branch,
    worktree,
    label,
    color,
    herdrWorkspaceId: ids.workspaceId,
    herdrCodexTabId: ids.tabId,
    herdrCodexPaneId: ids.paneId,
    herdrAgentName: null,
    vscodeWorkspace: path.join(VSCODE_DIR, `${ticket}.code-workspace`),
    status: 'provisioning',
    createdAt: new Date().toISOString(),
  };

  // Persist immediately after Herdr creates the worktree, so later failures do
  // not leave an unregistered branch/worktree behind.
  registry.tasks[ticket] = task;
  saveRegistry(registry);

  applyHerdrColor(ids.workspaceId, color);
  task.vscodeWorkspace = writeVsCodeWorkspace(task);
  task.herdrAgentName = bootstrapHerdr(task, ids, jira.description);
  task.status = 'ready';
  task.lastOpenedAt = new Date().toISOString();
  registry.tasks[ticket] = task;
  saveRegistry(registry);

  openVsCode(task.vscodeWorkspace);

  console.log(`\n✓ ${ticket}`);
  console.log(`  ${task.title}`);
  console.log(`  branch:   ${task.branch}`);
  console.log(`  worktree: ${task.worktree}`);
  console.log(`  color:    ${task.color.name} ${task.color.hex}`);
}

function reopenHerdr(task, jira) {
  console.log('→ Reopen Herdr workspace');
  const raw = output('herdr', [
    'worktree', 'open',
    '--cwd', task.repo,
    '--path', task.worktree,
    '--label', task.label,
    '--focus',
  ]);
  const json = parseJson(raw, 'herdr worktree open');
  const result = json.result || json;
  const ids = {
    workspaceId: result.workspace?.workspace_id || result.workspace_id,
    tabId: result.tab?.tab_id || result.tab_id,
    paneId: result.root_pane?.pane_id || result.pane?.pane_id || result.pane_id,
  };
  task.herdrWorkspaceId = ids.workspaceId;
  task.herdrCodexTabId = ids.tabId;
  task.herdrCodexPaneId = ids.paneId;
  applyHerdrColor(ids.workspaceId, task.color);
  task.herdrAgentName = bootstrapHerdr(task, ids, jira.description);
  task.status = 'ready';
}

function openTask(ticketInput) {
  const ticket = ticketInput.toUpperCase();
  const registry = loadRegistry();
  const task = registry.tasks[ticket];
  if (!task) fail(`Unknown task ${ticket}. Create it from the repository with: task ${ticket}`);

  if (!fs.existsSync(task.worktree)) fail(`Worktree no longer exists: ${task.worktree}`);

  if (herdrWorkspaceExists(task.herdrWorkspaceId)) {
    applyHerdrColor(task.herdrWorkspaceId, task.color);
    if (task.status !== 'ready') {
      requireJiraAuth();
      const jira = jiraLookup(ticket);
      const ids = {
        workspaceId: task.herdrWorkspaceId,
        tabId: task.herdrCodexTabId,
        paneId: task.herdrCodexPaneId,
      };
      task.herdrAgentName = bootstrapHerdr(task, ids, jira.description);
      task.status = 'ready';
    }
    run('herdr', ['workspace', 'focus', task.herdrWorkspaceId]);
  } else {
    requireJiraAuth();
    const jira = jiraLookup(ticket);
    reopenHerdr(task, jira);
  }

  if (!task.vscodeWorkspace || !fs.existsSync(task.vscodeWorkspace)) {
    task.vscodeWorkspace = writeVsCodeWorkspace(task);
    registry.tasks[ticket] = task;
    saveRegistry(registry);
  }

  task.lastOpenedAt = new Date().toISOString();
  registry.tasks[ticket] = task;
  saveRegistry(registry);
  openVsCode(task.vscodeWorkspace);
  console.log(`✓ Opened ${ticket}`);
}

function inferTask(registry, { ticket, workspaceId }) {
  if (ticket) return registry.tasks[ticket.toUpperCase()];

  const activeWorkspace = workspaceId || process.env.HERDR_ACTIVE_WORKSPACE_ID || process.env.HERDR_WORKSPACE_ID;
  if (activeWorkspace) {
    const match = Object.values(registry.tasks).find((task) => task.herdrWorkspaceId === activeWorkspace);
    if (match) return match;
  }

  const cwd = path.resolve(process.cwd());
  const matches = Object.values(registry.tasks)
    .filter((task) => cwd === task.worktree || cwd.startsWith(`${task.worktree}${path.sep}`))
    .sort((a, b) => b.worktree.length - a.worktree.length);
  return matches[0];
}

function codeTask(options) {
  const registry = loadRegistry();
  const task = inferTask(registry, options);
  if (!task) fail('Could not infer the task. Run this inside a task worktree/Herdr workspace, or use: task code XING-123');
  if (!task.vscodeWorkspace || !fs.existsSync(task.vscodeWorkspace)) {
    task.vscodeWorkspace = writeVsCodeWorkspace(task);
    registry.tasks[task.ticket] = task;
    saveRegistry(registry);
  }
  openVsCode(task.vscodeWorkspace);
}

function parseCodeArgs(args) {
  const options = { ticket: null, workspaceId: null };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--herdr-workspace') {
      options.workspaceId = args[index + 1];
      if (!options.workspaceId) fail('Usage: task code [XING-12345] [--herdr-workspace ID]');
      index += 1;
    } else if (!options.ticket) {
      options.ticket = value;
    } else {
      fail('Usage: task code [XING-12345] [--herdr-workspace ID]');
    }
  }
  return options;
}

function parseCreateArgs(args) {
  const options = { branch: null };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--branch') {
      options.branch = args[index + 1];
      if (!options.branch) fail('Usage: task XING-12345 [--branch EXISTING-BRANCH]');
      index += 1;
    } else {
      fail('Usage: task XING-12345 [--branch EXISTING-BRANCH]');
    }
  }
  return options;
}

function listTasks() {
  const registry = loadRegistry();
  const tasks = Object.values(registry.tasks);
  if (!tasks.length) {
    console.log('No registered tasks.');
    return;
  }
  for (const task of tasks) {
    console.log(`${task.color?.name?.padEnd(7) || '       '} ${task.ticket.padEnd(14)} ${task.title}`);
    console.log(`         ${task.branch}`);
  }
}

function doctor() {
  const deps = ['git', 'node', 'herdr', 'acli', 'code', 'codex'];
  let ok = true;
  for (const dep of deps) {
    const exists = commandExists(dep);
    console.log(`${exists ? '✓' : '✗'} ${dep}`);
    ok &&= exists;
  }

  if (commandExists('acli')) {
    const auth = jiraAuthStatus();
    const authenticated = auth.status === 0;
    console.log(`${authenticated ? '✓' : '✗'} JIRA authentication`);
    if (!authenticated) console.log(`  Run: ${JIRA_LOGIN_COMMAND}`);
    ok &&= authenticated;
  }

  if (commandExists('herdr')) {
    const config = run('herdr', ['config', 'check'], { allowFailure: true });
    const configOk = config.status === 0;
    console.log(`${configOk ? '✓' : '✗'} Herdr configuration`);
    ok &&= configOk;

    const workflowConfig = hasTaskHerdrConfig();
    console.log(`${workflowConfig ? '✓' : '✗'} Herdr task marker and prefix+o binding`);
    ok &&= workflowConfig;

    const server = run('herdr', ['status', 'server'], { allowFailure: true });
    const serverOk = server.status === 0;
    console.log(`${serverOk ? '✓' : '✗'} Herdr server`);
    ok &&= serverOk;
  }

  if (commandExists('codex')) {
    const login = run('codex', ['login', 'status'], { allowFailure: true });
    const loginOk = login.status === 0;
    console.log(`${loginOk ? '✓' : '✗'} Codex authentication`);
    ok &&= loginOk;
  }

  if (commandExists('code')) {
    const extensions = run('code', ['--list-extensions'], { allowFailure: true });
    const peacock = extensions.status === 0 && /^johnpapa\.vscode-peacock$/im.test(extensions.stdout || '');
    console.log(`${peacock ? '✓' : '✗'} Peacock extension`);
    ok &&= peacock;
  }
  console.log(`\nRegistry: ${REGISTRY_FILE}`);
  if (!ok) process.exitCode = 1;
}

function help() {
  console.log(`task-workflow\n\nUsage:\n  task XING-12345        Create a task from the current repo, or open it if registered\n  task XING-12345 --branch EXISTING-BRANCH\n                         Adopt an existing local branch/worktree\n  task open XING-12345   Reopen/focus Herdr + VS Code\n  task code [XING-12345] Open/focus the task's VS Code workspace\n  task code --herdr-workspace ID\n                         Open/focus VS Code for a Herdr workspace\n  task list              List registered tasks\n  task doctor            Check commands, authentication, Herdr, and Peacock\n\nEnvironment:\n  TASK_WORKFLOW_HOME     Override state directory (default: ~/.local/share/task-workflow)`);
}

const [command, ...args] = process.argv.slice(2);
const arg = args[0];

if (!command || command === '--help' || command === '-h' || command === 'help') {
  help();
} else if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(command)) {
  createTask(command, parseCreateArgs(args));
} else if (command === 'open') {
  if (!arg) fail('Usage: task open XING-12345');
  openTask(arg);
} else if (command === 'code') {
  codeTask(parseCodeArgs(args));
} else if (command === 'list') {
  listTasks();
} else if (command === 'doctor') {
  doctor();
} else {
  fail(`Unknown command: ${command}. Run task --help.`);
}
