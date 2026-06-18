import { app,BrowserWindow,dialog,ipcMain,Menu,shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn as spawnChild } from 'node:child_process';
import * as pty from 'node-pty';
import type {AgentEvent,GitInfo,TreeNode} from './types';

let win:BrowserWindow|null=null; let cwd=process.cwd();
const terminals=new Map<string,pty.IPty>(); let agent:pty.IPty|null=null;
const send=(channel:string,data:unknown)=>win?.webContents.send(channel,data);
const strip=(s:string)=>s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g,'');

async function tree(dir:string,depth=0):Promise<TreeNode[]>{
  if(depth>4)return[]; const entries=await fs.readdir(dir,{withFileTypes:true});
  const visible=entries.filter(e=>!['node_modules','.git','dist','dist-electron','release'].includes(e.name)).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name));
  return Promise.all(visible.map(async e=>{const p=path.join(dir,e.name);return e.isDirectory()?{name:e.name,path:p,type:'directory' as const,children:await tree(p,depth+1)}:{name:e.name,path:p,type:'file' as const}}));
}
const run=(cmd:string,args:string[]=[])=>new Promise<string>((resolve)=>{const c=spawnChild(cmd,args,{cwd,windowsHide:true,shell:true});let out='';c.stdout?.on('data',d=>out+=d);c.stderr?.on('data',d=>out+=d);c.on('close',()=>resolve(out.trim()));c.on('error',()=>resolve(''));});
async function gitInfo():Promise<GitInfo>{
 const branch=(await run('git',['branch','--show-current']))||'no branch';
 const raw=await run('git',['status','--porcelain']); const files=raw.split('\n').filter(Boolean).map(x=>({status:x.slice(0,2).trim()||'M',path:x.slice(3)}));
 const logs=await run('git',['log','-8','--pretty=format:%h%x09%s%x09%cr']); const commits=logs.split('\n').filter(Boolean).map(x=>{const [hash,subject,relative]=x.split('\t');return{hash,subject,relative}});return{branch,files,commits};
}
function parseAgent(raw:string){const clean=strip(raw); for(const line of clean.split(/\r?\n/).filter(Boolean)){
 let event:AgentEvent={type:'output',content:line,timestamp:Date.now()};
 try{const j=JSON.parse(line);event={type:j.type||'output',content:j.content||j.message||line,timestamp:Date.now(),meta:j};}catch{
  if(/allow|deny|permission|approve|批准|允许|拒绝/i.test(line))event.type='approval';
  else if(/tool (use|call)|calling tool|⏺/i.test(line))event.type='tool_call'; else if(/error|failed|exception/i.test(line))event.type='error'; else if(/plan|todo/i.test(line))event.type='plan';
 } send('agent:event',event);
 }}
function createWindow(){win=new BrowserWindow({width:1500,height:940,minWidth:1100,minHeight:700,backgroundColor:'#0d0e11',titleBarStyle:'hiddenInset',titleBarOverlay:{color:'#0d0e11',symbolColor:'#9ca1ac',height:40},webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}}); if(process.env.VITE_DEV_SERVER_URL)win.loadURL(process.env.VITE_DEV_SERVER_URL);else win.loadFile(path.join(__dirname,'../dist/index.html'));}
app.whenReady().then(()=>{cwd=app.getPath('documents');createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()})});app.on('window-all-closed',()=>{terminals.forEach(t=>t.kill());agent?.kill();if(process.platform!=='darwin')app.quit()});

ipcMain.handle('workspace:open',async()=>{const r=await dialog.showOpenDialog({properties:['openDirectory']});if(!r.canceled){cwd=r.filePaths[0];send('workspace:changed',cwd);return{cwd,tree:await tree(cwd)}}return null});
ipcMain.handle('workspace:get',async()=>({cwd,tree:await tree(cwd)}));
ipcMain.handle('fs:read',async(_e,p:string)=>fs.readFile(p,'utf8'));
ipcMain.handle('fs:create',async(_e,p:string,type:'file'|'directory')=>{if(type==='directory')await fs.mkdir(p,{recursive:true});else await fs.writeFile(p,'',{flag:'wx'});return tree(cwd)});
ipcMain.handle('fs:delete',async(_e,p:string)=>{await fs.rm(p,{recursive:true});return tree(cwd)});
ipcMain.handle('fs:reveal',(_e,p:string)=>shell.showItemInFolder(p));
ipcMain.handle('fs:menu',async(_e,p:string)=>new Promise<string|undefined>(resolve=>{Menu.buildFromTemplate([{label:'在资源管理器中显示',click:()=>{shell.showItemInFolder(p);resolve('reveal')}},{type:'separator'},{label:'复制路径',click:()=>{win?.webContents.send('clipboard:path',p);resolve('copy')}}]).popup({window:win!,callback:()=>resolve(undefined)})}));
ipcMain.handle('git:info',gitInfo);ipcMain.handle('git:command',async(_e,action:string,arg?:string)=>{const map:Record<string,string[]>= {pull:['pull'],push:['push'],commit:['commit','-am',arg||'Update from Claude Code Studio'],branch:['switch','-c',arg||'studio-work']};return{output:await run('git',map[action]||['status']),info:await gitInfo()}});

ipcMain.handle('terminal:create',(_e,id:string)=>{terminals.get(id)?.kill();const shellName=process.env.ComSpec?'powershell.exe':'powershell.exe';const t=pty.spawn(shellName,[],{name:'xterm-256color',cols:100,rows:30,cwd,env:process.env as Record<string,string>});terminals.set(id,t);t.onData(data=>send('terminal:data',{id,data}));t.onExit(()=>send('terminal:exit',id));return true});
ipcMain.on('terminal:input',(_e,{id,data})=>terminals.get(id)?.write(data));ipcMain.on('terminal:resize',(_e,{id,cols,rows})=>terminals.get(id)?.resize(Math.max(cols,2),Math.max(rows,1)));ipcMain.handle('terminal:kill',(_e,id:string)=>{terminals.get(id)?.kill();terminals.delete(id)});
ipcMain.handle('agent:start',(_e,command:'ccr code'|'claude')=>{agent?.kill();const [file,...args]=command.split(' ');agent=pty.spawn(file,args,{name:'xterm-256color',cols:120,rows:40,cwd,env:process.env as Record<string,string>});agent.onData(parseAgent);agent.onExit(({exitCode})=>send('agent:event',{type:'exit',content:`Process exited with code ${exitCode}`,timestamp:Date.now()}));send('agent:event',{type:'status',content:`Started ${command}`,timestamp:Date.now()});return true});
ipcMain.on('agent:input',(_e,text:string)=>agent?.write(text));ipcMain.handle('agent:stop',()=>{agent?.kill();agent=null});
