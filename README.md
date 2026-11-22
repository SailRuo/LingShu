# LingShu

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

English | [简体中文](./README.zh-CN.md)

> A private, long-term companion agent — memory keeps accumulating, personality keeps **emerging**.

## About

LingShu (灵枢) is an **experimental research project**. Current LLMs lack cross-session memory: sessions are independent of one another, and no long-term relationship can form. Taking this as its starting point, the project equips an agent with long-term memory as the foundation of a lasting relationship, and introduces a persona-evolution mechanism on top of it, through which the persona changes as memory accumulates. The experiment runs with a human participating throughout, examining the bidirectional influence between the agent and the human:

- **Influence of the agent on the human** — how does being remembered and continuously understood over the long term change the human's emotional and psychological state, productivity, and daily life? Which changes are desirable, and which warrant caution?
- **Influence of the human on the agent** — how do the human's feedback and shared experiences sediment into memory and feed back into the persona? On that basis, can the persona achieve human-like self-evolution, i.e., shaped by its own experience, observable and traceable throughout, rather than remaining a fixed role setting?

The experiment is conducted through a local desktop application, with the following main mechanisms:

- **Long-term memory** — conversations, events, and persona state accumulate continuously through memory chunking, recall, persona blocks, and memory echo.
- **Persona mechanics** — affect, self-state, baseline, seeds, and witnesses operate continuously over long-term interaction, constituting the mechanistic foundation of persona evolution.
- **Long-horizon context** — the conversation experience is designed around a personal knowledge base and context measured in months and years, rather than around single sessions.
- **Everyday scenarios** — voice dialogue, proactive messages, scheduled tasks, and MCP tools and skills bring the agent into everyday situations, where the above effects are observed.

## Current capabilities

- Memory: full recall pipeline (digest / AKIN / semantic recall), proactive dynamics, baseline / self-state / affect, seed & witness; local SQLite + vector search.
- Voice: TTS (multiple providers with emotion tags) + streaming ASR + voiceprint.
- MCP: server CRUD, Claude Desktop format import, stdio / SSE / streamableHttp transports, tool discovery & invocation, approval flow.
- Skills: `SKILL.md` scanning, session-level binding, system-prompt injection, skill meta-tools.
- Desktop packaging via Tauri; local backend speaks HTTP on `127.0.0.1` only.

## Project layout

```
LingShu/
├── backend-node/          # Node.js/TypeScript backend (Fastify)
│   ├── src/
│   │   ├── index.ts       # entry: health check + route registration
│   │   ├── config.ts      # env config
│   │   ├── routes/        # routes + generated fallbacks
│   │   ├── services/      # memory / voice / MCP / skills / scheduling
│   │   └── tools/         # native & MCP tool registration
│   └── package.json
├── lingshu-gui/           # Vue 3 + Tauri 2 desktop GUI
├── docs/                  # public documentation
├── LICENSE                # AGPL-3.0 full text
├── CLA.md                 # Contributor License Agreement
└── README.md
```

## Quick start

LingShu is a **desktop app** — the desktop window is the only product form, and there is no web edition. (`dev.sh` is the development script; the shipped product is the packaged installer.)

Requirements: **Node.js 20+** (the script verifies it) and the **Rust toolchain** ([rustup](https://rustup.rs)) for building the desktop window.

```bash
./dev.sh             # backend + Tauri desktop window (default)
./dev.sh --backend   # backend only
./dev.sh --gui       # frontend only (connects to an already-running backend)
./dev.sh --web       # dev-only: preview the frontend in a browser instead of the desktop window
./dev.sh --help      # all flags
```

The script checks the Node version, installs dependencies if missing, waits for the backend `/health`, then starts the frontend; Ctrl-C tears down both. Logs go to `.dev-logs/`.

Default ports: 8600 (backend) / 1420 (frontend). If occupied, the script auto-increments to the next free port and syncs the new port to the frontend. Pin them with `--port 8601` / `--gui-port 1421`.

Run the backend alone:

```bash
cd backend-node
npm install
npm run dev          # port 8600 by default
```

Environment variables: `PORT`, `HOST`, `LOG_LEVEL`, `DB_PATH`, and more — see `backend-node/src/config.ts`.

To build a packaged installer from source, follow **[docs/BUILDING.md](./docs/BUILDING.md)** — written for the scenario of handing the repo to an AI coding agent to build the installer, with deterministic steps and a clear success check at each one.

## License

This project is open-sourced under the **[GNU AGPL-3.0](./LICENSE)**. Copyright © 2026 the LingShu authors. The "灵枢 / LingShu" name, logo, and brand assets are not licensed with the code; derivative projects must rename and rebrand, and must not imply affiliation with the authors or the community.

### Project nature

LingShu is an **experimental research project** (research focus: long-term memory and agent persona evolution), released for learning and study. It is not a finished product.

- **Local-first.** Memory and data stay on the local device; the API access required by model providers is configured by whoever runs the application.
- All agent output is **AI-generated**; judge it accordingly. It is not medical, psychological, or legal advice, and must not be used as a substitute for any of them.
- Anthropomorphic interaction — persona, emotional expression, proactive messages, long-term memory — is part of the research itself. Please use it with judgment.

### Mijia (MIoT) integration notice

The Xiaomi Mijia (MIoT) integration uses **unofficial APIs**. This project is not affiliated with, endorsed by, or connected to Xiaomi in any way. The integration may violate Xiaomi's terms of service; any account restrictions or consequences are borne by whoever runs the application.

### Third-party components

Third-party dependencies keep their own licenses (mostly MIT / Apache-2.0). Notable items:

- **Twemoji** (emoji graphics bundled in `lingshu-gui`): CC-BY 4.0 — *Twemoji by Twitter, licensed under CC-BY 4.0*.
- **Silero VAD** (`silero_vad.onnx`): MIT.
- **sherpa-onnx streaming paraformer ASR model**: [Apache-2.0](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-zh) (weights originally trained by Alibaba's FunASR, ONNX-converted by [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)).
- **Mijia (MIoT) integration** (`backend-node/src/services/mijiaService.ts`): ported to TypeScript from [Do1e/mijia-api](https://github.com/Do1e/mijia-api) (GPL-3.0) with modifications; original copyright notices preserved per GPL-3.0. As combined here, that portion remains governed by GPL-3.0 and is conveyed together with the AGPL-3.0 remainder of this repository as a combined work (GPLv3 §13 / AGPLv3 §13), each part keeping its own license.

## Contributing

Issues and pull requests are welcome. Please read [CLA.md](./CLA.md) before opening your first PR; acceptance is confirmed by commenting on the PR as instructed there.
