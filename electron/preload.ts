import {contextBridge,ipcRenderer} from 'electron';
const on=(channel:string,cb:(data:any)=>void)=>{const h=(_e:unknown,d:any)=>cb(d);ipcRenderer.on(channel,h);return()=>ipcRenderer.removeListener(channel,h)};
contextBridge.exposeInMainWorld('studio',{
 workspace:{open:()=>ipcRenderer.invoke('workspace:open'),get:()=>ipcRenderer.invoke('workspace:get'),onChanged:(cb:(p:string)=>void)=>on('workspace:changed',cb)},
 fs:{read:(p:string)=>ipcRenderer.invoke('fs:read',p),create:(p:string,t:'file'|'directory')=>ipcRenderer.invoke('fs:create',p,t),delete:(p:string)=>ipcRenderer.invoke('fs:delete',p),reveal:(p:string)=>ipcRenderer.invoke('fs:reveal',p),menu:(p:string)=>ipcRenderer.invoke('fs:menu',p)},
 git:{info:()=>ipcRenderer.invoke('git:info'),command:(a:string,v?:string)=>ipcRenderer.invoke('git:command',a,v)},
 terminal:{create:(id:string)=>ipcRenderer.invoke('terminal:create',id),input:(id:string,data:string)=>ipcRenderer.send('terminal:input',{id,data}),resize:(id:string,cols:number,rows:number)=>ipcRenderer.send('terminal:resize',{id,cols,rows}),kill:(id:string)=>ipcRenderer.invoke('terminal:kill',id),onData:(cb:(v:any)=>void)=>on('terminal:data',cb)},
 agent:{start:(c:'ccr code'|'claude')=>ipcRenderer.invoke('agent:start',c),input:(t:string)=>ipcRenderer.send('agent:input',t),stop:()=>ipcRenderer.invoke('agent:stop'),onEvent:(cb:(v:any)=>void)=>on('agent:event',cb)}
});
