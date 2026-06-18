import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Image, LoaderCircle, Paperclip, Play, Send, Square, User, Workflow } from 'lucide-react';
import Markdown from './Markdown';
import VerticalScrollRail from './VerticalScrollRail';
import '../agent-status.css';

type Message = { id: string; role: 'user' | 'assistant' | 'event'; content: string; event?: AgentEvent['type']; time: number };

function EventCard({ message }: { message: Message }) {
  const [open, setOpen] = useState(message.event !== 'status');
  const labels: Record<string, string> = { tool_call: 'Tool Call', tool_result: 'Tool Result', approval: '等待授权', plan: 'Plan', status: '状态', error: 'Error', exit: 'Process' };
  return <div className={`event-card ${message.event}`}><button onClick={() => setOpen(!open)}>{open ? <ChevronDown /> : <ChevronRight />}<Workflow /><b>{labels[message.event || ''] || 'Agent'}</b><time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></button>{open && <pre>{message.content}</pre>}</div>;
}

export default function Chat({ model, onModel, onEvent }: { model: string; onModel: (model: string) => void; onEvent: (event: AgentEvent) => void }) {
  const [messages, setMessages] = useState<Message[]>([{ id: 'welcome', role: 'assistant', content: '你好，我是 **Claude Code Studio**。\n\n`ccr code` 会自动在当前工作区启动。你可以直接输入任务，也可以在右侧 **Context** 中解析网页、文件和图片，确认后再注入当前会话。', time: Date.now() }]);
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const messagePane = useRef<HTMLDivElement>(null);
  const completionTimer = useRef<ReturnType<typeof setTimeout>>();
  const command = useMemo<'ccr code' | 'claude'>(() => model === 'Claude CLI' ? 'claude' : 'ccr code', [model]);
  const start = useCallback(async () => { if (starting) return; setStarting(true); try { await window.studio.agent.start(command); setRunning(true); } catch { setRunning(false); } finally { setStarting(false); } }, [command, starting]);

  useEffect(() => {
    const off = window.studio.agent.onEvent(event => {
      onEvent(event);
      if (event.type === 'output') setMessages(current => {
        const last = current[current.length - 1];
        const separator = event.meta?.append ? '' : '\n';
        if (last?.role === 'assistant') return [...current.slice(0, -1), { ...last, content: `${last.content}${separator}${event.content}` }];
        return [...current, { id: crypto.randomUUID(), role: 'assistant', content: event.content, time: event.timestamp }];
      });
      else setMessages(current => [...current, { id: crypto.randomUUID(), role: 'event', content: event.content, event: event.meta?.failed ? 'error' : event.type, time: event.timestamp }]);
      if (event.type === 'exit' || event.type === 'error') { setRunning(false); setBusy(false); }
      if (event.meta?.turnDone) setBusy(false);
      if (event.type === 'status' && /ready|starting|input ready/i.test(event.content)) setRunning(true);
      if (event.type === 'output' && /(?:^|\n)\s*claude:/i.test(event.content)) {
        if (completionTimer.current) clearTimeout(completionTimer.current);
        completionTimer.current = setTimeout(() => setBusy(false), 1000);
      }
    });
    start(); return () => { off(); if (completionTimer.current) clearTimeout(completionTimer.current); };
  }, [command]);

  useEffect(() => { if (!busy) return; const timer = setInterval(() => setElapsed(Math.floor((Date.now() - busySince) / 1000)), 1000); return () => clearInterval(timer); }, [busy, busySince]);
  useEffect(() => { const handler = (event: Event) => { const detail = (event as CustomEvent<{ label: string }>).detail; setMessages(current => [...current, { id: crypto.randomUUID(), role: 'user', content: `已注入上下文：**${detail.label}**`, time: Date.now() }]); }; window.addEventListener('studio:injected', handler); return () => window.removeEventListener('studio:injected', handler); }, []);
  useEffect(() => { const pane = messagePane.current; if (pane) pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' }); }, [messages, busy]);

  const submit = async () => {
    const prompt = text.trim(); if (!prompt) return;
    setMessages(current => [...current, { id: crypto.randomUUID(), role: 'user', content: prompt, time: Date.now() }]);
    setText(''); setBusy(true); setBusySince(Date.now()); setElapsed(0);
    if (!running) await start();
    window.studio.agent.input(`${prompt}\r`);
  };
  const interrupt = () => { window.studio.agent.input('\x03'); setBusy(false); setMessages(current => [...current, { id: crypto.randomUUID(), role: 'event', event: 'status', content: '已请求停止当前回复', time: Date.now() }]); };
  const attach = async () => { const paths = await window.studio.context.selectFiles(); if (paths.length) window.dispatchEvent(new CustomEvent('studio:files-selected', { detail: paths })); };

  return <main className="chat">
    <header className="chat-header"><div><span className="brand-mark">C</span><strong>Claude Code Studio</strong><span className={running ? 'live' : 'idle'}>{starting ? 'STARTING' : running ? 'RUNNING' : 'IDLE'}</span></div><div><select value={model} onChange={event => onModel(event.target.value)}><option>Claude Router</option><option>Claude CLI</option><option>GPT · Router</option><option>Gemini · Router</option><option>DeepSeek · Router</option><option>Qwen · Router</option><option>V4 Pro · Router</option></select>{running ? <button className="icon-btn" title="停止 Agent" onClick={() => { window.studio.agent.stop(); setRunning(false); setBusy(false); }}><Square /></button> : <button className="run-btn" disabled={starting} onClick={start}><Play />{starting ? 'Starting' : 'Start'}</button>}</div></header>
    <div className="messages-shell"><div className="messages" ref={messagePane}>{messages.map(message => message.role === 'event' ? <EventCard key={message.id} message={message} /> : <article key={message.id} className={`message ${message.role}`}><div className="avatar">{message.role === 'user' ? <User /> : <Bot />}</div><div><div className="message-meta">{message.role === 'user' ? 'You' : 'Claude'} <time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><div className="markdown"><Markdown>{message.content}</Markdown></div></div></article>)}{busy && <div className="thinking-indicator"><LoaderCircle /><span><b>Claude 正在处理</b><small>已运行 {elapsed} 秒 · 状态和工具活动会实时显示</small></span></div>}</div><VerticalScrollRail target={messagePane} /></div>
    <div className="composer-wrap"><div className="composer"><textarea value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="直接输入任务，或从 Context Manager 注入网页、文件和图片…" /><div className="composer-actions"><div><button title="添加文件" onClick={attach}><Paperclip /></button><button title="添加图片" onClick={attach}><Image /></button><span>Plan mode</span></div>{busy ? <button className="stop-response" onClick={interrupt}><Square />停止回复</button> : <button className="send" onClick={submit}><Send /></button>}</div></div><div className="hint">Enter 发送 · Shift+Enter 换行 · Agent 自动连接 ccr code</div></div>
  </main>;
}
