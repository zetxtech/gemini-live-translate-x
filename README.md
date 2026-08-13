# Meeting Translator

Real-time meeting audio translation for Windows using Tauri, Rust, TypeScript, and the Gemini Live Translate API.

## Features

- System audio capture through CPAL.
- Live Chinese and English subtitles with optional translated audio playback.
- Floating subtitle window with configurable appearance and history modes.
- History subtitle alignment, copying, AI alignment, and AI summaries.

## Prerequisites

- Windows 10 or later.
- Node.js and npm.
- Rust toolchain supported by Tauri 2.
- Gemini API key with access to the configured live translation model.

## Development

```bash
npm --prefix meeting-translator install
npm --prefix meeting-translator run tauri dev
```

## Verification

```bash
npm --prefix meeting-translator test
npm --prefix meeting-translator run build
```

## Project Structure

```text
meeting-translator/
├── index.html                 Main control window
├── history.html               History subtitles window
├── summary.html               AI summary window
├── src/                       TypeScript UI and subtitle logic
└── src-tauri/                 Rust audio and window integration
```

## License

MIT
