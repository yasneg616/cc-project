import { contextBridge, ipcRenderer, webUtils } from 'electron';
const on = (channel: string, cb: (data: any) => void) => { const handler = (_event: unknown, data: any) => cb(data); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };
contextBridge.exposeInMainWorld('studio', {
  workspace: { open: () => ipcRenderer.invoke('workspace:open'), get: () => ipcRenderer.invoke('workspace:get'), onChanged: (cb: (path: string) => void) => on('workspace:changed', cb) },
  fs: { read: (path: string) => ipcRenderer.invoke('fs:read', path), create: (path: string, type: 'file' | 'directory') => ipcRenderer.invoke('fs:create', path, type), delete: (path: string) => ipcRenderer.invoke('fs:delete', path), reveal: (path: string) => ipcRenderer.invoke('fs:reveal', path), menu: (path: string) => ipcRenderer.invoke('fs:menu', path) },
  git: { info: () => ipcRenderer.invoke('git:info'), command: (action: string, value?: string) => ipcRenderer.invoke('git:command', action, value) },
  terminal: { create: (id: string) => ipcRenderer.invoke('terminal:create', id), input: (id: string, data: string) => ipcRenderer.send('terminal:input', { id, data }), resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id, cols, rows }), kill: (id: string) => ipcRenderer.invoke('terminal:kill', id), onData: (cb: (value: any) => void) => on('terminal:data', cb) },
  agent: { start: (command: 'ccr code' | 'claude') => ipcRenderer.invoke('agent:start', command), input: (text: string) => ipcRenderer.send('agent:input', text), stop: () => ipcRenderer.invoke('agent:stop'), onEvent: (cb: (value: any) => void) => on('agent:event', cb) },
  context: {
    selectFiles: () => ipcRenderer.invoke('context:select-files'),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    parseFiles: (paths: string[]) => ipcRenderer.invoke('context:parse-files', paths),
    search: (provider: string, query: string, endpoint?: string) => ipcRenderer.invoke('context:search', provider, query, endpoint),
    readUrl: (url: string) => ipcRenderer.invoke('context:read-url', url),
    ocr: (id: string, engine: string) => ipcRenderer.invoke('context:ocr', id, engine),
    vision: (id: string, provider: string) => ipcRenderer.invoke('context:vision', id, provider),
    format: (label: string, source: string, name: string, content: string, engine?: string) => ipcRenderer.invoke('context:format', label, source, name, content, engine),
    clearCache: () => ipcRenderer.invoke('context:clear-cache')
  }
});
