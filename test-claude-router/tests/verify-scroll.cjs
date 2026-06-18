const WebSocket = require('ws');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const [target] = await (await fetch('http://127.0.0.1:9222/json')).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let id = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };

  const initial = await evaluate(`(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { viewport: [innerWidth, innerHeight], workbench: rect('.workbench'), center: rect('.center'), chat: rect('.chat'), messages: rect('.messages'), composer: rect('.composer-wrap'), terminal: rect('.terminal-panel') };
  })()`);

  await evaluate(`(() => {
    const pane = document.querySelector('.messages');
    for (let index = 0; index < 80; index += 1) {
      const item = document.createElement('article');
      item.className = 'message assistant';
      item.innerHTML = '<div class="avatar">C</div><div class="markdown">Scroll verification row ' + index + '<br>second line</div>';
      pane.appendChild(item);
    }
  })()`);
  await delay(150);

  const beforeDrag = await evaluate(`(() => {
    const pane = document.querySelector('.messages');
    const thumb = document.querySelector('.messages-shell .vertical-scroll-thumb').getBoundingClientRect();
    const track = document.querySelector('.messages-shell .vertical-scroll-track').getBoundingClientRect();
    return { scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight, thumb: thumb.toJSON(), track: track.toJSON() };
  })()`);
  const startX = beforeDrag.thumb.x + beforeDrag.thumb.width / 2;
  const startY = beforeDrag.thumb.y + beforeDrag.thumb.height / 2;
  const endY = beforeDrag.track.bottom - beforeDrag.thumb.height / 2 - 2;
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: (startY + endY) / 2, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: endY, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX, y: endY, button: 'left', buttons: 0, clickCount: 1 });
  await delay(100);
  const afterDrag = await evaluate(`(() => { const pane = document.querySelector('.messages'); return { scrollTop: pane.scrollTop, maxScroll: pane.scrollHeight - pane.clientHeight }; })()`);
  socket.close();

  const layoutFits = initial.center.bottom <= initial.workbench.bottom + 1 && initial.composer.bottom <= initial.terminal.top + 1 && initial.terminal.bottom <= initial.viewport[1] + 1;
  const dragWorks = afterDrag.scrollTop > beforeDrag.scrollTop && afterDrag.scrollTop >= afterDrag.maxScroll * 0.9;
  console.log(JSON.stringify({ layoutFits, dragWorks, initial, beforeDrag, afterDrag }, null, 2));
  if (!layoutFits || !dragWorks) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
