# Meeting Translator

实时会议双语字幕翻译工具。基于 Tauri 2（Rust + TypeScript）构建，捕获系统音频并调用 Gemini Live API 进行实时转写与翻译，提供悬浮字幕、历史会话、句子级 AI 对齐、AI 总结与问答等完整工作流。

## 功能特性

- **实时悬浮字幕**：捕获系统音频，中英双语字幕实时显示；支持外观、历史行数与滚动行为配置，可选译文语音播放。
- **历史记录与会话**：字幕自动归档为会话，支持查看、选择、合并与删除；本地持久化，重启不丢失。
- **句子级 AI 对齐**：历史字幕出现错位（一句多行、跨行漂移）时，按句子重新配对，不丢失、不篡改原文。
- **快速笔记与标记**：为任意字幕句添加备注、打标记，备注跟随句子移动与对齐结果。
- **AI 总结与问答**：基于会话字幕生成 Markdown 总结（流式输出、可重新生成），并可就会议内容提问；已有总结时直接打开历史，不重复请求。
- **随机字幕测试**：内置随机字幕流，便于不接入真实音频时验证切句与显示效果。

## 界面预览

主窗口负责启动/停止翻译与全部配置；悬浮字幕实时显示中英双语；历史窗口管理会话、笔记与 AI 对齐；总结窗口生成 Markdown 总结并支持针对字幕提问。

<p align="center">
  <img src="docs/screenshots/main.png" width="240" alt="主窗口"/>
  <img src="docs/screenshots/history.png" width="350" alt="历史记录窗口"/>
  <img src="docs/screenshots/summary.png" width="320" alt="AI 总结窗口"/>
</p>

<p align="center">
  <img src="docs/screenshots/record.png" width="300" alt="快速记录窗口"/>
  <img src="docs/screenshots/subtitle-settings.png" width="360" alt="字幕设置窗口"/>
</p>

> 截图来自 Windows 开发环境；实际外观可能因系统与显示缩放略有差异。

## 快速开始

### 环境要求

- Windows 10 及以上
- Node.js 18+ 与 npm
- Rust 工具链（Tauri 2 要求）
- 可用的 Gemini API 密钥（或 OpenAI 兼容接口）

### 运行开发版

```bash
npm install
npm run tauri dev
```

### 构建安装包

```bash
npm run tauri build
```

## 配置说明

在主窗口底部填写配置后点击「开始」：

| 配置项 | 说明 |
| --- | --- |
| API 密钥 | Gemini API Key；可在设置中为总结单独配置密钥 |
| Base URL | 默认 Google AI Studio 地址，可切换为 OpenAI 兼容接口地址 |
| 模型 | 实时翻译模型与总结模型可分别指定 |
| 代理 | 可选 HTTP 代理地址 |
| 字幕中文 | 译文语言模式（简体中文等） |

悬浮字幕窗口的「设置」按钮可调整字幕外观、字号、历史行数与滚动方式。

## 使用说明

1. **开始翻译**：填写 API 密钥并选择音频设备，点击「开始」，悬浮字幕窗口自动出现。
2. **查看历史**：主窗口的「历史」入口打开历史窗口，按会话浏览字幕；可手动编辑、删除单句，或对选中的句子添加备注与标记。
3. **AI 对齐**：字幕错位时点击「AI 对齐」，按句子级别自动重新配对。
4. **总结与提问**：在历史窗口点击「AI 总结」打开总结窗口，生成 Markdown 总结；也可在输入框直接提问。总结与回答均流式显示。

## 测试

```bash
npm test          # 单元与端到端测试
npm run build     # 类型检查 + 生产构建
```

## 项目结构

```text
meeting-translator/
├── index.html              # 主控制窗口
├── subtitles.html          # 悬浮字幕窗口
├── subtitle-settings.html  # 字幕设置窗口
├── history.html            # 历史记录窗口
├── record.html             # 快速笔记窗口
├── summary.html            # AI 总结窗口
├── src/                    # TypeScript 前端逻辑与样式
├── src-tauri/              # Rust 后端：音频、窗口与流式命令
└── docs/                   # 文档与截图
```

## License

MIT
