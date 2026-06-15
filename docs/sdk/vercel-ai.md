# Vercel AI SDK Adapter

`@memfork/vercel-ai` gives Vercel AI SDK model calls branch-aware memory.

Before generation, it recalls relevant facts from the selected branch and injects them into model context. After generation, it can commit the response back to branch memory.

## Install

```bash
npm install @memfork/vercel-ai @memfork/core ai
```

Add your model provider package, for example:

```bash
npm install @ai-sdk/openai
```

## Basic Usage

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { withMemForks } from "@memfork/vercel-ai";

const model = withMemForks(openai("gpt-4o-mini"), {
  treeId: process.env.MEMFORK_TREE_ID!,
  signer: process.env.MEMFORK_PRIVATE_KEY!,
  memwal: {
    accountId: process.env.MEMFORK_MEMWAL_ACCOUNT!,
    delegateKey: process.env.MEMFORK_MEMWAL_KEY!,
    serverUrl: process.env.MEMFORK_RELAYER_URL,
  },
  branch: "main",
});

const result = await generateText({
  model,
  messages: [
    { role: "user", content: "What did we decide about authentication?" },
  ],
});

console.log(result.text);
```

## Auto-Resolved Config

If your environment is already configured with `memfork init`, use `createMemForksModel`:

```ts
import { openai } from "@ai-sdk/openai";
import { createMemForksModel } from "@memfork/vercel-ai";

const model = await createMemForksModel(openai("gpt-4o-mini"), {
  branch: "feature/auth",
});
```

## Next.js Streaming Route

```ts
import { openai } from "@ai-sdk/openai";
import { streamText, type Message } from "ai";
import { withMemForks } from "@memfork/vercel-ai";

interface ChatRequest {
  messages: Message[];
  branch?: string;
}

export async function POST(req: Request) {
  const { messages, branch = "main" } = (await req.json()) as ChatRequest;

  const model = withMemForks(openai("gpt-4o-mini"), {
    treeId: process.env.MEMFORK_TREE_ID!,
    signer: process.env.MEMFORK_PRIVATE_KEY!,
    memwal: {
      accountId: process.env.MEMFORK_MEMWAL_ACCOUNT!,
      delegateKey: process.env.MEMFORK_MEMWAL_KEY!,
      serverUrl: process.env.MEMFORK_RELAYER_URL,
    },
    branch,
    recallLimit: 5,
    autoCommit: true,
  });

  const result = streamText({
    model,
    messages,
  });

  return result.toDataStreamResponse({
    headers: {
      "X-MemForks-Branch": branch,
    },
  });
}
```

## Branch Per User Or Session

Use `branchFromContext` when the branch is derived from request context:

```ts
const model = withMemForks(openai("gpt-4o-mini"), {
  ...config,
  branchFromContext: ({ messages }) => {
    const sessionId = extractSessionId(messages);
    return `session/${sessionId}`;
  },
});
```

For multi-user apps, prefer a stable authenticated ID:

```ts
function userBranch(userId: string, branch = "main") {
  return `user/${userId}/${branch}`;
}
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `branch` | `main` | Branch used for recall and commit. |
| `recallLimit` | `5` | Maximum recalled facts to inject. Set `0` to disable adapter recall. |
| `autoCommit` | `true` | Commit the completed model output after generation or stream close. |
| `recallThreshold` | `0.4` | Semantic distance cutoff. Lower is stricter. |
| `branchFromContext` | None | Function that derives the branch from request messages. |

## Works With Vercel AI SDK Functions

```ts
import { generateObject, generateText, streamText } from "ai";

await generateText({ model, messages });
await streamText({ model, messages });
await generateObject({ model, messages, schema });
```

## Manual Recall Plus UI Display

The reference chat app disables adapter recall and does manual recall in the route so it can display recalled facts in the UI:

```ts
const recalled = await recallFacts(query, branch);

const model = withMemForks(openai("gpt-4o-mini"), {
  branch,
  recallLimit: 0,
  autoCommit: true,
});
```

This pattern is useful when you want response headers, debug panels, or visible memory cards.

## Reference Example

See [Branch-Aware Chat](/examples/chat) for the full Next.js app with branch picker, diff panel, and merge button.
