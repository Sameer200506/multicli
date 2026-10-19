# multicli (Mosaic — a desk for multiple AI agent CLIs)

Mosaic runs several AI coding-agent CLIs side by side on **one folder**, each in
its own live terminal pane, while all panes share a single context layer so they
agree on the goal, plan, file tree, diffs, tests and notes.

## Why

Running Claude Code, Codex, OpenCode, Gemini, Cursor Agent, Aider, Qwen, Kimi,
Hermes or Droid in parallel usually causes context drift. Mosaic keeps a shared
`.mosaic/context/` document that every agent reads and writes, and shows each
agent as a real PTY you can interact with.

## Features

- Cross-platform Electron desktop app (Windows, Linux, macOS).
- `node-pty` + `xterm.js` terminal panes.
- Agent registry with auto-detection and per-agent argument builders
  (`mosaic/core/agents/`).
- Shared context engine: schema, validation, merge and topics
  (`mosaic/core/context/`).
- Renderer desk UI (`mosaic/ipc/renderer/`).
- Tests: unit, renderer and smoke (`npm run verify`).

## Stack

Electron, Node.js, `node-pty`, `xterm.js`, vanilla JS modules.

## Run locally

```bash
cd mosaic
npm install
npm start
```

```bash
npm test           # core unit tests
npm run verify     # unit + renderer + smoke
```

## Adding an agent

Register a CLI in `mosaic/core/agents/registry.js` (name, binary, args) — Mosaic
detects it on `PATH` and offers it in the spawn menu. Any custom CLI can be
added the same way.

## Repository layout

```
mosaic/
  core/agents/    detection, registry, spawn, args
  core/context/   shared context schema + merge engine
  ipc/            main, preload, renderer
  tests/
```
