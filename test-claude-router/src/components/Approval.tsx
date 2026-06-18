import { ShieldAlert } from 'lucide-react';

export default function Approval({ event, onClose }: { event: AgentEvent; onClose: (answer: string) => void }) {
  return <div className="modal-backdrop"><div className="approval">
    <div className="approval-icon"><ShieldAlert /></div>
    <h2>Claude 需要你的确认</h2>
    <p>{event.content}</p>
    <div className="approval-meta"><span>操作来自 Claude Code CLI</span><span>选择后会立即发送给当前会话</span></div>
    <div className="approval-choices">
      <button className="approval-choice primary" onClick={() => onClose('\r')}><b>允许一次</b><small>执行这一次操作</small></button>
      <button className="approval-choice" onClick={() => onClose('\x1b[B\r')}><b>始终允许</b><small>本会话不再询问同类操作</small></button>
      <button className="approval-choice danger" onClick={() => onClose('\x1b[B\x1b[B\r')}><b>拒绝</b><small>不执行并让 Claude 继续</small></button>
    </div>
  </div></div>;
}
