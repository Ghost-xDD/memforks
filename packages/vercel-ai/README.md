# `@memfork/vercel-ai` — Vercel AI SDK Middleware

Drop-in middleware for the [Vercel AI SDK](https://sdk.vercel.ai) that gives any model branch-aware, on-chain memory via MemForks.

**Before generating:** recalls relevant facts from the current branch and injects them as system context.  
**After generating:** commits key decisions on-chain with full provenance.

## Install

```bash
npm install @memfork/vercel-ai @memfork/core ai

# First-run — provision credentials (zero copy-paste on testnet):
memfork init --quick
```

## Usage

### Option A — explicit config

```typescript
import { withMemForks } from "@memfork/vercel-ai";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const model = withMemForks(openai("gpt-4o"), {
  treeId:  process.env.MEMFORK_TREE_ID!,
  signer:  process.env.MEMFORK_PRIVATE_KEY!,
  memwal: {
    accountId:   process.env.MEMFORK_MEMWAL_ACCOUNT!,
    delegateKey: process.env.MEMFORK_MEMWAL_KEY!,
  },
  branch: "feature/my-feature",
});

const { text } = await generateText({
  model,
  messages: [{ role: "user", content: "What did we decide about the auth system?" }],
});
// The model sees recalled facts about the auth system from prior sessions.
// After generating, the response is committed on-chain.
```

### Option B — auto-resolve from `~/.memfork/credentials.json`

```typescript
import { createMemForksModel } from "@memfork/vercel-ai";
import { openai } from "@ai-sdk/openai";

const model = await createMemForksModel(openai("gpt-4o"), {
  branch: "feature/my-feature",
});
```

### Branch per user session

```typescript
import { withMemForks } from "@memfork/vercel-ai";

const model = withMemForks(openai("gpt-4o"), {
  ...config,
  branchFromContext: ({ messages }) => {
    // Map thread/session ID to a branch name
    const threadId = extractThreadId(messages);
    return `session/${threadId}`;
  },
});
```

## How it works

| Phase | What happens |
|-------|-------------|
| `transformParams` (before generate) | Recalls top-N facts from the branch, prepends them to the system prompt |
| `wrapGenerate` (after generate) | Fire-and-forget `memfork commit` anchors the response on-chain |
| `wrapStream` (after stream) | Same commit, triggered when the stream closes |

Recall failures are silent — they never break a generation.  
Commit failures are fire-and-forget — they never delay a response.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `branch` | `string` | `"main"` | Git branch to scope memory to |
| `recallLimit` | `number` | `5` | Max facts to inject. Set `0` to disable recall |
| `autoCommit` | `boolean` | `true` | Commit after generating. Set `false` for read-only mode |
| `recallThreshold` | `number` | `0.4` | Semantic distance cutoff (lower = stricter) |
| `branchFromContext` | `fn` | — | Dynamic branch from request messages |

## Works with any Vercel AI SDK function

```typescript
import { generateText, streamText, generateObject } from "ai";

// All three work identically — middleware applies to both generate and stream paths.
const { text }   = await generateText({ model, messages });
const stream     = await streamText({ model, messages });
const { object } = await generateObject({ model, messages, schema });
```
