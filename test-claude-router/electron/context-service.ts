import fs from 'node:fs/promises';
import path from 'node:path';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import mammoth from 'mammoth';
import Papa from 'papaparse';
import { PDFParse } from 'pdf-parse';
import { recognize } from 'tesseract.js';
import * as XLSX from 'xlsx';

export type SearchProvider = 'tavily' | 'brave' | 'serpapi' | 'bing' | 'searxng';
export type SearchResult = { title: string; url: string; snippet: string; source: string; publishedAt?: string };
export type ParsedContext = { id: string; kind: 'file' | 'image' | 'url'; name: string; source: string; content: string; preview: string; mime?: string; thumbnail?: string; analysisKind?: 'ocr' | 'vision'; engine?: string };

const MAX_DOWNLOAD = 25 * 1024 * 1024;
const textExtensions = new Set(['.txt', '.md', '.js', '.ts', '.py', '.cpp', '.c', '.h', '.java', '.json', '.yaml', '.yml']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const preview = (value: string) => value.replace(/\u0000/g, '').slice(0, 6000);
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
};
const sourceName = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Web'; }
};
const normalizeDate = (value: unknown) => typeof value === 'string' ? value : undefined;

export async function webSearch(provider: SearchProvider, query: string, searxngUrl?: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  if (provider === 'tavily') {
    const response = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: required('TAVILY_API_KEY'), query, search_depth: 'advanced', max_results: 10, include_answer: false }) });
    if (!response.ok) throw new Error(`Tavily 搜索失败 (${response.status})`);
    const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
    return (data.results || []).map(item => ({ title: item.title || item.url || 'Untitled', url: item.url || '', snippet: item.content || '', source: sourceName(item.url || ''), publishedAt: item.published_date }));
  }
  if (provider === 'brave') {
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, { headers: { Accept: 'application/json', 'X-Subscription-Token': required('BRAVE_API_KEY') } });
    if (!response.ok) throw new Error(`Brave Search 失败 (${response.status})`);
    const data = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string; profile?: { long_name?: string }; age?: string }> } };
    return (data.web?.results || []).map(item => ({ title: item.title || item.url || 'Untitled', url: item.url || '', snippet: item.description || '', source: item.profile?.long_name || sourceName(item.url || ''), publishedAt: item.age }));
  }
  if (provider === 'serpapi') {
    const response = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(required('SERPAPI_API_KEY'))}`);
    if (!response.ok) throw new Error(`SerpAPI 搜索失败 (${response.status})`);
    const data = await response.json() as { organic_results?: Array<{ title?: string; link?: string; snippet?: string; source?: string; date?: string }> };
    return (data.organic_results || []).map(item => ({ title: item.title || item.link || 'Untitled', url: item.link || '', snippet: item.snippet || '', source: item.source || sourceName(item.link || ''), publishedAt: item.date }));
  }
  if (provider === 'bing') {
    const response = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=10&responseFilter=Webpages`, { headers: { 'Ocp-Apim-Subscription-Key': required('BING_SEARCH_API_KEY') } });
    if (!response.ok) throw new Error(`Bing Web Search 失败 (${response.status})`);
    const data = await response.json() as { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string; dateLastCrawled?: string }> } };
    return (data.webPages?.value || []).map(item => ({ title: item.name || item.url || 'Untitled', url: item.url || '', snippet: item.snippet || '', source: sourceName(item.url || ''), publishedAt: item.dateLastCrawled }));
  }
  const base = (searxngUrl || process.env.SEARXNG_URL || 'http://localhost:8080').replace(/\/$/, '');
  const response = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`);
  if (!response.ok) throw new Error(`SearXNG 搜索失败 (${response.status})`);
  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string; engine?: string; publishedDate?: string }> };
  return (data.results || []).slice(0, 10).map(item => ({ title: item.title || item.url || 'Untitled', url: item.url || '', snippet: item.content || '', source: item.engine || sourceName(item.url || ''), publishedAt: item.publishedDate }));
}

async function parsePdf(buffer: Buffer, first = 2) {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText({ first, parseHyperlinks: true })).text; }
  finally { await parser.destroy(); }
}

export async function readUrl(rawUrl: string): Promise<ParsedContext> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP/HTTPS URL');
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Claude-Code-Studio/0.2' } });
  if (!response.ok) throw new Error(`网页抓取失败 (${response.status})`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_DOWNLOAD) throw new Error('网页或 PDF 超过 25 MB 限制');
  const type = response.headers.get('content-type') || '';
  if (type.includes('pdf') || url.pathname.toLowerCase().endsWith('.pdf')) {
    const content = await parsePdf(Buffer.from(await response.arrayBuffer()), 2);
    return { id: id(), kind: 'url', name: path.basename(url.pathname) || 'document.pdf', source: url.href, content, preview: preview(content), mime: 'application/pdf' };
  }
  const html = await response.text();
  const dom = new JSDOM(html, { url: response.url || url.href });
  const article = new Readability(dom.window.document).parse();
  const title = article?.title || dom.window.document.title || url.hostname;
  const content = article?.textContent?.trim() || dom.window.document.body?.textContent?.trim() || '';
  return { id: id(), kind: 'url', name: title, source: url.href, content, preview: preview(content), mime: type };
}

const markdownTable = (rows: unknown[][]) => {
  if (!rows.length) return '';
  const width = Math.max(...rows.map(row => row.length));
  const clean = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const normalized = rows.map(row => Array.from({ length: width }, (_, index) => clean(row[index])));
  return [`| ${normalized[0].join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...normalized.slice(1).map(row => `| ${row.join(' | ')} |`)].join('\n');
};

export async function parseFile(filePath: string): Promise<ParsedContext> {
  const extension = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_DOWNLOAD) throw new Error(`${name} 超过 25 MB 限制`);
  if (imageExtensions.has(extension)) {
    const buffer = await fs.readFile(filePath);
    const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : `image/${extension.slice(1)}`;
    return { id: id(), kind: 'image', name, source: filePath, content: '', preview: '等待 OCR 或视觉分析', mime, thumbnail: `data:${mime};base64,${buffer.toString('base64')}` };
  }
  let content = '';
  if (textExtensions.has(extension)) content = await fs.readFile(filePath, 'utf8');
  else if (extension === '.pdf') content = await parsePdf(await fs.readFile(filePath), 2);
  else if (extension === '.docx') content = (await mammoth.extractRawText({ path: filePath })).value;
  else if (extension === '.xlsx') {
    const workbook = XLSX.readFile(filePath);
    content = workbook.SheetNames.map(sheetName => {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: false });
      return `## ${sheetName}\n\n${markdownTable(rows)}`;
    }).join('\n\n');
  } else if (extension === '.csv') {
    const result = Papa.parse<string[]>(await fs.readFile(filePath, 'utf8'), { skipEmptyLines: true });
    if (result.errors.length) throw new Error(result.errors[0].message);
    content = markdownTable(result.data);
  } else throw new Error(`不支持的文件类型：${extension || 'unknown'}`);
  return { id: id(), kind: 'file', name, source: filePath, content, preview: preview(content) };
}

export async function localOcr(filePath: string, language = 'eng+chi_sim') {
  const result = await recognize(filePath, language, { logger: () => undefined });
  return result.data.text.trim();
}

export async function cloudOcr(filePath: string, engine: string) {
  if (['openai', 'gemini', 'claude', 'qwen'].includes(engine)) return cloudVision(filePath, engine as 'openai' | 'gemini' | 'claude' | 'qwen', 'ocr');
  const image = await fs.readFile(filePath);
  if (engine === 'ocrspace') {
    const form = new FormData(); form.set('apikey', required('OCRSPACE_API_KEY')); form.set('language', 'chs'); form.set('isOverlayRequired', 'false'); form.set('base64Image', `data:image/png;base64,${image.toString('base64')}`);
    const response = await fetch(process.env.OCRSPACE_ENDPOINT || 'https://api.ocr.space/parse/image', { method: 'POST', body: form });
    if (!response.ok) throw new Error(`OCR.Space 失败 (${response.status})`);
    const body = await response.json() as { ParsedResults?: Array<{ ParsedText?: string }>; ErrorMessage?: string[] };
    if (!body.ParsedResults?.length) throw new Error(body.ErrorMessage?.join('; ') || 'OCR.Space 未返回结果');
    return body.ParsedResults.map(result => result.ParsedText || '').join('\n').trim();
  }
  if (engine === 'baidu') {
    const tokenResponse = await fetch(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(required('BAIDU_OCR_API_KEY'))}&client_secret=${encodeURIComponent(required('BAIDU_OCR_SECRET_KEY'))}`, { method: 'POST' });
    const tokenBody = await tokenResponse.json() as { access_token?: string }; if (!tokenBody.access_token) throw new Error('百度 OCR 获取 access token 失败');
    const body = new URLSearchParams({ image: image.toString('base64'), paragraph: 'true' });
    const response = await fetch(`https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=${encodeURIComponent(tokenBody.access_token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw new Error(`百度 OCR 失败 (${response.status})`);
    const result = await response.json() as { words_result?: Array<{ words?: string }>; error_msg?: string }; if (result.error_msg) throw new Error(result.error_msg);
    return (result.words_result || []).map(row => row.words || '').join('\n');
  }
  const endpoint = required('VOLCANO_OCR_ENDPOINT'); const token = required('VOLCANO_OCR_TOKEN');
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ image_base64: image.toString('base64') }) });
  if (!response.ok) throw new Error(`火山 OCR 失败 (${response.status})`);
  const result = await response.json() as { text?: string; data?: { text?: string; lines?: Array<{ text?: string }> } };
  return result.text || result.data?.text || result.data?.lines?.map(line => line.text || '').join('\n') || '';
}

const visionPrompt = (mode: 'ocr' | 'vision') => mode === 'ocr'
  ? 'Extract all visible text faithfully. Preserve reading order and line breaks. Return only the extracted text.'
  : 'Analyze this image in detail. Cover: content description, UI layout, tables/charts, key text, and possible problems. Use concise Markdown.';

export async function cloudVision(filePath: string, provider: 'openai' | 'gemini' | 'claude' | 'qwen', mode: 'ocr' | 'vision') {
  const buffer = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : `image/${extension.slice(1)}`;
  const data = buffer.toString('base64');
  const prompt = visionPrompt(mode);
  if (provider === 'openai' || provider === 'qwen') {
    const isQwen = provider === 'qwen';
    const endpoint = isQwen ? (process.env.QWEN_VISION_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions') : (process.env.OPENAI_VISION_ENDPOINT || 'https://api.openai.com/v1/chat/completions');
    const key = required(isQwen ? 'DASHSCOPE_API_KEY' : 'OPENAI_API_KEY');
    const model = isQwen ? (process.env.QWEN_VISION_MODEL || 'qwen-vl-max') : (process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini');
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }] }] }) });
    if (!response.ok) throw new Error(`${provider} Vision 失败 (${response.status})`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content || '';
  }
  if (provider === 'gemini') {
    const model = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(required('GEMINI_API_KEY'))}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }] }) });
    if (!response.ok) throw new Error(`Gemini Vision 失败 (${response.status})`);
    const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return body.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': required('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.CLAUDE_VISION_MODEL || 'claude-sonnet-4-20250514', max_tokens: 2048, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data } }, { type: 'text', text: prompt }] }] }) });
  if (!response.ok) throw new Error(`Claude Vision 失败 (${response.status})`);
  const body = await response.json() as { content?: Array<{ text?: string }> };
  return body.content?.map(part => part.text || '').join('') || '';
}

export function formatContext(label: 'Web Context' | 'File Context' | 'Image OCR Context' | 'Image Vision Context', source: string, name: string, content: string, engine?: string) {
  const sourceLabel = label === 'Web Context' ? `Source: ${source}\nTitle: ${name}` : `File: ${name}${engine ? `\n${label === 'Image OCR Context' ? 'OCR Engine' : 'Vision Model'}: ${engine}` : `\nSource: ${source}`}`;
  const contentLabel = label === 'Image OCR Context' ? 'Text' : label === 'Image Vision Context' ? 'Description' : 'Content';
  return `[${label}]\n${sourceLabel}\n${contentLabel}:\n${content}\n[/${label}]`;
}
