#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const STATE_DIR = process.env.TASK_WORKFLOW_HOME || path.join(HOME, '.local', 'share', 'task-workflow');
const VSCODE_DIR = path.join(STATE_DIR, 'vscode');
const WORKTREE_DIR = process.env.TASK_WORKFLOW_WORKTREE_DIR || path.join(STATE_DIR, 'worktrees');
const REGISTRY_FILE = path.join(STATE_DIR, 'tasks.json');
const HERDR_CONFIG_FILE = process.env.HERDR_CONFIG_PATH || path.join(HOME, '.config', 'herdr', 'config.toml');
const JIRA_LOGIN_COMMAND = 'acli jira auth login --web';
const JIRA_BASE_URL = process.env.TASK_WORKFLOW_JIRA_BASE_URL || 'https://new-work.atlassian.net';

const BRAVE_WINDOW_SCRIPT = `on run argv
  set windowName to item 1 of argv
  set requestedURLs to items 2 thru (count argv) of argv
  tell application "Brave Browser"
    activate
    set targetWindow to missing value
    repeat with candidate in windows
      if (given name of candidate) is windowName then
        set targetWindow to candidate
        exit repeat
      end if
    end repeat
    if targetWindow is missing value then
      set targetWindow to make new window
      set given name of targetWindow to windowName
    end if
    set targetTabIndex to 1
    set tabNumber to 0
    repeat with requestedURL in requestedURLs
      set urlText to contents of requestedURL
      set alreadyOpen to false
      repeat with candidateTab in tabs of targetWindow
        set tabNumber to tabNumber + 1
        if (URL of candidateTab) is urlText then
          set alreadyOpen to true
          set targetTabIndex to tabNumber
          exit repeat
        end if
      end repeat
      if not alreadyOpen then
        if (count of tabs of targetWindow) is 1 and ((URL of active tab of targetWindow) starts with "brave://newtab") then
          set URL of active tab of targetWindow to urlText
          set targetTabIndex to 1
        else
          make new tab at end of tabs of targetWindow with properties {URL:urlText}
          set targetTabIndex to (count of tabs of targetWindow)
        end if
      end if
    end repeat
    set given name of targetWindow to windowName
    set index of targetWindow to 1
    set active tab index of targetWindow to targetTabIndex
  end tell
end run`;

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

function taskId(task) {
  return task.id || task.ticket;
}

function taskRegistryKey(task) {
  return taskId(task);
}

function taskIsJira(task) {
  return task.kind === 'jira' || (!task.kind && Boolean(task.ticket));
}

function localTaskId(registry, title, repo) {
  const base = `NO-TICKET-${(slugify(title) || 'task').toUpperCase()}`;
  let id = base;
  let suffix = 2;
  while (registry.tasks[id] && registry.tasks[id].repo !== repo) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function titleFromBranch(branch) {
  const words = branch.replace(/^[^a-z0-9]+/i, '').replace(/[-_/]+/g, ' ').trim();
  if (!words) return 'Local development task';
  return words.charAt(0).toUpperCase() + words.slice(1);
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

function jiraView(ticket) {
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
  return parseJson(raw, 'acli');
}

function jiraLookup(ticket) {
  const issue = jiraView(ticket);
  const fields = issue.fields || issue;
  const summary = fields.summary || issue.summary;
  if (!summary) fail(`JIRA returned no summary for ${ticket}.`);
  const description = textFromAdf(fields.description ?? issue.description);
  return { key: issue.key || ticket, summary: String(summary).trim(), description };
}

function figmaLinks(value, links = new Set()) {
  if (!value) return links;
  if (typeof value === 'string') {
    const matches = value.match(/https?:\/\/(?:www\.)?figma\.com\/[^\s<>"')\]}]+/gi) || [];
    for (const match of matches) links.add(match.replace(/[.,;:!?]+$/g, ''));
    return links;
  }
  if (Array.isArray(value)) {
    for (const item of value) figmaLinks(item, links);
    return links;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) figmaLinks(item, links);
  }
  return links;
}

function jiraTicket(input, command) {
  const normalized = input?.toUpperCase();
  const registry = loadRegistry();
  if (normalized && registry.tasks[normalized]) {
    const task = registry.tasks[normalized];
    if (!taskIsJira(task)) fail(`${command} is only available for tasks with a JIRA ticket.`);
    return task.ticket;
  }

  if (normalized) {
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(normalized)) fail(`Usage: task ${command} [JIRA-TICKET]`);
    return normalized;
  }

  const task = inferTask(registry, { ticket: null, workspaceId: null });
  if (!task || !taskIsJira(task)) {
    fail(`Could not infer a JIRA ticket. Use: task ${command} XING-12345`);
  }
  return task.ticket;
}

function openBrowserWindow(windowName, urls) {
  const brave = run('osascript', ['-e', BRAVE_WINDOW_SCRIPT, '--', windowName, ...urls], { allowFailure: true });
  if (brave.status === 0) {
    console.log(`→ Brave window ${windowName}`);
    return;
  }
  console.warn('Brave automation was unavailable; opening the URLs in the default browser.');
  run('open', urls, { inherit: true });
}

function openJira(input) {
  const ticket = jiraTicket(input, 'jira');
  const url = `${JIRA_BASE_URL.replace(/\/$/, '')}/browse/${encodeURIComponent(ticket)}`;
  openBrowserWindow(ticket, [url]);
}

function openFigma(input) {
  const ticket = jiraTicket(input, 'figma');
  requireJiraAuth();
  const issue = jiraView(ticket);
  const links = [...figmaLinks(issue)];
  if (!links.length) fail(`No Figma link found on JIRA ticket ${ticket}.`);
  const [url] = links;
  openBrowserWindow(ticket, [url]);
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

function worktreePath(repo, branch) {
  const repoName = slugify(path.basename(repo)) || 'repo';
  const repoHash = createHash('sha256').update(repo).digest('hex').slice(0, 8);
  return path.join(WORKTREE_DIR, `${repoName}-${repoHash}`, branch);
}

function createGitWorktree(repo, branch, base = null) {
  const worktree = worktreePath(repo, branch);
  if (fs.existsSync(worktree)) {
    fail(`Worktree destination already exists: ${worktree}`);
  }

  fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  console.log('→ Git worktree');
  const args = ['worktree', 'add'];
  if (base) args.push('--no-track', '-b', branch, worktree, base);
  else args.push(worktree, branch);
  run('git', args, { cwd: repo, inherit: true });
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

function herdrCreateWorkspace(worktree, label) {
  console.log('→ Herdr workspace');
  const ids = herdrResultIds(output('herdr', [
    'workspace', 'create',
    '--cwd', worktree,
    '--label', label,
    '--focus',
  ]), 'herdr workspace create');
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

  const id = taskId(task);
  const agentName = `codex-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 32).replace(/-+$/g, '');
  const existingAgent = run('herdr', ['agent', 'get', ids.paneId], { allowFailure: true });
  if (existingAgent.status !== 0) {
    console.log('→ Start Codex');
    run('herdr', ['agent', 'start', agentName, '--kind', 'codex', '--pane', ids.paneId, '--timeout', '60000']);
  }

  const prompt = [
    taskIsJira(task) ? `We are working on JIRA ticket ${task.ticket}.` : 'We are working on a local development task.',
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
  const file = path.join(VSCODE_DIR, `${taskId(task)}.code-workspace`);
  const workspace = {
    folders: [{ name: taskId(task), path: task.worktree }],
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

function provisionTask(registry, { id, kind, ticket = null, title, description = '', repo, branch, existingWorktree = null, base = null }) {
  const branchOwner = Object.values(registry.tasks).find((task) => task.repo === repo && task.branch === branch);
  if (branchOwner) {
    fail(`Branch ${branch} is already registered to ${taskId(branchOwner)}.`);
  }
  const worktreeOwner = existingWorktree && Object.values(registry.tasks).find((task) => task.worktree === existingWorktree);
  if (worktreeOwner) {
    fail(`Worktree ${existingWorktree} is already registered to ${taskId(worktreeOwner)}.`);
  }

  const color = chooseColor(registry);
  const label = kind === 'jira' ? `${ticket} · ${title}` : `NO-TICKET · ${title}`;
  const worktree = existingWorktree || createGitWorktree(repo, branch, base);

  const task = {
    id,
    kind,
    ticket,
    title,
    repo,
    branch,
    worktree,
    label,
    color,
    herdrWorkspaceId: null,
    herdrCodexTabId: null,
    herdrCodexPaneId: null,
    herdrWorkspaceMode: 'standalone',
    herdrAgentName: null,
    vscodeWorkspace: path.join(VSCODE_DIR, `${id}.code-workspace`),
    status: 'provisioning',
    createdAt: new Date().toISOString(),
  };

  // Persist before creating the Herdr workspace so a later Herdr/Codex failure
  // cannot leave an unregistered Git worktree behind.
  registry.tasks[id] = task;
  saveRegistry(registry);

  const ids = herdrCreateWorkspace(worktree, label);
  task.herdrWorkspaceId = ids.workspaceId;
  task.herdrCodexTabId = ids.tabId;
  task.herdrCodexPaneId = ids.paneId;
  registry.tasks[id] = task;
  saveRegistry(registry);

  applyHerdrColor(ids.workspaceId, color);
  task.vscodeWorkspace = writeVsCodeWorkspace(task);
  task.herdrAgentName = bootstrapHerdr(task, ids, description);
  task.status = 'ready';
  task.lastOpenedAt = new Date().toISOString();
  registry.tasks[id] = task;
  saveRegistry(registry);

  openVsCode(task.vscodeWorkspace);

  console.log(`\n✓ ${id}`);
  console.log(`  ${task.title}`);
  console.log(`  branch:   ${task.branch}`);
  console.log(`  worktree: ${task.worktree}`);
  console.log(`  color:    ${task.color.name} ${task.color.hex}`);
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

  provisionTask(registry, {
    id: ticket,
    kind: 'jira',
    ticket,
    title: jira.summary,
    description: jira.description,
    repo,
    branch,
    existingWorktree,
    base: options.branch ? null : 'origin/master',
  });
}

function createLocalTask(options) {
  for (const dep of ['git', 'herdr', 'code', 'codex']) {
    if (!commandExists(dep)) fail(`Missing command: ${dep}`);
  }

  const repo = currentRepo();
  requireHerdrServer();
  const registry = loadRegistry();
  const title = options.title || titleFromBranch(options.branch);
  const id = localTaskId(registry, title, repo);
  if (registry.tasks[id]) {
    if (options.branch && registry.tasks[id].branch !== options.branch) {
      fail(`${id} is already registered with branch ${registry.tasks[id].branch}.`);
    }
    console.log(`${id} already exists — opening it.`);
    return openTask(id);
  }

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
    const slug = slugify(title) || 'task';
    branch = `local-${slug}`;
    if (localBranchExists(repo, branch)) {
      fail(`Local branch ${branch} already exists but is not registered. Use: task local --branch ${branch}`);
    }
  }

  provisionTask(registry, {
    id,
    kind: 'local',
    title,
    repo,
    branch,
    existingWorktree,
    base: options.branch ? null : 'origin/master',
  });
}

function reopenHerdr(task, jira) {
  console.log('→ Reopen Herdr workspace');
  const ids = herdrCreateWorkspace(task.worktree, task.label);
  task.herdrWorkspaceId = ids.workspaceId;
  task.herdrCodexTabId = ids.tabId;
  task.herdrCodexPaneId = ids.paneId;
  task.herdrWorkspaceMode = 'standalone';
  applyHerdrColor(ids.workspaceId, task.color);
  task.herdrAgentName = bootstrapHerdr(task, ids, jira.description);
  task.status = 'ready';
}

function taskContext(task) {
  if (!taskIsJira(task)) return { description: task.description || '' };
  requireJiraAuth();
  return jiraLookup(task.ticket);
}

function openTask(taskInput) {
  const id = taskInput.toUpperCase();
  const registry = loadRegistry();
  const task = registry.tasks[id];
  if (!task) fail(`Unknown task ${id}. Create it from the repository with: task ${id}`);

  if (!fs.existsSync(task.worktree)) fail(`Worktree no longer exists: ${task.worktree}`);

  if (herdrWorkspaceExists(task.herdrWorkspaceId)) {
    applyHerdrColor(task.herdrWorkspaceId, task.color);
    if (task.status !== 'ready') {
      const jira = taskContext(task);
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
    const jira = taskContext(task);
    reopenHerdr(task, jira);
  }

  if (!task.vscodeWorkspace || !fs.existsSync(task.vscodeWorkspace)) {
    task.vscodeWorkspace = writeVsCodeWorkspace(task);
    registry.tasks[taskRegistryKey(task)] = task;
    saveRegistry(registry);
  }

  task.lastOpenedAt = new Date().toISOString();
  registry.tasks[taskRegistryKey(task)] = task;
  saveRegistry(registry);
  openVsCode(task.vscodeWorkspace);
  console.log(`✓ Opened ${id}`);
}

function deleteTask(taskInput, options = {}) {
  const id = taskInput.toUpperCase();
  const registry = loadRegistry();
  const task = registry.tasks[id];
  if (!task) fail(`Unknown task ${id}.`);
  if (!task.repo || !task.branch || !task.worktree) fail(`Task ${id} is missing repository metadata.`);

  const repo = path.resolve(task.repo);
  const worktree = path.resolve(task.worktree);
  if (repo === worktree) {
    fail(`Refusing to remove ${id}: its worktree is the repository's primary checkout.`);
  }
  if (!fs.existsSync(worktree)) fail(`Worktree does not exist: ${task.worktree}`);

  const status = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree, allowFailure: true });
  if (status.status !== 0) fail(`Could not inspect worktree status for ${id}.`);
  if ((status.stdout || '').trim()) {
    fail(`Refusing to remove ${id}: the worktree has uncommitted or untracked changes.`);
  }

  const upstream = run('git', ['rev-parse', '--abbrev-ref', `${task.branch}@{upstream}`], { cwd: repo, allowFailure: true });
  if (upstream.status === 0 && (upstream.stdout || '').trim()) {
    const counts = output('git', ['rev-list', '--left-right', '--count', `${upstream.stdout.trim()}...${task.branch}`], { cwd: repo, allowFailure: true });
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    if (!Number.isFinite(ahead)) fail(`Could not inspect whether ${id} has unpushed commits.`);
    if (ahead > 0) fail(`Refusing to remove ${id}: ${ahead} commit(s) are not pushed to ${upstream.stdout.trim()}.`);
    void behind;
  } else {
    const ahead = output('git', ['rev-list', '--count', `origin/master..${task.branch}`], { cwd: repo, allowFailure: true });
    if (!/^\d+$/.test(ahead)) fail(`Could not determine whether ${id} has unpushed commits; no branch upstream is configured.`);
    if (Number(ahead) > 0) {
      fail(`Refusing to remove ${id}: its branch has commits but no upstream branch is configured.`);
    }
  }

  const vscodeWorkspace = task.vscodeWorkspace ? path.resolve(task.vscodeWorkspace) : null;
  const vscodeRoot = path.resolve(VSCODE_DIR);
  if (vscodeWorkspace && !vscodeWorkspace.startsWith(`${vscodeRoot}${path.sep}`)) {
    fail(`Refusing to remove ${id}: its VS Code workspace is outside the task-workflow state directory.`);
  }

  console.log(`Task ${id} is ready to delete.`);
  console.log(`  Herdr workspace: ${task.herdrWorkspaceId || '(none)'}`);
  console.log(`  Git worktree:    ${task.worktree}`);
  console.log(`  VS Code file:    ${task.vscodeWorkspace || '(none)'}`);
  console.log(`  Git branch:      ${task.branch} (preserved)`);
  if (!options.confirm) {
    console.log(`\nNothing was removed. Re-run with: task delete ${id} --yes`);
    return;
  }

  if (task.herdrWorkspaceId && herdrWorkspaceExists(task.herdrWorkspaceId)) {
    run('herdr', ['workspace', 'close', task.herdrWorkspaceId]);
  }
  run('git', ['worktree', 'remove', task.worktree], { cwd: repo, inherit: true });
  if (vscodeWorkspace && fs.existsSync(vscodeWorkspace)) fs.unlinkSync(vscodeWorkspace);
  delete registry.tasks[id];
  saveRegistry(registry);
  console.log(`✓ Deleted ${id}; branch ${task.branch} was preserved.`);
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

  if (task.color && herdrWorkspaceExists(task.herdrWorkspaceId)) {
    applyHerdrColor(task.herdrWorkspaceId, task.color);
  }

  if (!task.vscodeWorkspace || !fs.existsSync(task.vscodeWorkspace)) {
    task.vscodeWorkspace = writeVsCodeWorkspace(task);
    registry.tasks[taskRegistryKey(task)] = task;
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

function parseLocalArgs(args) {
  const options = { branch: null, title: '' };
  const titleParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--branch') {
      options.branch = args[index + 1];
      if (!options.branch) fail('Usage: task local "TITLE" [--branch EXISTING-BRANCH]');
      index += 1;
    } else {
      titleParts.push(value);
    }
  }
  options.title = titleParts.join(' ').trim();
  if (!options.title && !options.branch) fail('Usage: task local "TITLE" [--branch EXISTING-BRANCH]');
  return options;
}

function parseDeleteArgs(args) {
  const options = { confirm: false, id: null };
  for (const value of args) {
    if (value === '--yes') options.confirm = true;
    else if (!options.id) options.id = value;
    else fail('Usage: task delete TASK-ID [--yes]');
  }
  if (!options.id) fail('Usage: task delete TASK-ID [--yes]');
  return options;
}

function parseBrowserArgs(args, command) {
  if (args.length > 1) fail(`Usage: task ${command} [JIRA-TICKET]`);
  return args[0] || null;
}

function listTasks() {
  const registry = loadRegistry();
  const tasks = Object.values(registry.tasks);
  if (!tasks.length) {
    console.log('No registered tasks.');
    return;
  }
  for (const task of tasks) {
    const id = taskId(task);
    console.log(`${task.color?.name?.padEnd(7) || '       '} ${id.padEnd(34)} ${task.title}`);
    console.log(`         ${task.branch}`);
  }
}

function doctor() {
  const deps = ['git', 'node', 'herdr', 'code', 'codex'];
  let ok = true;
  for (const dep of deps) {
    const exists = commandExists(dep);
    console.log(`${exists ? '✓' : '✗'} ${dep}`);
    ok &&= exists;
  }

  if (commandExists('acli')) {
    const auth = jiraAuthStatus();
    const authenticated = auth.status === 0;
    console.log(`${authenticated ? '✓' : '⚠'} JIRA authentication (optional for local tasks)`);
    if (!authenticated) console.log(`  Run: ${JIRA_LOGIN_COMMAND}`);
  } else {
    console.log('○ acli (optional for local tasks)');
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
  console.log(`task-workflow\n\nUsage:\n  task XING-12345        Create a JIRA task from the current repo, or open it\n  task XING-12345 --branch EXISTING-BRANCH\n                         Adopt an existing JIRA task branch/worktree\n  task local "TITLE"     Create or open a task without a JIRA ticket\n  task local --branch BRANCH ["TITLE"]\n                         Adopt an existing local branch/worktree\n  task open TASK-ID      Reopen/focus Herdr + VS Code\n  task code [TASK-ID]    Open/focus the task's VS Code workspace\n  task code --herdr-workspace ID\n                         Open/focus VS Code for a Herdr workspace\n  task jira [JIRA-ID]    Open the JIRA ticket in the default browser\n  task figma [JIRA-ID]   Open the first Figma link found on the ticket\n  task list              List registered tasks\n  task doctor            Check commands, authentication, Herdr, and Peacock\n  task delete TASK-ID    Preview safe local cleanup (use --yes to apply)\n\nEnvironment:\n  TASK_WORKFLOW_HOME     Override state directory (default: ~/.local/share/task-workflow)`);
}

const [command, ...args] = process.argv.slice(2);
const arg = args[0];

if (!command || command === '--help' || command === '-h' || command === 'help') {
  help();
} else if (command === 'local') {
  createLocalTask(parseLocalArgs(args));
} else if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(command)) {
  createTask(command, parseCreateArgs(args));
} else if (command === 'open') {
  if (!arg) fail('Usage: task open XING-12345');
  openTask(arg);
} else if (command === 'delete') {
  const options = parseDeleteArgs(args);
  deleteTask(options.id, options);
} else if (command === 'jira') {
  openJira(parseBrowserArgs(args, command));
} else if (command === 'figma') {
  openFigma(parseBrowserArgs(args, command));
} else if (command === 'code') {
  codeTask(parseCodeArgs(args));
} else if (command === 'list') {
  listTasks();
} else if (command === 'doctor') {
  doctor();
} else {
  fail(`Unknown command: ${command}. Run task --help.`);
}
