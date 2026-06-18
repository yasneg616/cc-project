# Claude Code Studio

Claude Code / Claude Code Router 的 Windows 桌面 GUI 外壳。应用通过 PTY 启动真实的 `ccr code` 或 `claude`，不会重新实现模型推理。

## 环境

- Windows 10/11 x64
- Node.js 20+
- 已安装并配置 `ccr` 或 `claude` CLI
- node-pty 编译环境（Node.js 官方 Windows 安装通常可直接使用预构建包）

## 开发

```powershell
npm install
npm run dev
```

## 构建与打包

```powershell
npm run build   # 类型检查、Vite 构建、生成 unpacked 应用
npm run dist    # 生成 Windows x64 NSIS 安装包
```

产物位于 `release/`。

## 架构

- `electron/main.ts`：窗口、文件系统、Git、node-pty、Claude CLI 生命周期
- `electron/preload.ts`：上下文隔离的类型安全 IPC 桥
- `src/components/Explorer.tsx`：文件树、搜索、新建、右键菜单
- `src/components/Chat.tsx`：Markdown 会话、Agent 事件、图片粘贴与审批入口
- `src/components/AgentPanel.tsx`：状态、时间线、工具、Git 和执行历史
- `src/components/TerminalPanel.tsx`：xterm.js 多标签 PowerShell

CLI 集成解析 JSON 行事件；当 Router 输出普通 ANSI 文本时，会回退识别 Tool Call、Plan、Approval 与 Error。不同 Router 版本若提供专用 JSON schema，可在 `parseAgent` 中补充字段映射。
