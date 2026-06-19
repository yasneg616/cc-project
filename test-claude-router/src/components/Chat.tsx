import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Image, LoaderCircle, Paperclip, Play, Send, Square, User, Workflow } from 'lucide-react';
import Markdown from './Markdown';
import VerticalScrollRail from './VerticalScrollRail';
import '../agent-status.css';

type TurnStats = { durationMs: number; inputTokens: number; outputTokens: number; estimated: boolean };
type Message = { id: string; role: 'user' | 'assistant' | 'event'; content: string; event?: AgentEvent['type']; time: number; turnId?: number; stats?: TurnStats };

function EventCard({ message }: { message: Message }) {
  const [open, setOpen] = useState(message.event !== 'status');
  const labels: Record<string, string> = { tool_call: '工具调用', tool_result: '工具结果', approval: '等待授权', plan: '计划', status: '思考与活动', error: '错误', exit: '进程' };
  return <div className={`event-card ${message.event}`}><button onClick={() => setOpen(!open)}>{open ? <ChevronDown /> : <ChevronRight />}<Workflow /><b>{labels[message.event || ''] || 'Agent'}</b><time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></button>{open && <pre>{message.content}</pre>}</div>;
}

function statsFrom(event: AgentEvent): TurnStats {
  return { durationMs: Number(event.meta?.durationMs || 0), inputTokens: Number(event.meta?.inputTokens || 0), outputTokens: Number(event.meta?.outputTokens || 0), estimated: Boolean(event.meta?.estimated) };
}

function StatsFooter({ stats }: { stats: TurnStats }) {
  const seconds = Math.max(0.1, stats.durationMs / 1000).toFixed(stats.durationMs < 10_000 ? 1 : 0);
  const total = stats.inputTokens + stats.outputTokens;
  return <div className="response-stats" title={`输入 ${stats.inputTokens} · 输出 ${stats.outputTokens} tokens`}><span>用时 {seconds} 秒</span><span>{stats.estimated ? '约 ' : ''}{total.toLocaleString()} tokens</span></div>;
}

export default function Chat({ model, onModel, onEvent }: { model: string; onModel: (model: string) => void; onEvent: (event: AgentEvent) => void }) {
  const [messages, setMessages] = useState<Message[]>([{ id: 'welcome', role: 'assistant', content: '你好，我是 **Claude Code Studio**。\n\n`ccr code` 会自动在当前工作区启动。你可以直接输入任务，也可以从右侧 **Context** 注入网页、文件和图片。', time: Date.now() }]);
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const messagePane = useRef<HTMLDivElement>(null);
  const command = useMemo<'ccr code' | 'claude'>(() => model === 'Claude CLI' ? 'claude' : 'ccr code', [model]);
  const start = useCallback(async () => { if (starting) return; setStarting(true); try { await window.studio.agent.start(command); setRunning(true); } catch { setRunning(false); } finally { setStarting(false); } }, [command, starting]);

  useEffect(() => {
    const off = window.studio.agent.onEvent(event => {
      onEvent(event);
      const turnId = Number(event.meta?.turnId || 0) || undefined;
      if (event.type === 'status' && /ready|starting|input ready/i.test(event.content)) { setRunning(true); return; }
      if (event.meta?.turnDone) {
        setBusy(false);
        setMessages(current => {
          const reverseIndex = [...current].reverse().findIndex(message => message.role === 'assistant' && (!turnId || message.turnId === turnId));
          if (reverseIndex < 0) return current;
          const actualIndex = current.length - 1 - reverseIndex;
          return current.map((message, index) => index === actualIndex ? { ...message, stats: statsFrom(event) } : message);
        });
        return;
      }
      if (event.type === 'output') {
        setMessages(current => {
          const last = current[current.length - 1];
          if (last?.role === 'assistant' && (!turnId || last.turnId === turnId)) {
            const separator = event.meta?.append ? '' : '\n';
            return [...current.slice(0, -1), { ...last, content: `${last.content}${separator}${event.content}` }];
          }
          return [...current, { id: crypto.randomUUID(), role: 'assistant', content: event.content, time: event.timestamp, turnId }];
        });
        return;
      }
      if (event.type === 'status') {
        setMessages(current => {
          const lastUser = current.findLastIndex(message => message.role === 'user');
          const existing = current.findIndex((message, index) => index > lastUser && message.role === 'event' && message.event === 'status');
          if (existing >= 0) return current.map((message, index) => index === existing ? { ...message, content: event.content, time: event.timestamp, turnId: turnId || message.turnId } : message);
          return [...current, { id: crypto.randomUUID(), role: 'event', content: event.content, event: 'status', time: event.timestamp, turnId }];
        });
        return;
      }
      setMessages(current => [...current, { id: crypto.randomUUID(), role: 'event', content: event.content, event: event.meta?.failed ? 'error' : event.type, time: event.timestamp, turnId }]);
      if (event.type === 'exit' || event.type === 'error') { setRunning(false); setBusy(false); }
    });
    start(); return off;
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
  const interrupt = () => { window.studio.agent.input('\x03'); setBusy(false); };
  const attach = async () => { const paths = await window.studio.context.selectFiles(); if (paths.length) window.dispatchEvent(new CustomEvent('studio:files-selected', { detail: paths })); };

  return <main className="chat">
    <header className="chat-header"><div><span className="brand-mark">C</span><strong>Claude Code Studio</strong><span className={running ? 'live' : 'idle'}>{starting ? 'STARTING' : running ? 'RUNNING' : 'IDLE'}</span></div><div><select value={model} onChange={event => onModel(event.target.value)}><option>Claude Router</option><option>Claude CLI</option><option>GPT · Router</option><option>Gemini · Router</option><option>DeepSeek · Router</option><option>Qwen · Router</option><option>V4 Pro · Router</option></select>{running ? <button className="icon-btn" title="停止 Agent" onClick={() => { window.studio.agent.stop(); setRunning(false); setBusy(false); }}><Square /></button> : <button className="run-btn" disabled={starting} onClick={start}><Play />{starting ? 'Starting' : 'Start'}</button>}</div></header>
    <div className="messages-shell"><div className="messages" ref={messagePane}>{messages.map(message => message.role === 'event' ? <EventCard key={message.id} message={message} /> : <article key={message.id} className={`message ${message.role}`}><div className="avatar">{message.role === 'user' ? <User /> : <Bot />}</div><div><div className="message-meta">{message.role === 'user' ? 'You' : 'Claude'} <time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><div className="markdown"><Markdown>{message.content}</Markdown></div>{message.stats && <StatsFooter stats={message.stats} />}</div></article>)}{busy && <div className="thinking-indicator"><LoaderCircle /><span><b>Claude 正在处理</b><small>已运行 {elapsed} 秒 · 活动会实时显示</small></span></div>}</div><VerticalScrollRail target={messagePane} /></div>
    <div className="composer-wrap"><div className="composer"><textarea value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="直接输入任务，或从 Context Manager 注入网页、文件和图片…" /><div className="composer-actions"><div><button title="添加文件" onClick={attach}><Paperclip /></button><button title="添加图片" onClick={attach}><Image /></button><span>Plan mode</span></div>{busy ? <button className="stop-response" onClick={interrupt}><Square />停止回复</button> : <button className="send" onClick={submit}><Send /></button>}</div></div><div className="hint">Enter 发送 · Shift+Enter 换行 · Agent 自动连接 ccr code</div></div>
  </main>;
}
