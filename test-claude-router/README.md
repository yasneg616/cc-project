# Claude Code Studio

Windows 桌面版 Claude Code Router GUI。应用通过 PTY 启动真实的 `ccr code` 或 `claude`，并提供可预览、可确认的 Context Manager。

## 功能

- Claude Code / Claude Code Router 会话与 PowerShell 终端
- 可滚动的工作区文件树、对话区、Agent/Context 侧栏
- Tavily、Brave、SerpAPI、Bing、SearXNG 搜索适配器
- Readability 网页正文提取与 PDF URL 前两页解析
- TXT/Markdown/代码/JSON/YAML/CSV/PDF/DOCX/XLSX 文件预处理
- Tesseract 本地 OCR；OpenAI、Gemini、Claude、Qwen-VL、OCR.Space、百度、火山云端 OCR
- OpenAI、Gemini、Claude、Qwen-VL 图片理解
- full / summary / key-points、token 估算、长内容分块和显式上下文标签

所有内容先预览，确认后才注入当前 Claude Code 会话。云端 OCR/视觉分析每次都会弹出确认；文件正文不写入日志。

## 开发

```powershell
npm install
npm run dev
npm test
npm run build
```

复制 `.env.example` 为工作区 `.env`，只填写实际使用的适配器 Key。不要提交已填写的 `.env`。

## 上下文格式

注入内容使用 `[Web Context]`、`[File Context]`、`[Image OCR Context]` 或 `[Image Vision Context]` 包裹，并保留 URL、文件名和所用引擎。

## 产物

`npm run build` 生成 `release/win-unpacked/Claude Code Studio.exe`；`npm run dist` 生成 Windows x64 NSIS 安装包。
