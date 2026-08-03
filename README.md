# Meeting Translator (Windows)

Real-time meeting audio translation powered by Google Gemini 3.5 Live Translate API. Captures system audio on Windows and streams it to Gemini for live transcription and translation into Traditional Chinese (zh-TW), with optional voice playback.

## Features

- **WASAPI loopback capture** — captures system audio directly, no virtual audio driver needed.
- **Gemini 3.5 Live Translate** — ultra-low latency bi-directional WebSocket translation.
- **Live bilingual subtitles** — original speech + Chinese translation in real time.
- **Voice interpretation playback** — plays translated audio from Gemini (24kHz PCM).
- **Dark-themed native UI** — modern WinForms interface with custom styling.
- **Single-file exe** — no installer needed, just run.

## Prerequisites

| Requirement | Details |
|---|---|
| **OS** | Windows 10 1903+ |
| **.NET 9 Runtime** | Only needed for framework-dependent build. Self-contained build has no dependencies. |
| **Gemini API Key** | Get one at [Google AI Studio](https://aistudio.google.com/apikey) with access to `gemini-3.5-live-translate-preview` |

## Quick Start

### Option 1: Run the self-contained exe (no .NET required)

```bash
.\dist\MeetingTranslator.exe
```

### Option 2: Run the lightweight exe (requires .NET 9 runtime)

```bash
.\dist-framework\MeetingTranslator.exe
```

### Option 3: Build from source

```bash
dotnet run
```

## Build Commands

```bash
# Debug build
dotnet build

# Self-contained single-file exe (~108 MB, no .NET required)
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist

# Framework-dependent single-file exe (~0.7 MB, needs .NET 9 runtime)
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o dist-framework
```

## Project Structure

```
gemini-live-translate-x/
├── Program.cs                    # Entry point
├── Form1.cs                      # Main form UI + logic
├── Form1.Designer.cs             # Designer stub
├── Settings.cs                   # Settings persistence (JSON)
├── GeminiWebSocket.cs            # Gemini Live WebSocket client
├── AudioCaptureManager.cs        # WASAPI loopback capture (NAudio)
├── AudioPlaybackManager.cs       # PCM audio playback (NAudio)
├── MeetingTranslator.csproj      # Project file
├── dist/                         # Self-contained build output
├── dist-framework/               # Framework-dependent build output
└── ref/                          # macOS reference implementation
```

## Usage

1. Launch the app.
2. Paste your **Gemini API Key**.
3. Select an **audio capture device** (WASAPI loopback devices listed automatically).
4. Click **▶ Start Translation**.
5. Play audio in any application — subtitles appear in real time.
6. Toggle **bilingual subtitles** and **voice playback** in Options.

## License

MIT
