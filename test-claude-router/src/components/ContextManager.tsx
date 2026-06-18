import { useEffect, useMemo, useState } from 'react';
import { Copy, Eye, FilePlus2, Globe2, Image as ImageIcon, Search, Sparkles, Trash2, Upload, WandSparkles, X } from 'lucide-react';

type Mode = 'full' | 'summary' | 'key-points';
type Injected = { id: string; label: string; tokens: number };
const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 3.6));
const summarize = (text: string, mode: Mode) => {
  if (mode === 'full' || text.length < 1800) return text;
  const paragraphs = text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
  if (mode === 'summary') return paragraphs.slice(0, 8).join('\n\n').slice(0, 5000);
  const sentences = text.split(/(?<=[。！？.!?])\s+/).map(value => value.trim()).filter(value => value.length > 20);
  return sentences.slice(0, 12).map(value => `- ${value}`).join('\n').slice(0, 5000);
};
const chunks = (text: string, size = 12000) => {
  const values: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) values.push(text.slice(offset, offset + size));
  return values;
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function ContextManager() {
  const [items, setItems] = useState<ParsedContext[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('tavily');
  const [searxng, setSearxng] = useState('http://localhost:8080');
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<Mode>('full');
  const [preview, setPreview] = useState<{ title: string; content: string; itemId?: string }>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [injected, setInjected] = useState<Injected[]>([]);
  const [ocrEngine, setOcrEngine] = useState('tesseract');
  const [visionModel, setVisionModel] = useState('gemini');
  const totalTokens = useMemo(() => injected.reduce((sum, item) => sum + item.tokens, 0), [injected]);

  const addPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy('正在解析文件…'); setError('');
    try { const parsed = await window.studio.context.parseFiles(paths); setItems(current => [...current, ...parsed]); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(''); }
  };
  const chooseFiles = async () => addPaths(await window.studio.context.selectFiles());
  useEffect(() => { const handler = (event: Event) => addPaths((event as CustomEvent<string[]>).detail); window.addEventListener('studio:files-selected', handler); return () => window.removeEventListener('studio:files-selected', handler); }, []);
  const runSearch = async () => {
    setBusy('正在搜索真实 API…'); setError('');
    try { const value = await window.studio.context.search(provider, query, provider === 'searxng' ? searxng : undefined); setResults(value); setSelected(new Set()); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(''); }
  };
  const fetchUrl = async () => {
    setBusy('正在提取网页正文…'); setError('');
    try { const item = await window.studio.context.readUrl(url); setItems(current => [...current, item]); setPreview({ title: item.name, content: item.preview }); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(''); }
  };
  const updateItem = (next: ParsedContext) => setItems(current => current.map(item => item.id === next.id ? next : item));
  const runOcr = async (item: ParsedContext) => {
    if (ocrEngine !== 'tesseract' && !confirm(`将把图片发送给 ${ocrEngine} 云端服务进行 OCR。是否继续？`)) return;
    setBusy(`正在使用 ${ocrEngine} 识别…`); setError('');
    try { const next = await window.studio.context.ocr(item.id, ocrEngine); updateItem(next); setPreview({ title: `${item.name} · OCR`, content: next.content, itemId: item.id }); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(''); }
  };
  const runVision = async (item: ParsedContext) => {
    if (!confirm(`视觉分析会把图片发送给 ${visionModel}。是否继续？`)) return;
    setBusy(`正在使用 ${visionModel} 分析…`); setError('');
    try { const next = await window.studio.context.vision(item.id, visionModel); updateItem(next); setPreview({ title: `${item.name} · 视觉分析`, content: next.content, itemId: item.id }); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(''); }
  };
  const inject = async (label: 'Web Context' | 'File Context' | 'Image OCR Context' | 'Image Vision Context', source: string, name: string, raw: string, engine?: string) => {
    const content = summarize(raw, mode);
    const formatted = await window.studio.context.format(label, source, name, content, engine);
    const tokens = estimateTokens(formatted);
    if (!confirm(`预计注入 ${tokens.toLocaleString()} tokens（${mode} 模式）。确认发送到当前 Claude Code 会话？`)) return;
    const parts = chunks(formatted);
    parts.forEach((part, index) => window.studio.agent.input(`${parts.length > 1 ? `[Chunk ${index + 1}/${parts.length}]\n` : ''}${part}\r`));
    window.dispatchEvent(new CustomEvent('studio:injected', { detail: { label: name, content: formatted } }));
    setInjected(current => [...current, { id: crypto.randomUUID(), label: name, tokens }]);
  };
  const injectSearch = async () => {
    const chosen = results.filter((_, index) => selected.has(index));
    if (!chosen.length) return;
    const markdown = chosen.map((item, index) => `## ${index + 1}. ${item.title}\n- URL: ${item.url}\n- 来源: ${item.source}\n- 时间: ${item.publishedAt || '未知'}\n\n${item.snippet}`).join('\n\n');
    await inject('Web Context', `Search: ${query}`, `搜索结果：${query}`, markdown);
  };

  return <div className="context-manager" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addPaths([...event.dataTransfer.files].map(file => window.studio.context.pathForFile(file)).filter(Boolean)); }}>
    <div className="context-toolbar"><select value={mode} onChange={event => setMode(event.target.value as Mode)}><option value="full">full</option><option value="summary">summary</option><option value="key-points">key-points</option></select><span>已注入约 {totalTokens.toLocaleString()} tokens</span></div>
    <section className="context-section"><h3><FilePlus2 /> FILES & IMAGES</h3><button className="drop-zone" onClick={chooseFiles}><Upload />拖拽或选择多个文件</button>
      <div className="adapter-row"><select value={ocrEngine} onChange={event => setOcrEngine(event.target.value)}><option value="tesseract">Tesseract（本地）</option><option value="openai">OpenAI Vision OCR</option><option value="gemini">Gemini Vision OCR</option><option value="claude">Claude Vision OCR</option><option value="qwen">Qwen-VL OCR</option><option value="ocrspace">OCR.Space</option><option value="baidu">百度 OCR</option><option value="volcano">火山 OCR</option></select><select value={visionModel} onChange={event => setVisionModel(event.target.value)}><option value="gemini">Gemini Vision</option><option value="openai">OpenAI Vision</option><option value="claude">Claude Vision</option><option value="qwen">Qwen-VL</option></select></div>
      {items.map(item => <div className="context-item" key={item.id}>{item.thumbnail ? <img src={item.thumbnail} /> : item.kind === 'url' ? <Globe2 /> : <FilePlus2 />}<div><b>{item.name}</b><small>{item.kind} · ~{estimateTokens(item.content)} tokens</small></div><div className="item-actions"><button title="预览" onClick={() => setPreview({ title: item.name, content: item.preview, itemId: item.id })}><Eye /></button><button title="摘要预览" disabled={!item.content} onClick={() => setPreview({ title: `${item.name} · ${mode}`, content: summarize(item.content, mode), itemId: item.id })}><Sparkles /></button><button title="复制" onClick={() => navigator.clipboard.writeText(item.content)}><Copy /></button>{item.kind === 'image' && <><button title="OCR识别" onClick={() => runOcr(item)}><WandSparkles /></button><button title="视觉分析" onClick={() => runVision(item)}><ImageIcon /></button></>}<button title="注入" disabled={!item.content} onClick={() => inject(item.kind === 'url' ? 'Web Context' : item.kind === 'image' && item.analysisKind === 'vision' ? 'Image Vision Context' : item.kind === 'image' ? 'Image OCR Context' : 'File Context', item.source, item.name, item.content, item.engine)}><Upload /></button><button title="移除" onClick={() => setItems(current => current.filter(value => value.id !== item.id))}><X /></button></div></div>)}
    </section>
    <section className="context-section"><h3><Search /> WEB SEARCH</h3><div className="context-input"><select value={provider} onChange={event => setProvider(event.target.value)}><option value="tavily">Tavily</option><option value="brave">Brave</option><option value="serpapi">SerpAPI</option><option value="bing">Bing</option><option value="searxng">SearXNG</option></select><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索关键词" onKeyDown={event => event.key === 'Enter' && runSearch()} /><button onClick={runSearch}><Search /></button></div>{provider === 'searxng' && <input className="wide-input" value={searxng} onChange={event => setSearxng(event.target.value)} placeholder="SearXNG 地址" />}
      {results.map((result, index) => <label className="search-result" key={`${result.url}-${index}`}><input type="checkbox" checked={selected.has(index)} onChange={() => setSelected(current => { const next = new Set(current); next.has(index) ? next.delete(index) : next.add(index); return next; })} /><span><b>{result.title}</b><small>{result.source} · {result.publishedAt || '时间未知'}</small><p>{result.snippet}</p></span></label>)}{results.length > 0 && <button className="primary-action" onClick={injectSearch}>注入已选结果（{selected.size}）</button>}
    </section>
    <section className="context-section"><h3><Globe2 /> URLS</h3><div className="context-input"><input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" onKeyDown={event => event.key === 'Enter' && fetchUrl()} /><button onClick={fetchUrl}><Globe2 /></button></div></section>
    <section className="context-section"><h3><Upload /> INJECTED CONTEXT</h3>{injected.map(item => <div className="injected-row" key={item.id}><span>{item.label}</span><small>{item.tokens} tokens</small></div>)}<div className="danger-actions"><button onClick={() => { if (confirm('清空当前 Claude Code 会话上下文？')) { window.studio.agent.input('/clear\r'); setInjected([]); } }}>清空会话上下文</button><button onClick={async () => { if (confirm('删除本地解析缓存？')) { await window.studio.context.clearCache(); setItems([]); } }}><Trash2 />删除缓存</button></div></section>
    {busy && <div className="context-status">{busy}</div>}{error && <div className="context-error">{error}</div>}
    {preview && <div className="preview-pop"><header><b>{preview.title}</b><button onClick={() => setPreview(undefined)}><X /></button></header><textarea value={preview.content} onChange={event => { const content = event.target.value; setPreview({ ...preview, content }); if (preview.itemId) setItems(current => current.map(item => item.id === preview.itemId ? { ...item, content, preview: content.slice(0, 6000) } : item)); }} /></div>}
  </div>;
}
