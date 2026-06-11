# memforks-chat

A reference chat application demonstrating the full MemForks memory model: persistent, branching, semantically-recalled memory for AI agents — built with Next.js 15 and the Vercel AI SDK.

---

## What this demonstrates

Most AI chat apps forget everything between sessions. MemForks treats agent memory like Git treats code: facts are committed as content-addressed blobs on [Walrus](https://walrus.xyz), branches are on-chain Sui Move objects, and recall is semantic search over embeddings — not a database query over raw message history.

This app makes that concrete:

| Feature | What it shows |
|---|---|
| **Persistent memory** | Ask "what do you know about me?" in a fresh session — the agent answers from prior conversations |
| **Branch isolation** | Fork a thread at any reply; that branch accumulates its own independent memory |
| **Thread persistence** | Switch between branches and return — each branch's conversation is exactly where you left it |
| **Memory diff** | Side-by-side view of what two branches each know, with shared vs. unique facts highlighted |
| **Merge** | Commit a branch's recalled facts onto `main` — subsequent sessions on `main` inherit that knowledge |

---

## Architecture

### The two layers: MemWal and MemForks

**MemWal** is the storage and retrieval layer. It is a vector-enabled blob store built on [Walrus](https://walrus.xyz) — a decentralised storage network. When the agent replies, the reply text is written to Walrus as a content-addressed blob via the MemWal relayer. MemWal also embeds the text and indexes it so that `recall(query)` can return semantically relevant blobs ranked by cosine distance. MemWal is what makes memory *persist* and *searchable*.

**MemForks** is the branching and governance layer. It is a set of Move smart contracts on Sui that manage a *memory tree*: a directed graph of named branches, each with a settled head pointer (a Walrus blob ID). `branch()` is a Sui transaction. `proposeMerge()` is an on-chain governance object. `@memfork/core` is the TypeScript SDK that drives both layers.

The relationship:

```
MemForks (Sui Move)       — who owns what branch, merge proposals, access control
      │
      └── MemWal (Walrus) — the actual facts, stored as blobs, recalled by meaning
```

MemWal without MemForks is just a vector store. MemForks without MemWal has governance but nowhere to put the content. Together they give you versioned, ownable, semantically-recalled agent memory.

### System diagram

```
Browser (Next.js 15 App Router)
│
├── /api/chat      — recall → inject context → stream reply → auto-commit
├── /api/branch    — create an on-chain branch from any parent
├── /api/diff      — recall same query on two branches in parallel
└── /api/merge     — sweep source branch, commit facts onto target
         │
         ▼
@memfork/core  ←→  Sui testnet (branch/merge objects, on-chain governance)
         │
         ▼
MemWal relayer  ←→  Walrus (content-addressed memory blobs + vector index)
```

### Memory flow per message

```
User sends message
       │
       ▼
recallFacts(userMessage, branch)        ← semantic search over branch's blobs
       │
       ▼
Inject recalled facts into system prompt
       │
       ▼
withMemForks(openai("gpt-4o-mini"))     ← Vercel AI SDK middleware
       │
       ├── streams reply to browser
       └── autoCommit: true → client.commit(branch, { facts: [replyText] })
                                         ← writes new Walrus blob, advances branch head
```

### Why not a database?

| | Traditional DB | MemForks |
|---|---|---|
| What's stored | Raw messages | Distilled facts (Walrus blobs with embeddings) |
| Recall | `SELECT WHERE thread_id = ?` | Cosine similarity over embeddings — meaning-based |
| Scale | N messages → N rows sent to context | N messages → top-K relevant facts |
| Branching | Copy rows, new thread ID | On-chain Sui Move tx — cryptographically verifiable |
| Merging | SQL UPDATE | `proposeMerge()` → on-chain governance with attestations |
| Ownership | Vendor's database | Sui object — you hold the keys |
| Cross-agent | Read the same table | Any agent with the right keypair/delegate |

---

## Prerequisites

- Node.js ≥ 18
- A MemForks account provisioned on Sui testnet
- An OpenAI API key

If you haven't provisioned yet:

```bash
npm install -g @memfork/cli
memfork init --quick       # creates a Sui wallet + memory tree on testnet
memfork doctor --env       # prints the env vars you need below
```

---

## Setup

### 1. Install dependencies

```bash
cd apps/memforks-chat
npm install
```

### 2. Configure environment

Create `.env` in `apps/memforks-chat/`:

```env
# OpenAI — required for chat completions
OPENAI_API_KEY=sk-...

# MemForks — Sui identity and memory tree
# TREE_ID:      the on-chain Sui object ID of your memory tree
# PRIVATE_KEY:  your Sui keypair (signs branch/merge transactions)
MEMFORK_TREE_ID=0x...
MEMFORK_PRIVATE_KEY=suiprivkey1...
MEMFORK_NETWORK=testnet

# MemWal — Walrus blob storage and vector recall
# ACCOUNT:  your MemWal account ID (used to namespace blobs per account)
# KEY:      delegate key authorising writes to the MemWal relayer
MEMFORK_MEMWAL_ACCOUNT=0x...
MEMFORK_MEMWAL_KEY=...

# Relayer URL — the MemWal HTTP relayer, must match the network above
# testnet: https://relayer.staging.memwal.ai
# mainnet: https://relayer.memory.walrus.xyz
MEMFORK_RELAYER_URL=https://relayer.staging.memwal.ai
```

### 3. Run

```bash
npm run dev
# → http://localhost:3001
```

---

## Using the app

### Persistent memory

Send a few messages introducing yourself, your project, your preferences. Close the browser. Reopen it and start a **New chat**. Ask:

> What do you know about me?

The agent recalls from prior sessions. There is no database. There is no session cookie. The memory lives in MemWal blobs on Walrus.

### Branching a conversation

On any assistant reply, click **Branch from here**. This:

1. Calls `POST /api/branch` which executes a Sui Move `tree::branch` transaction
2. Switches the branch picker to a new `explore/<id>` branch
3. Trims the visible thread to the branch point

Continue the conversation on the new branch. Its memory is entirely independent — commits go to a separate MemWal namespace keyed by branch name.

> "Branch from here" only appears on `main`. From a fork you use Diff and Merge instead.

### Switching branches

Use the branch picker in the header. Each branch's thread is saved to localStorage, so switching back restores exactly where you were. The underlying memory (what the agent *knows*) lives in MemWal, not localStorage — even if you clear local storage, the agent still recalls from prior sessions via semantic search.

### Diff panel

While on a non-`main` branch, click **Diff** in the header. The panel slides up showing:

- **Current branch** facts (recalled for the query)
- **main** facts (recalled for the same query)
- Each fact tagged `unique` or `shared`

Change the query in the search bar and click **Refresh** to explore different facets of each branch's memory. Unique facts on your branch are highlighted in green — these are things the fork knows that `main` does not.

### Merging

From the Diff panel footer (or the **Merge → main** button in the header), click merge. This:

1. Calls `POST /api/merge` with `{ from: currentBranch, into: "main" }`
2. The server runs three broad semantic sweep queries against the source branch to collect up to 30 deduplicated facts
3. Calls `client.commit("main", { facts, message: "Merge from explore/..." })` — writes a new Walrus blob advancing `main`'s head
4. On the next message sent from `main`, those facts will surface via recall

This is a **semantic cherry-pick** — not the full on-chain `proposeMerge()` ceremony (which involves a Sui governance proposal, attestations, and `finalizeMerge()`). The full ceremony is available via `client.proposeMerge()` in `@memfork/core`.

---

## API reference

### `POST /api/chat`

Streams a chat reply with memory recall and auto-commit.

**Request body**
```json
{ "messages": [...], "branch": "main" }
```

**Response headers**
```
X-MemForks-Branch:   main
X-MemForks-Recalled: <url-encoded JSON array of { text, distance }>
```

**How it works:**
1. Extracts the last user message as the recall query
2. Calls `recallFacts(query, branch, limit=5)` → injects into system prompt
3. Wraps the model with `withMemForks(..., { autoCommit: true })` — the middleware commits the completed assistant reply as a new blob after streaming finishes

---

### `POST /api/branch`

Creates an on-chain branch from a parent.

**Request body**
```json
{ "from": "main", "name": "explore/my-idea" }
```
`name` is optional — defaults to `explore/<base36 timestamp>`.

**Response**
```json
{ "branch": "explore/my-idea", "digest": "<sui tx digest>" }
```

Under the hood this executes `tree::branch` on the MemForks Move package on Sui testnet.

---

### `GET /api/diff`

Recalls the same semantic query on two branches in parallel.

**Query params**
```
from=explore/abc123
into=main            (default: main)
query=...            (default: broad facts query)
```

**Response**
```json
{
  "from": [{ "text": "...", "distance": 0.62 }, ...],
  "into": [{ "text": "...", "distance": 0.58 }, ...],
  "query": "..."
}
```

---

### `POST /api/merge`

Sweeps a source branch for facts and commits them onto a target branch.

**Request body**
```json
{ "from": "explore/abc123", "into": "main" }
```

**Response**
```json
{ "merged": 7, "blobId": "Wq9O91bd..." }
```

The sweep runs three broad queries (`facts about this project`, `user preferences and decisions`, `user background and goals`) in parallel, deduplicates, then calls `client.commit(into, { facts, message: "Merge from ..." })`.

---

## Project structure

```
apps/memforks-chat/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── chat/route.ts      recall → stream → auto-commit
│   │   │   ├── branch/route.ts    on-chain branch creation
│   │   │   ├── diff/route.ts      parallel recall on two branches
│   │   │   └── merge/route.ts     sweep + commit onto target
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   ├── chat-app.tsx           root client component, all state
│   │   ├── header.tsx             branch picker, Diff/Merge buttons
│   │   ├── message-list.tsx       thread rendering, "Branch from here"
│   │   ├── recalled-context.tsx   inline pill showing recalled facts
│   │   ├── diff-panel.tsx         slide-up memory diff panel
│   │   └── prompt-pills.tsx       quick-send suggestion pills
│   └── lib/
│       ├── memfork.ts             MemForksClient singleton, recallFacts, extractFactText
│       ├── thread-store.ts        localStorage thread persistence per branch
│       ├── branches.ts            localStorage branch list
│       └── theme.ts               dark/light mode
└── .env                           credentials (not committed)
```

---

## Key implementation details

### `extractFactText`

MemWal stores the full commit payload JSON as the blob text. When recalled, the raw blob looks like:

```json
{ "v": 1, "type": "commit", "branch": "main", "delta": { "facts": ["The actual text..."] } }
```

`extractFactText` in `src/lib/memfork.ts` parses this and returns `delta.facts` as a joined string. Without this, the LLM receives raw JSON blobs as "memory context", and the diff panel renders unreadable JSON.

### Thread persistence vs. memory

These are separate layers:

- **Thread (localStorage):** The visible chat messages. Ephemeral. Survives browser refresh, not localStorage clear.
- **Memory (MemWal blobs):** What the agent *knows*. Permanent. Survives everything. Even if you wipe localStorage entirely, the agent still recalls from MemWal on the next fresh session.

### `withMemForks` middleware

`@memfork/vercel-ai` wraps any Vercel AI SDK model. With `autoCommit: true` it intercepts the completed assistant reply and calls `client.commit(branch, { facts: [replyText] })` after the stream finishes. With `recallLimit: 0` it skips its own recall (we do recall manually in the route to get the facts for the response headers and the UI pill display).

---

## Extending to multi-user

This reference app uses a single memory tree configured via `.env` — one developer, one tree. That is intentional for a self-hosted demo. For a real product, each user needs isolated memory. There are three patterns:

### Option A: Server-owned tree, per-user branches *(recommended first step)*

One tree owned by the app's server keypair. Each authenticated user gets their own branch namespace. MemWal isolation is automatic because storage is keyed by `(treeId, branchName)`.

```ts
// Branch naming convention
function userBranch(userId: string, branch = "main") {
  return `user/${userId}/${branch}`;
}

// Route passes the user's branch instead of "main"
const branch = userBranch(session.userId); // e.g. "user/abc123/main"
```

What to add:
- Auth (Privy is a natural fit for web3 context) — gives you a stable `userId`
- Replace the hardcoded `branch = "main"` default with `userBranch(userId)`
- No changes to the MemForks or MemWal configuration

Tradeoff: the app owns the tree. Users' memory is portable only if you expose an export mechanism.

### Option B: App-provisioned tree per user

On signup, the app creates a new memory tree for each user and stores the `treeId` in your database. Users get real ownership — they can take their tree elsewhere.

```ts
// On first login
const { treeId } = await provisionTree({ signer: serverKeypair, userId });
await db.users.update(userId, { treeId });

// Per-request client
async function getClientForUser(userId: string) {
  const { treeId } = await db.users.find(userId);
  return MemForksClient.connect({ treeId, signer: serverKeypair, ... });
}
```

Requires the [sponsor service](../../services/sponsor) to pay Sui gas on behalf of users.

### Option C: User-owned trees *(current demo model)*

The user runs `memfork init --quick` themselves and provides their own credentials. Right for developer tools and power users. The current `.env` setup is this model.

---

## Roadmap

- **Multi-user** — add Privy auth + per-user branch namespacing (Option A above)
- **Full on-chain merge ceremony** — `proposeMerge()` → attestations → `finalizeMerge()`. The governance object lives on-chain; any authorized agent can attest before knowledge merges.
- **Branch graph visualizer** — tree view of branch/parent relationships with commit timestamps
- **Delegate access** — share a branch's memory with another agent via `grantDelegate()`
- **Multi-model** — swap the model in the branch picker to compare how different models reason over the same memory
