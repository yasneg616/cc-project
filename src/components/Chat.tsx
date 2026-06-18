import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Image, Paperclip, Play, Send, Square, User, Workflow } from 'lucide-react';
import Markdown from './Markdown';

type Message = { id: string; role: 'user' | 'assistant' | 'event'; content: string; event?: AgentEvent['type']; time: number };
function EventCard({ message }: { message: Message }) {
  const [open, setOpen] = useState(true);
  const labels: Record<string, string> = { tool_call: 'Tool Call', tool_result: 'Tool Result', approval: 'Approval Request', plan: 'Plan', status: 'Status', error: 'Error', exit: 'Process' };
  return <div className={`event-card ${message.event}`}><button onClick={() => setOpen(!open)}>{open ? <ChevronDown /> : <ChevronRight />}<Workflow /><b>{labels[message.event || ''] || 'Agent'}</b><time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></button>{open && <pre>{message.content}</pre>}</div>;
}
export default function Chat({ model, onModel, onEvent }: { model: string; onModel: (model: string) => void; onEvent: (event: AgentEvent) => void }) {
  const [messages, setMessages] = useState<Message[]>([{ id: 'welcome', role: 'assistant', content: '你好，我是 **Claude Code Studio**。\n\n`ccr code` 会自动在当前工作区启动。你可以直接输入任务，终端输出、工具调用、计划和审批请求会在这里显示。', time: Date.now() }]);
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const command = useMemo<'ccr code' | 'claude'>(() => model === 'Claude CLI' ? 'claude' : 'ccr code', [model]);
  const start = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try { await window.studio.agent.start(command); setRunning(true); }
    catch { setRunning(false); }
    finally { setStarting(false); }
  }, [command, starting]);

  useEffect(() => {
    const off = window.studio.agent.onEvent(event => {
      onEvent(event);
      if (event.type === 'output') {
        setMessages(current => {
          const last = current[current.length - 1];
          if (last?.role === 'assistant') return [...current.slice(0, -1), { ...last, content: `${last.content}\n${event.content}` }];
          return [...current, { id: crypto.randomUUID(), role: 'assistant', content: event.content, time: event.timestamp }];
        });
      } else {
        setMessages(current => [...current, { id: crypto.randomUUID(), role: 'event', content: event.content, event: event.type, time: event.timestamp }]);
      }
      if (event.type === 'exit' || (event.type === 'error' && /exited|unable to start/i.test(event.content))) setRunning(false);
      if (event.type === 'status' && /ready|starting/i.test(event.content)) setRunning(true);
    });
    start();
    return () => off();
  }, [command]);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  const submit = async () => {
    const prompt = text.trim();
    if (!prompt) return;
    setMessages(current => [...current, { id: crypto.randomUUID(), role: 'user', content: prompt, time: Date.now() }]);
    setText('');
    if (!running) await start();
    window.studio.agent.input(`${prompt}\r`);
  };
  return <main className="chat"><header className="chat-header"><div><span className="brand-mark">C</span><strong>Claude Code Studio</strong><span className={running ? 'live' : 'idle'}>{starting ? 'STARTING' : running ? 'RUNNING' : 'IDLE'}</span></div><div><select value={model} onChange={event => onModel(event.target.value)}><option>Claude Router</option><option>Claude CLI</option><option>GPT · Router</option><option>Gemini · Router</option><option>DeepSeek · Router</option><option>Qwen · Router</option></select>{running ? <button className="icon-btn" title="停止 Agent" onClick={() => { window.studio.agent.stop(); setRunning(false); }}><Square /></button> : <button className="run-btn" disabled={starting} onClick={start}><Play />{starting ? 'Starting' : 'Start'}</button>}</div></header><div className="messages">{messages.map(message => message.role === 'event' ? <EventCard key={message.id} message={message} /> : <article key={message.id} className={`message ${message.role}`}><div className="avatar">{message.role === 'user' ? <User /> : <Bot />}</div><div><div className="message-meta">{message.role === 'user' ? 'You' : 'Claude'} <time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><div className="markdown"><Markdown>{message.content}</Markdown></div></div></article>)}<div ref={end} /></div><div className="composer-wrap"><div className="composer"><textarea value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} onPaste={event => { if ([...event.clipboardData.items].some(item => item.type.startsWith('image/'))) setText(value => `${value}\n@image(clipboard)`); }} placeholder="直接输入任务，Claude Router 会自动接收…  @ 文件，/ 命令" /><div className="composer-actions"><div><button title="添加文件"><Paperclip /></button><button title="添加图片"><Image /></button><span>Plan mode</span></div><button className="send" onClick={submit}><Send /></button></div></div><div className="hint">Enter 发送 · Shift+Enter 换行 · Agent 已自动连接 ccr code</div></div></main>;
}
