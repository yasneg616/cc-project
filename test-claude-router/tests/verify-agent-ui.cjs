const WebSocket = require('ws');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const [target] = await (await fetch('http://127.0.0.1:9222/json')).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id); pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };

  const existingStop = await evaluate(`document.querySelector('.stop-response')?.getBoundingClientRect().toJSON() || null`);
  if (existingStop) {
    const x = existingStop.x + existingStop.width / 2, y = existingStop.y + existingStop.height / 2;
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await delay(300);
  }
  const textarea = await evaluate(`document.querySelector('.composer textarea').getBoundingClientRect().toJSON()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: textarea.x + 50, y: textarea.y + 25, button: 'left', buttons: 1, clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: textarea.x + 50, y: textarea.y + 25, button: 'left', buttons: 0, clickCount: 1 });
  await call('Input.insertText', { text: '只回复 OK，不读取或修改任何文件。' });
  const submittedAt = Date.now();
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await delay(300);
  const immediate = await evaluate(`({ stopVisible: !!document.querySelector('.stop-response'), thinkingVisible: !!document.querySelector('.thinking-indicator'), thinkingText: document.querySelector('.thinking-indicator')?.textContent || '' })`);
  let streamed;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    streamed = await evaluate(`(() => { const messages = [...document.querySelectorAll('.message.assistant .markdown')]; return messages.at(-1)?.textContent || ''; })()`);
    if (/(?:^|\n)\s*(?:claude:\s*)?OK[.!。]?\s*(?:$|\n)/i.test(streamed)) break;
    await delay(250);
  }
  await delay(1300);
  const completed = await evaluate(`({ stopVisible: !!document.querySelector('.stop-response'), sendVisible: !!document.querySelector('.send') })`);
  const result = { immediate, completed, firstReplyWithinMs: Date.now() - submittedAt, streamed: String(streamed || '').slice(-500) };
  console.log(JSON.stringify(result, null, 2));
  socket.close();
  if (!immediate.stopVisible || !immediate.thinkingVisible || completed.stopVisible || !completed.sendVisible || !/(?:^|\n)\s*(?:claude:\s*)?OK[.!。]?\s*(?:$|\n)/i.test(result.streamed)) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
