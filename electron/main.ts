import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn as spawnChild } from 'node:child_process';
import * as pty from 'node-pty';
import type { AgentEvent, GitInfo, TreeNode } from './types';

let win: BrowserWindow | null = null;
let cwd = process.cwd();
const terminals = new Map<string, pty.IPty>();
let agent: pty.IPty | null = null;
let agentReady = false;
let agentCommand: 'ccr code' | 'claude' = 'ccr code';
let pendingAgentInput: string[] = [];
let agentReadyTimer: NodeJS.Timeout | null = null;
let agentReadyFallback: NodeJS.Timeout | null = null;

const safeSend = (channel: string, data: unknown) => {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, data);
};
const stripAnsi = (value: string) => value
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const emitAgent = (type: AgentEvent['type'], content: string, meta?: Record<string, unknown>) =>
  safeSend('agent:event', { type, content, timestamp: Date.now(), meta } satisfies AgentEvent);

async function loadWorkspace() {
  const fallback = app.getPath('documents');
  try {
    const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'workspace.json'), 'utf8')) as { cwd?: string };
    if (saved.cwd && (await fs.stat(saved.cwd)).isDirectory()) cwd = saved.cwd;
    else cwd = fallback;
  } catch { cwd = fallback; }
}
async function saveWorkspace() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(path.join(app.getPath('userData'), 'workspace.json'), JSON.stringify({ cwd }), 'utf8');
}
async function tree(dir: string, depth = 0): Promise<TreeNode[]> {
  if (depth > 5) return [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const visible = entries
    .filter(entry => !['node_modules', '.git', 'dist', 'dist-electron', 'release'].includes(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return Promise.all(visible.map(async entry => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory()
      ? { name: entry.name, path: entryPath, type: 'directory' as const, children: await tree(entryPath, depth + 1) }
      : { name: entry.name, path: entryPath, type: 'file' as const };
  }));
}
const run = (cmd: string, args: string[] = []) => new Promise<string>((resolve) => {
  const child = spawnChild(cmd, args, { cwd, windowsHide: true, shell: true });
  let output = '';
  child.stdout?.on('data', data => output += data);
  child.stderr?.on('data', data => output += data);
  child.on('close', () => resolve(output.trim()));
  child.on('error', () => resolve(''));
});
async function gitInfo(): Promise<GitInfo> {
  const branch = (await run('git', ['branch', '--show-current'])) || 'no branch';
  const raw = await run('git', ['status', '--porcelain']);
  const files = raw.split('\n').filter(Boolean).map(line => ({ status: line.slice(0, 2).trim() || 'M', path: line.slice(3) }));
  const logs = await run('git', ['log', '-8', '--pretty=format:%h%x09%s%x09%cr']);
  const commits = logs.split('\n').filter(Boolean).map(line => { const [hash, subject, relative] = line.split('\t'); return { hash, subject, relative }; });
  return { branch, files, commits };
}
function parseAgent(raw: string) {
  const clean = stripAnsi(raw).replace(/\r/g, '');
  for (const content of clean.split('\n').filter(line => line.trim())) {
    let event: AgentEvent = { type: 'output', content, timestamp: Date.now() };
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      event = { type: (parsed.type as AgentEvent['type']) || 'output', content: String(parsed.content || parsed.message || content), timestamp: Date.now(), meta: parsed };
    } catch {
      if (/allow|deny|permission|approve|批准|允许|拒绝/i.test(content)) event.type = 'approval';
      else if (/tool (use|call)|calling tool|⏺/i.test(content)) event.type = 'tool_call';
      else if (/error|failed|exception/i.test(content)) event.type = 'error';
      else if (/plan|todo/i.test(content)) event.type = 'plan';
      else if (/thinking|思考|planning|reading|editing|executing|testing/i.test(content)) event.type = 'status';
    }
    safeSend('agent:event', event);
  }
}
function flushAgentInput() {
  if (!agent || !agentReady || !pendingAgentInput.length) return;
  const queued = pendingAgentInput.splice(0);
  setTimeout(() => queued.forEach(input => agent?.write(input)), 120);
}
function stopAgent() {
  if (agentReadyTimer) clearTimeout(agentReadyTimer);
  if (agentReadyFallback) clearTimeout(agentReadyFallback);
  agentReadyTimer = null;
  agentReadyFallback = null;
  const current = agent;
  agent = null;
  agentReady = false;
  if (current) { try { current.kill(); } catch { /* already stopped */ } }
}
function startAgent(command: 'ccr code' | 'claude') {
  stopAgent();
  agentCommand = command;
  pendingAgentInput = [];
  try {
    const session = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      name: 'xterm-256color', cols: 120, rows: 40, cwd, env: process.env as Record<string, string>
    });
    agent = session;
    session.onData(data => {
      if (agent !== session) return;
      parseAgent(data);
      if (!agentReady) {
        if (agentReadyTimer) clearTimeout(agentReadyTimer);
        agentReadyTimer = setTimeout(() => {
          if (agent !== session || agentReady) return;
          agentReady = true; emitAgent('status', `${command} ready`); flushAgentInput();
        }, 1000);
      }
    });
    session.onExit(({ exitCode }) => {
      if (agent !== session) return;
      agent = null; agentReady = false;
      emitAgent(exitCode === 0 ? 'exit' : 'error', `${command} exited with code ${exitCode}`);
    });
    agentReadyFallback = setTimeout(() => {
      if (agent !== session || agentReady) return;
      agentReady = true; emitAgent('status', `${command} input ready`); flushAgentInput();
    }, 8000);
    emitAgent('status', `Starting ${command} in ${cwd}`);
  } catch (error) {
    agent = null;
    emitAgent('error', `Unable to start ${command}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
function cleanupProcesses() {
  terminals.forEach(terminal => { try { terminal.kill(); } catch { /* already stopped */ } });
  terminals.clear();
  stopAgent();
}
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1100, minHeight: 700, backgroundColor: '#0d0e11',
    titleBarStyle: 'hiddenInset', titleBarOverlay: { color: '#0d0e11', symbolColor: '#9ca1ac', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.on('closed', () => { cleanupProcesses(); win = null; });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(async () => {
  await loadWorkspace();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { cleanupProcesses(); if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('workspace:open', async () => {
  const result = await dialog.showOpenDialog({ defaultPath: cwd, properties: ['openDirectory'] });
  if (result.canceled) return null;
  cwd = result.filePaths[0];
  await saveWorkspace();
  safeSend('workspace:changed', cwd);
  if (agent) startAgent(agentCommand);
  return { cwd, tree: await tree(cwd) };
});
ipcMain.handle('workspace:get', async () => ({ cwd, tree: await tree(cwd) }));
ipcMain.handle('fs:read', async (_event, filePath: string) => fs.readFile(filePath, 'utf8'));
ipcMain.handle('fs:create', async (_event, filePath: string, type: 'file' | 'directory') => { if (type === 'directory') await fs.mkdir(filePath, { recursive: true }); else await fs.writeFile(filePath, '', { flag: 'wx' }); return tree(cwd); });
ipcMain.handle('fs:delete', async (_event, filePath: string) => { await fs.rm(filePath, { recursive: true }); return tree(cwd); });
ipcMain.handle('fs:reveal', (_event, filePath: string) => shell.showItemInFolder(filePath));
ipcMain.handle('fs:menu', async (_event, filePath: string) => new Promise<string | undefined>(resolve => {
  if (!win || win.isDestroyed()) return resolve(undefined);
  Menu.buildFromTemplate([
    { label: '在资源管理器中显示', click: () => { shell.showItemInFolder(filePath); resolve('reveal'); } },
    { type: 'separator' },
    { label: '复制路径', click: () => { safeSend('clipboard:path', filePath); resolve('copy'); } }
  ]).popup({ window: win, callback: () => resolve(undefined) });
}));
ipcMain.handle('git:info', gitInfo);
ipcMain.handle('git:command', async (_event, action: string, arg?: string) => {
  const commands: Record<string, string[]> = { pull: ['pull'], push: ['push'], commit: ['commit', '-am', arg || 'Update from Claude Code Studio'], branch: ['switch', '-c', arg || 'studio-work'] };
  return { output: await run('git', commands[action] || ['status']), info: await gitInfo() };
});
ipcMain.handle('terminal:create', (_event, id: string) => {
  try { terminals.get(id)?.kill(); } catch { /* already stopped */ }
  const terminal = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: process.env as Record<string, string> });
  terminals.set(id, terminal);
  terminal.onData(data => safeSend('terminal:data', { id, data }));
  terminal.onExit(() => { terminals.delete(id); safeSend('terminal:exit', id); });
  return true;
});
ipcMain.on('terminal:input', (_event, { id, data }) => terminals.get(id)?.write(data));
ipcMain.on('terminal:resize', (_event, { id, cols, rows }) => terminals.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1)));
ipcMain.handle('terminal:kill', (_event, id: string) => { try { terminals.get(id)?.kill(); } catch { /* already stopped */ } terminals.delete(id); });
ipcMain.handle('agent:start', (_event, command: 'ccr code' | 'claude') => { startAgent(command); return true; });
ipcMain.on('agent:input', (_event, text: string) => { if (agent && agentReady) agent.write(text); else pendingAgentInput.push(text); });
ipcMain.handle('agent:stop', () => { pendingAgentInput = []; stopAgent(); });
