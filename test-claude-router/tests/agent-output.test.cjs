const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateVisibleTokens, extractActivity, extractClaudeReply, extractUsage, hasTurnEndMarker, isTerminalNoise, normalizeTerminalText } = require('../dist-electron/agent-output.js');

test('extracts only the final reply from a redrawn Claude terminal row', () => {
  const raw = 'esc to interrupt\rAuto-updating...\rThought for 1s (ctrl+o to expand) claude: ok Baked for 1s Auto-updating... input:';
  const normalized = normalizeTerminalText(raw);
  assert.equal(extractClaudeReply(normalized), 'ok');
  assert.equal(extractActivity(normalized), '思考 1 秒');
  assert.equal(extractUsage(normalized).durationMs, 1000);
});

test('filters terminal chrome and reads explicit usage when available', () => {
  assert.equal(isTerminalNoise('Auto-updating... input:'), true);
  assert.deepEqual(extractUsage('input tokens: 1,024 output tokens: 12'), { inputTokens: 1024, outputTokens: 12 });
  assert.ok(estimateVisibleTokens('ok') > 0);
});

test('finishes on a redrawn input prompt and strips interrupt chrome', () => {
  const completed = 'Thought for 1s claude: ok input:Composing... (0s thinking)';
  assert.equal(hasTurnEndMarker(completed), true);
  assert.equal(extractClaudeReply(completed), 'ok');
  assert.equal(isTerminalNoise('Composing...'), true);
  assert.equal(isTerminalNoise('ok input:Press Ctrl-C again to exit input:input:'), true);
});
