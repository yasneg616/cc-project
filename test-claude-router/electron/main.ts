import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn as spawnChild } from 'node:child_process';
import * as pty from 'node-pty';
import dotenv from 'dotenv';
import type { AgentEvent, GitInfo, TreeNode } from './types';
import { estimateVisibleTokens, extractActivity, extractClaudeReply, extractUsage, hasTurnEndMarker, isTerminalNoise, normalizeTerminalText } from './agent-output';
import { cloudOcr, cloudVision, formatContext, localOcr, parseFile, readUrl, webSearch, type ParsedContext, type SearchProvider } from './context-service';

let win: BrowserWindow | null = null;
let cwd = process.cwd();
const terminals = new Map<string, pty.IPty>();
const contextCache = new Map<string, ParsedContext>();
let agent: pty.IPty | null = null;
let agentReady = false;
let agentCommand: 'ccr code' | 'claude' = 'ccr code';
let pendingAgentInput: string[] = [];
let agentReadyTimer: NodeJS.Timeout | null = null;
let agentReadyFallback: NodeJS.Timeout | null = null;
let agentBuffer = '';
let agentPartialOffset = 0;
let agentPartialTimer: NodeJS.Timeout | null = null;
let lastAgentEvent = '';
let lastAgentEventAt = 0;
type AgentTurn = { id: number; prompt: string; reply: string; startedAt: number; active: boolean; answered: boolean; retried: boolean; timer: NodeJS.Timeout | null; usage: { durationMs?: number; inputTokens?: number; outputTokens?: number } };
let agentTurn: AgentTurn | null = null;
let agentTurnSequence = 0;

const safeSend = (channel: string, data: unknown) => {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, data);
};
const stripAnsi = (value: string) => value
  .replace(/\x1b(?:P|\]|\^|_)[\s\S]*?(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
  .replace(/\x1b[@-_]/g, '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const emitAgent = (type: AgentEvent['type'], content: string, meta?: Record<string, unknown>) =>
  safeSend('agent:event', { type, content, timestamp: Date.now(), meta } satisfies AgentEvent);

function finishAgentTurn(content: string, failed = false) {
  if (!agentTurn) return;
  if (agentTurn.timer) clearTimeout(agentTurn.timer);
  const durationMs = agentTurn.usage.durationMs ?? Date.now() - agentTurn.startedAt;
  const inputTokens = agentTurn.usage.inputTokens ?? estimateVisibleTokens(agentTurn.prompt);
  const outputTokens = agentTurn.usage.outputTokens ?? estimateVisibleTokens(agentTurn.reply);
  const estimated = agentTurn.usage.inputTokens === undefined || agentTurn.usage.outputTokens === undefined;
  const turnId = agentTurn.id;
  agentTurn = null;
  emitAgent('status', content, { turnDone: true, failed, turnId, durationMs, inputTokens, outputTokens, estimated });
}
function armAgentTurnTimer(delay: number) {
  if (!agentTurn) return;
  if (agentTurn.timer) clearTimeout(agentTurn.timer);
  agentTurn.timer = setTimeout(() => {
    if (!agentTurn) return;
    if (!agentTurn.active && !agentTurn.retried && agent) {
      agentTurn.retried = true;
      emitAgent('status', 'CLI 未确认收到任务，正在自动重发一次…');
      agent.write('\x15');
      agent.write(`${agentTurn.prompt}\r`);
      armAgentTurnTimer(5000);
      return;
    }
    finishAgentTurn(agentTurn.active ? 'Claude 已超过 60 秒没有新活动，本轮可能已卡住' : 'Claude CLI 未接收任务，请重启 Agent 后重试', true);
  }, delay);
}
function observeAgentTurn(content: string) {
  if (!agentTurn) return;
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  const usage = extractUsage(normalized);
  if (usage.durationMs !== undefined) agentTurn.usage.durationMs = usage.durationMs;
  if (usage.inputTokens !== undefined) agentTurn.usage.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) agentTurn.usage.outputTokens = usage.outputTokens;
  if (/esc to interrupt|thought for|worked for|baked for|tool (?:use|call)|calling tool|thinking|searching|reading|writing|running|…/i.test(normalized)) {
    agentTurn.active = true;
    armAgentTurnTimer(60000);
  }
  if (/(?:^|\s)claude:/i.test(normalized)) {
    agentTurn.active = true;
    agentTurn.answered = true;
    armAgentTurnTimer(60000);
  }
}
function writeAgentInput(text: string) {
  const prompt = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (prompt.length < 2 || /^\//.test(prompt)) { agent?.write(text); return; }
  if (agentTurn?.timer) clearTimeout(agentTurn.timer);
  if (agentPartialTimer) clearTimeout(agentPartialTimer);
  agentPartialTimer = null; agentBuffer = ''; agentPartialOffset = 0;
  agentTurn = { id: ++agentTurnSequence, prompt, reply: '', startedAt: Date.now(), active: false, answered: false, retried: false, timer: null, usage: {} };
  agent?.write(text);
  emitAgent('status', '任务已发送，等待 Claude CLI 确认…');
  armAgentTurnTimer(3000);
}

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
  const visible = entries.filter(entry => !['node_modules', '.git', 'dist', 'dist-electron', 'release'].includes(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return Promise.all(visible.map(async entry => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? { name: entry.name, path: entryPath, type: 'directory' as const, children: await tree(entryPath, depth + 1) }
      : { name: entry.name, path: entryPath, type: 'file' as const };
  }));
}
const run = (cmd: string, args: string[] = []) => new Promise<string>((resolve) => {
  const child = spawnChild(cmd, args, { cwd, windowsHide: true, shell: true });
  let output = '';
  child.stdout?.on('data', data => output += data);
  child.stderr?.on('data', data => output += data);
  child.on('close', () => resolve(output.trim())); child.on('error', () => resolve(''));
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
  agentBuffer += normalizeTerminalText(stripAnsi(raw));
  const lines = agentBuffer.split('\n');
  agentBuffer = lines.pop() || '';
  const completedPartialOffset = agentPartialOffset;
  if (lines.length) agentPartialOffset = 0;
  if (agentBuffer.length > 8192) { lines.push(agentBuffer); agentBuffer = ''; }
  for (let index = 0; index < lines.length; index += 1) {
    let content = lines[index].trim();
    if (index === 0 && completedPartialOffset) content = lines[index].slice(completedPartialOffset).trim();
    if (!content) continue;
    observeAgentTurn(content);
    const reply = extractClaudeReply(content);
    if (reply) {
      if (agentTurn) {
        agentTurn.active = true;
        agentTurn.answered = true;
        agentTurn.reply += `${agentTurn.reply ? '\n' : ''}${reply}`;
      }
      emitAgent('output', reply, { turnId: agentTurn?.id });
    }
    const activity = extractActivity(content);
    if (activity) emitAgent('status', activity, { turnId: agentTurn?.id, aggregate: true });
    if (hasTurnEndMarker(content) && agentTurn?.answered) finishAgentTurn('回复完成');
    if (reply || isTerminalNoise(content)) continue;
    const plainPrompt = agentTurn?.prompt.replace(/\s+/g, ' ').trim();
    const plainContent = content.replace(/^you:\s*/i, '').replace(/\s+/g, ' ').trim();
    if (plainPrompt && plainContent === plainPrompt) { emitAgent('status', 'Claude CLI 已回显任务，等待受理…'); continue; }
    if (/Fixed.?sandbox|denyRead|allowRead|globoveralarge|(?:^|\s)[`|]{2,}/i.test(content)) continue;
    if (/^[^\s]{0,20}(?:thinking|status)[^\s]{0,3}$/i.test(content)) continue;
    let event: AgentEvent = { type: 'output', content, timestamp: Date.now() };
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      event = { type: (parsed.type as AgentEvent['type']) || 'output', content: String(parsed.content || parsed.message || ''), timestamp: Date.now(), meta: parsed };
      if (!event.content) continue;
    } catch {
      if (/(permission|approval request|requesting permission|do you want to proceed|would you like to|allow (?:this|tool)|请求权限|是否允许|需要.{0,8}授权)/i.test(content)) event.type = 'approval';
      else if (/tool (use|call)|calling tool|工具调用/i.test(content)) event.type = 'tool_call';
      else if (/error|failed|exception/i.test(content)) event.type = 'error';
      else if (/plan|todo/i.test(content)) event.type = 'plan';
      else if (/thinking|思考|planning|reading|editing|executing|testing/i.test(content)) event.type = 'status';
    }
    const signature = `${event.type}:${event.content}`;
    if (signature === lastAgentEvent && Date.now() - lastAgentEventAt < 1500) continue;
    lastAgentEvent = signature; lastAgentEventAt = Date.now(); safeSend('agent:event', event);
  }
  if (agentPartialTimer) clearTimeout(agentPartialTimer);
  agentPartialTimer = setTimeout(() => {
    const content = agentBuffer;
    if (!content.trim()) return;
    observeAgentTurn(content);
    const plainPrompt = agentTurn?.prompt.replace(/\s+/g, ' ').trim();
    const plainContent = content.replace(/^you:\s*/i, '').replace(/\s+/g, ' ').trim();
    if (plainPrompt && plainContent === plainPrompt) return;
    const activity = extractActivity(content);
    if (activity) emitAgent('status', activity, { turnId: agentTurn?.id, aggregate: true });
    // Human-readable TUI output is redrawn in place. Wait for its prompt marker
    // so an incomplete "claude: o" fragment is never rendered as the answer.
    if (!hasTurnEndMarker(content)) return;
    const reply = extractClaudeReply(content);
    if (!reply) return;
    if (agentTurn) {
      agentTurn.active = true;
      agentTurn.answered = true;
      agentTurn.reply = reply;
    }
    emitAgent('output', reply, { turnId: agentTurn?.id });
    if (agentTurn?.answered) finishAgentTurn('回复完成');
    agentPartialOffset = agentBuffer.length;
  }, 120);
}
function flushAgentInput() {
  if (!agent || !agentReady || !pendingAgentInput.length) return;
  const queued = pendingAgentInput.splice(0); setTimeout(() => queued.forEach(writeAgentInput), 120);
}
function stopAgent() {
  if (agentReadyTimer) clearTimeout(agentReadyTimer); if (agentReadyFallback) clearTimeout(agentReadyFallback);
  if (agentPartialTimer) clearTimeout(agentPartialTimer);
  if (agentTurn?.timer) clearTimeout(agentTurn.timer);
  agentTurn = null;
  agentReadyTimer = null; agentReadyFallback = null; agentPartialTimer = null; agentBuffer = ''; agentPartialOffset = 0;
  const current = agent; agent = null; agentReady = false;
  if (current) { try { current.kill(); } catch { /* already stopped */ } }
}
function startAgent(command: 'ccr code' | 'claude') {
  stopAgent(); agentCommand = command; pendingAgentInput = [];
  try {
    const session = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${command} --ax-screen-reader`], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: process.env as Record<string, string> });
    agent = session;
    session.onData(data => {
      if (agent !== session) return; parseAgent(data);
      if (!agentReady) { if (agentReadyTimer) clearTimeout(agentReadyTimer); agentReadyTimer = setTimeout(() => { if (agent !== session || agentReady) return; agentReady = true; emitAgent('status', `${command} ready`); flushAgentInput(); }, 1000); }
    });
    session.onExit(({ exitCode }) => { if (agent !== session) return; agent = null; agentReady = false; emitAgent(exitCode === 0 ? 'exit' : 'error', `${command} exited with code ${exitCode}`); });
    agentReadyFallback = setTimeout(() => { if (agent !== session || agentReady) return; agentReady = true; emitAgent('status', `${command} input ready`); flushAgentInput(); }, 8000);
    emitAgent('status', `Starting ${command} in ${cwd}`);
  } catch (error) { agent = null; emitAgent('error', `Unable to start ${command}: ${error instanceof Error ? error.message : String(error)}`); throw error; }
}
function cleanupProcesses() { terminals.forEach(terminal => { try { terminal.kill(); } catch { /* stopped */ } }); terminals.clear(); stopAgent(); }
function createWindow() {
  win = new BrowserWindow({ width: 1500, height: 940, minWidth: 1100, minHeight: 700, backgroundColor: '#0d0e11', titleBarStyle: 'hiddenInset', titleBarOverlay: { color: '#0d0e11', symbolColor: '#9ca1ac', height: 40 }, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.on('closed', () => { cleanupProcesses(); win = null; });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL); else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(async () => {
  await loadWorkspace(); dotenv.config({ path: path.join(cwd, '.env'), quiet: true }); dotenv.config({ path: path.join(app.getPath('userData'), '.env'), override: false, quiet: true });
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { cleanupProcesses(); if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('workspace:open', async () => { const result = await dialog.showOpenDialog({ defaultPath: cwd, properties: ['openDirectory'] }); if (result.canceled) return null; cwd = result.filePaths[0]; await saveWorkspace(); dotenv.config({ path: path.join(cwd, '.env'), override: true, quiet: true }); safeSend('workspace:changed', cwd); if (agent) startAgent(agentCommand); return { cwd, tree: await tree(cwd) }; });
ipcMain.handle('workspace:get', async () => ({ cwd, tree: await tree(cwd) }));
ipcMain.handle('fs:read', async (_event, filePath: string) => fs.readFile(filePath, 'utf8'));
ipcMain.handle('fs:create', async (_event, filePath: string, type: 'file' | 'directory') => { if (type === 'directory') await fs.mkdir(filePath, { recursive: true }); else await fs.writeFile(filePath, '', { flag: 'wx' }); return tree(cwd); });
ipcMain.handle('fs:delete', async (_event, filePath: string) => { await fs.rm(filePath, { recursive: true }); return tree(cwd); });
ipcMain.handle('fs:reveal', (_event, filePath: string) => shell.showItemInFolder(filePath));
ipcMain.handle('fs:menu', async (_event, filePath: string) => new Promise<string | undefined>(resolve => { if (!win || win.isDestroyed()) return resolve(undefined); Menu.buildFromTemplate([{ label: '在资源管理器中显示', click: () => { shell.showItemInFolder(filePath); resolve('reveal'); } }, { type: 'separator' }, { label: '复制路径', click: () => { safeSend('clipboard:path', filePath); resolve('copy'); } }]).popup({ window: win, callback: () => resolve(undefined) }); }));
ipcMain.handle('git:info', gitInfo);
ipcMain.handle('git:command', async (_event, action: string, arg?: string) => { const commands: Record<string, string[]> = { pull: ['pull'], push: ['push'], commit: ['commit', '-am', arg || 'Update from Claude Code Studio'], branch: ['switch', '-c', arg || 'studio-work'] }; return { output: await run('git', commands[action] || ['status']), info: await gitInfo() }; });
ipcMain.handle('terminal:create', (_event, id: string) => { try { terminals.get(id)?.kill(); } catch { /* stopped */ } const terminal = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: process.env as Record<string, string> }); terminals.set(id, terminal); terminal.onData(data => safeSend('terminal:data', { id, data })); terminal.onExit(() => { terminals.delete(id); safeSend('terminal:exit', id); }); return true; });
ipcMain.on('terminal:input', (_event, { id, data }) => terminals.get(id)?.write(data));
ipcMain.on('terminal:resize', (_event, { id, cols, rows }) => terminals.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1)));
ipcMain.handle('terminal:kill', (_event, id: string) => { try { terminals.get(id)?.kill(); } catch { /* stopped */ } terminals.delete(id); });
ipcMain.handle('agent:start', (_event, command: 'ccr code' | 'claude') => { startAgent(command); return true; });
ipcMain.on('agent:input', (_event, text: string) => { if (agent && agentReady) writeAgentInput(text); else pendingAgentInput.push(text); });
ipcMain.handle('agent:stop', () => { pendingAgentInput = []; stopAgent(); });

ipcMain.handle('context:select-files', async () => { const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: '支持的文件和图片', extensions: ['txt', 'md', 'js', 'ts', 'py', 'cpp', 'c', 'h', 'java', 'json', 'yaml', 'yml', 'csv', 'pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] }] }); return result.canceled ? [] : result.filePaths; });
ipcMain.handle('context:parse-files', async (_event, paths: string[]) => Promise.all(paths.map(async filePath => { const item = await parseFile(filePath); contextCache.set(item.id, item); return item; })));
ipcMain.handle('context:search', (_event, provider: SearchProvider, query: string, endpoint?: string) => webSearch(provider, query, endpoint));
ipcMain.handle('context:read-url', async (_event, url: string) => { const item = await readUrl(url); contextCache.set(item.id, item); return item; });
ipcMain.handle('context:ocr', async (_event, itemId: string, engine: string) => { const item = contextCache.get(itemId); if (!item) throw new Error('图片缓存已失效'); const content = engine === 'tesseract' ? await localOcr(item.source) : await cloudOcr(item.source, engine); item.content = content; item.preview = content.slice(0, 6000); item.analysisKind = 'ocr'; item.engine = engine; return item; });
ipcMain.handle('context:vision', async (_event, itemId: string, provider: 'openai' | 'gemini' | 'claude' | 'qwen') => { const item = contextCache.get(itemId); if (!item) throw new Error('图片缓存已失效'); const content = await cloudVision(item.source, provider, 'vision'); item.content = content; item.preview = content.slice(0, 6000); item.analysisKind = 'vision'; item.engine = provider; return item; });
ipcMain.handle('context:clear-cache', () => { contextCache.clear(); return true; });
ipcMain.handle('context:format', (_event, label: Parameters<typeof formatContext>[0], source: string, name: string, content: string, engine?: string) => formatContext(label, source, name, content, engine));
