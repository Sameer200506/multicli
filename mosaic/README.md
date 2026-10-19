# Mosaic

A cross-platform desk where multiple AI agent CLIs run side by side on one folder, sharing the same context.

**Built with Electron + node-pty + xterm.js — Windows, Linux, macOS.**

---

## What it is

Mosaic opens one workspace folder and lets you spawn multiple AI agent CLIs (Claude Code, Codex, OpenCode, Gemini, Cursor Agent, Aider, Qwen, Kimi, Hermes, Droid, and any custom CLI you add) as live terminal panes. Every pane shares a single **context layer** (`.mosaic/context/`) so all agents agree on the goal, plan, file tree, diffs, test results, errors, and notes — no more context drift between panes.

Nothing happens behind your back. Every pane is a live PTY you can interact with directly.

---

## Quick Start

```bash
git clone <this-repo>
cd mosaic
npm install
npm start
```

Then click **Open workspace** (or press `⌘O` / `Ctrl+O`) and pick a folder. Press `⌘N` / `Ctrl+N` to spawn a new agent pane. Choose an agent from the launcher (Claude Code, Codex, OpenCode, etc.).

---

## Architecture

```
mosaic/
├── core/
│   ├── agents/        # Agent registry, detection, PTY spawn, resume args
│   ├── context/       # Shared-context engine (CRDT merge, redaction, topic vocab)
│   └── ipc/           # Contract: channel names, payload schemas, validation
├── ipc/
│   ├── app.js         # Electron entry point (package.json "main")
│   ├── main.js        # Electron main: window, handlers, agent manager
│   ├── preload.js     # contextBridge API for renderer
│   └── renderer/      # Mosaic desk UI (HTML + CSS + vanilla JS)
├── tests/
│   ├── agents.test.js     # registry, detection, resume, PTY lifecycle
│   ├── context.test.js    # store, write/merge, redaction, subscribe
│   ├── renderer.test.js   # live renderer ↔ IPC integration (needs Electron)
│   └── smoke.js           # window boots with a clean console (needs Electron)
├── package.json
└── README.md
```

### Core modules (subagent-delivered)

| Module | Subagent | Model | Description |
|--------|----------|-------|-------------|
| `core/agents` | opencode | MuseSpark 1.3 | Registry (10 built-ins + user agents), PATH/PATHEXT detection, node-pty spawn with env injection, resume arg translation, output parsing |
| `core/context` | freebuff | DeepSeek V4.1 Flash | Append-only operation log + materialized snapshots, CRDT LWW merge, secret redaction, per-topic size limits, subscription API |

### Built-in agents

| ID | Label | Resume flag | Icon color |
|---|---|---|---|
| `claude` | Claude Code | `--resume` | 🟠 |
| `codex` | Codex | `resume` | 🟢 |
| `gemini` | Gemini CLI | `--resume` | 🔵 |
| `opencode` | OpenCode | `--session` | 🟣 |
| `cursor-agent` | Cursor Agent | `--resume` | ⚪ |
| `aider` | Aider | `--restore-chat-history` | 🟢 |
| `qwen` | Qwen Code | `--resume` | 🟣 |
| `kimi` | Kimi CLI | `--session` | 🔵 |
| `hermes` | Hermes | `--resume` | 🟡 |
| `droid` | Factory Droid | `--resume` | 🟠 |

Add custom agents via `~/.mosaic/agents.json`:

```json
{
  "agents": [
    { "id": "my-agent", "cmd": "my-agent", "label": "My Agent", "resumeArg": "--resume", "resumeKind": "flag", "iconColor": "#6366F1" }
  ]
}
```

---

## Shared Context Layer

Every pane runs with these env vars:

- `MOSAIC_WORKSPACE` — absolute path to the open folder
- `MOSAIC_CONTEXT_DIR` — `.mosaic/context` inside the workspace
- `MOSAIC_PANE_ID` — unique pane identifier

Context topics (vocabulary):

| Topic | Purpose |
|-------|---------|
| `goal` | The task the workspace is working toward |
| `plan` | Agreed next actions across panes |
| `file-tree` | Project file structure |
| `diff` | Code changes proposed/applied |
| `test-results` | Test outputs and summaries |
| `error` | Errors captured from any pane |
| `note` | General context notes |

Agents can read/write JSON entries; the engine applies **CRDT Last-Writer-Wins** merge on concurrent writes and redacts secrets (`api_key`, `token`, `secret`, `password`, etc.).

---

## Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — renderer cannot access Node or fs directly.
- PTY spawned with `cwd` locked to workspace root; agents may only read files inside it.
- All IPC channels and payloads validated in main process.

---

## Cross-Platform Notes

| Concern | Windows | Linux | macOS |
|---------|---------|-------|-------|
| CLI shims | `.cmd` / `.bat` via `cmd.exe /d /s /v:off /c` | Native binaries | Native binaries |
| PATH scan | PATHEXT + case-insensitive | `X_OK` + `/usr/bin/which` fallback | Same |
| PTY | `node-pty` (Windows Terminal / ConPTY) | `node-pty` (pty.js) | `node-pty` (pty.js) |
| Dialogs | Electron native | Electron native | Electron native |

---

## Testing

```bash
npm test              # unit: node --test over core/agents + core/context
npm run test:renderer # integration: real window + real IPC handlers
npm run smoke         # smoke: window loads with no renderer console errors
npm run verify        # all three, in order
```

- `tests/agents.test.js` — registry, PATH/PATHEXT detection, resume arg translation, PTY lifecycle, manager locking.
- `tests/context.test.js` — topic/entry validation, CRDT merge, secret redaction, size limits, subscribe/unsubscribe.
- `tests/renderer.test.js` — boots the real renderer through the real preload and main-process handlers, subscribes to a topic, then asserts that a write from another pane shows up live while an abandoned subscription stops.
- `tests/smoke.js` — fails on any renderer console error, page-load failure, or preload error.

The two Electron suites need a display; on headless Linux run them under `xvfb-run`.

---

## License

Apache-2.0 — free for any use, including commercial.

---

## Attribution

Original "agent desk" category pioneered by **Nami** (macOS-only, MIT, [mrdainami/nami](https://github.com/mrdainami/nami)). Mosaic is a clean-room, cross-platform re-implementation with a shared context layer — no nami code copied.