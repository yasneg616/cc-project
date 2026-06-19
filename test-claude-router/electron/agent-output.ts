export type AgentUsage = {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
};

const STOP_MARKERS = /\s+(?:(?:baked|worked|thought)\s+for\b|auto-updating\b|esc to interrupt\b|input:|press ctrl-c again to exit\b|composing\.{0,3})/i;

export function normalizeTerminalText(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

export function extractClaudeReply(value: string) {
  const match = value.match(/(?:^|\s)claude:\s*([\s\S]*)/i);
  if (!match) return '';
  const stop = match[1].search(STOP_MARKERS);
  return (stop < 0 ? match[1] : match[1].slice(0, stop)).trim();
}

export function extractActivity(value: string) {
  const thought = value.match(/thought for\s+(\d+(?:\.\d+)?)\s*(ms|s|sec(?:ond)?s?|m|min(?:ute)?s?)/i);
  if (thought) return `思考 ${thought[1]} ${/^m(?!s)/i.test(thought[2]) ? '分钟' : /^ms$/i.test(thought[2]) ? '毫秒' : '秒'}`;
  if (/tool (?:use|call)|calling tool/i.test(value)) return '正在调用工具';
  if (/searching/i.test(value)) return '正在搜索';
  if (/reading/i.test(value)) return '正在读取';
  if (/writing|editing/i.test(value)) return '正在编辑';
  if (/running|executing|testing/i.test(value)) return '正在运行';
  if (/combobulating|thinking|composing/i.test(value)) return '正在思考';
  return '';
}

export function extractUsage(value: string): AgentUsage {
  const usage: AgentUsage = {};
  const duration = value.match(/(?:baked|worked|thought) for\s+(\d+(?:\.\d+)?)\s*(ms|s|sec(?:ond)?s?|m|min(?:ute)?s?)/i);
  if (duration) {
    const amount = Number(duration[1]);
    usage.durationMs = /^ms$/i.test(duration[2]) ? amount : /^m(?!s)/i.test(duration[2]) ? amount * 60_000 : amount * 1000;
  }
  const input = value.match(/(?:input|prompt)\s*(?:tokens?)?\s*[:=]?\s*([\d,]+)\s*(?:tokens?)?/i);
  const output = value.match(/(?:output|completion)\s*(?:tokens?)?\s*[:=]?\s*([\d,]+)\s*(?:tokens?)?/i);
  if (input) usage.inputTokens = Number(input[1].replace(/,/g, ''));
  if (output) usage.outputTokens = Number(output[1].replace(/,/g, ''));
  return usage;
}

export function estimateVisibleTokens(value: string) {
  let units = 0;
  for (const char of value.trim()) units += /[\u3400-\u9fff\uf900-\ufaff]/.test(char) ? 1 : 0.25;
  return Math.max(1, Math.ceil(units));
}

export function isTerminalNoise(value: string) {
  const text = value.trim();
  if (!text) return true;
  return /^(?:input:|auto-updating.*|esc to interrupt.*|combobulating.*|composing\.{0,3}.*)$/i.test(text)
    || /(?:thought|worked|baked) for\s+\d/i.test(text)
    || /auto-updating|esc to interrupt|press ctrl-c again to exit/i.test(text);
}

export function hasTurnEndMarker(value: string) {
  return /\binput:/i.test(value);
}
