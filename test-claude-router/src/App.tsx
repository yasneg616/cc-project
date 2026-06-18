import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import Explorer from './components/Explorer';
import Chat from './components/Chat';
import AgentPanel from './components/AgentPanel';
import TerminalPanel from './components/TerminalPanel';
import Approval from './components/Approval';

export default function App() {
  const [workspace, setWorkspace] = useState<{ cwd: string; tree: TreeNode[] }>({ cwd: '', tree: [] });
  const [git, setGit] = useState<GitInfo>({ branch: '—', files: [], commits: [] });
  const [model, setModel] = useState('Claude Router');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [approval, setApproval] = useState<AgentEvent>();
  const [terminalHeight, setTerminalHeight] = useState(245);
  const [file, setFile] = useState<{ path: string; content: string }>();

  useEffect(() => { window.studio.workspace.get().then(setWorkspace); window.studio.git.info().then(setGit); }, []);
  const onEvent = useCallback((event: AgentEvent) => {
    setEvents(current => [...current, event]);
    if (event.type === 'approval') setApproval(event);
    if (event.type === 'tool_result' || event.type === 'exit') window.studio.git.info().then(setGit);
  }, []);
  const openFile = async (node: TreeNode) => { if (node.type === 'file') setFile({ path: node.path, content: await window.studio.fs.read(node.path) }); };

  return <div className="app-shell">
    <div className="titlebar"><span>CLAUDE CODE STUDIO · v0.1.5</span></div>
    <div className="workbench">
      <Explorer cwd={workspace.cwd} tree={workspace.tree} onWorkspace={value => { setWorkspace(value); window.studio.git.info().then(setGit); }} onTree={tree => setWorkspace(value => ({ ...value, tree }))} onFile={openFile} />
      <div className="center">
        {file && <div className="file-preview"><div><span>{file.path.split(/[\\/]/).pop()}</span><button onClick={() => setFile(undefined)}><X /></button></div><pre>{file.content}</pre></div>}
        <Chat model={model} onModel={setModel} onEvent={onEvent} />
        <TerminalPanel height={terminalHeight} onResize={setTerminalHeight} />
      </div>
      <AgentPanel cwd={workspace.cwd} model={model} git={git} events={events} />
    </div>
    {approval && <Approval event={approval} onClose={answer => { window.studio.agent.input(answer); setApproval(undefined); }} />}
  </div>;
}
