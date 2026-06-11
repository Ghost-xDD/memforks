# MemForks Chat

Example chat app for `@memfork/vercel-ai` — branch-aware memory with the Vercel AI SDK.

## Setup

```bash
# 1. Provision MemForks credentials (~30s)
npm install -g @memfork/cli
memfork init --quick

# 2. Print env vars
memfork doctor --env

# 3. Configure this app
cp .env.example .env.local
# paste OPENAI_API_KEY + MEMFORK_* values

# 4. Install and run
npm install
npm run dev
```

Open [http://localhost:3001](http://localhost:3001).

## What it demonstrates

- **Recalled context callout** — facts injected into each agent turn, visible in the UI
- **Branch picker** — switch between branches in the header
- **Branch ↗** — fork from any agent reply into a new on-chain branch
- **Auto-commit** — agent responses are committed to MemWal after each turn

## Stack

- Next.js App Router
- `@memfork/vercel-ai` + `@memfork/core` (from npm)
- Vercel AI SDK (`useChat`, `streamText`)
