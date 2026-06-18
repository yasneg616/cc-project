/// <reference types="vite/client" />
type TreeNode={name:string;path:string;type:'file'|'directory';children?:TreeNode[]};
type GitInfo={branch:string;files:{path:string;status:string}[];commits:{hash:string;subject:string;relative:string}[]};
type AgentEvent={type:'output'|'tool_call'|'tool_result'|'approval'|'plan'|'status'|'error'|'exit';content:string;timestamp:number;meta?:Record<string,unknown>};
type ParsedContext={id:string;kind:'file'|'image'|'url';name:string;source:string;content:string;preview:string;mime?:string;thumbnail?:string;analysisKind?:'ocr'|'vision';engine?:string};
type SearchResult={title:string;url:string;snippet:string;source:string;publishedAt?:string};
interface Window{studio:{
  workspace:{open:()=>Promise<{cwd:string;tree:TreeNode[]}|null>;get:()=>Promise<{cwd:string;tree:TreeNode[]}>;onChanged:(cb:(p:string)=>void)=>()=>void};
  fs:{read:(p:string)=>Promise<string>;create:(p:string,t:'file'|'directory')=>Promise<TreeNode[]>;delete:(p:string)=>Promise<TreeNode[]>;reveal:(p:string)=>Promise<void>;menu:(p:string)=>Promise<string>};
  git:{info:()=>Promise<GitInfo>;command:(a:string,v?:string)=>Promise<{output:string;info:GitInfo}>};
  terminal:{create:(id:string)=>Promise<void>;input:(id:string,d:string)=>void;resize:(id:string,c:number,r:number)=>void;kill:(id:string)=>Promise<void>;onData:(cb:(v:{id:string;data:string})=>void)=>()=>void};
  agent:{start:(c:'ccr code'|'claude')=>Promise<void>;input:(t:string)=>void;stop:()=>Promise<void>;onEvent:(cb:(e:AgentEvent)=>void)=>()=>void};
  context:{selectFiles:()=>Promise<string[]>;pathForFile:(file:File)=>string;parseFiles:(paths:string[])=>Promise<ParsedContext[]>;search:(provider:string,query:string,endpoint?:string)=>Promise<SearchResult[]>;readUrl:(url:string)=>Promise<ParsedContext>;ocr:(id:string,engine:string)=>Promise<ParsedContext>;vision:(id:string,provider:string)=>Promise<ParsedContext>;format:(label:string,source:string,name:string,content:string,engine?:string)=>Promise<string>;clearCache:()=>Promise<boolean>}
}}
