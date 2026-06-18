export type TreeNode={name:string;path:string;type:'file'|'directory';children?:TreeNode[]};
export type GitInfo={branch:string;files:{path:string;status:string}[];commits:{hash:string;subject:string;relative:string}[]};
export type AgentEvent={type:'output'|'tool_call'|'tool_result'|'approval'|'plan'|'status'|'error'|'exit';content:string;timestamp:number;meta?:Record<string,unknown>};
export type TerminalEvent={id:string;data:string};
