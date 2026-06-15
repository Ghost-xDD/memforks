# memforks-research

A reference multi-agent research pipeline demonstrating MemForks' branching and merge governance model — built with LangGraph and `@memfork/langgraph`.

---

## What this demonstrates

Where `memforks-chat` shows single-user conversational memory, this app shows **automated multi-agent workflows** where parallel agents accumulate knowledge on separate branches, then merge their findings on-chain.

The key MemForks capability on display is **compounding memory**: run the same research question twice and the second run builds on the first. Workers recall what they already know, skip ground they've covered, and go deeper. Knowledge accumulates across runs instead of starting fresh every invocation.

```
Question: "What are the tradeoffs of microservices vs. monolith for a fintech startup?"
         │
         ▼
  [plan]  Supervisor breaks question into 2 sub-topics
         │
         ├─→ Worker A  branch: thread/research-a
         │   recalls prior research on sub-topic A
         │   searches, synthesises, commits findings
         │
         ├─→ Worker B  branch: thread/research-b        (parallel)
         │   recalls prior research on sub-topic B
         │   searches, synthesises, commits findings
         │
         ▼
  [report]  Supervisor  branch: thread/supervisor
            recalls prior supervisor-level synthesis
            combines both streams into final report
            commits synthesis + proposes on-chain merges
```

---

## Why this is different from a normal LangGraph app

|                      | SQLite / in-memory checkpointer           | MemForks checkpointer                                  |
| -------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Checkpoint storage   | Local file or RAM                         | Walrus blobs — permanent, content-addressed            |
| State recovery       | Re-run the process                        | Resume from anywhere, any machine                      |
| Cross-thread recall  | Not possible                              | `checkpointer.recall(query, { threadId })`             |
| Parallel branches    | Separate thread IDs, no relationship      | On-chain branch objects with parent lineage            |
| Merging knowledge    | Manual, undefined                         | `proposeMerge()` → on-chain governance                 |
| Audit trail          | None                                      | Every checkpoint anchored on Sui                       |

The moment that shows the difference: kill the process mid-research, restart, and the pipeline resumes exactly from the last checkpoint. Worker A is still mid-way through its findings. Worker B already finished. The supervisor picks up where it left off. None of this is in a local file — it's in Walrus.

---

## Architecture

### Graph shape

```
START → plan → research → report → END
```

Implemented in `src/graph.ts` with `@langchain/langgraph`:

- **plan** — LLM splits the question into two complementary sub-topics
- **research** — both workers run in parallel (`Promise.all`), each on its own branch
- **report** — supervisor recalls prior synthesis, combines both streams, commits, and optionally proposes on-chain merges

The checkpointer is attached at `compile()` time — every node transition is automatically persisted to MemWal.

### Thread → branch mapping

Each LangGraph thread maps to a MemForks branch via a `thread/` prefix convention:

```
LangGraph thread ID    MemForks branch
──────────────────     ──────────────────────────
research-a          →  thread/research-a
research-b          →  thread/research-b
supervisor          →  thread/supervisor
```

With `--fresh`, a timestamp suffix is appended to create brand-new branches (`research-a-1718123456789`). The default (no flag) reuses stable IDs so the second run builds on the first.

### Worker loop

Each worker (in `src/agents/worker.ts`):

1. Recalls prior research on its topic from its dedicated branch
2. Searches the web via Tavily (or falls back to LLM knowledge if `TAVILY_API_KEY` is unset)
3. Synthesizes new findings with prior context — noting what confirms, extends, or contradicts earlier work
4. Commits the synthesis back to its branch

### Merge ceremony

After both workers complete, the supervisor (`src/agents/supervisor.ts`) commits its synthesis and optionally proposes on-chain merges:

```
proposeMerge({ fromThread: "research-a", intoThread: "supervisor", resolverId })
       │
       ▼
client.proposeMerge({ fromBranch: "thread/research-a",
                      intoBranch: "thread/supervisor",
                      resolverId })
       │
       ▼
Sui Move tx → MergeProposal object created on-chain
       │
       ▼
Resolver daemon attests → finalizeMerge() → branch head settled on Sui
```

---

## Project structure

```
apps/memforks-research/
├── src/
│   ├── research.ts          entry point — parse args, create checkpointer, run graph
│   ├── graph.ts             LangGraph StateGraph definition (plan → research → report)
│   ├── state.ts             AgentState type (question, topicA/B, findingsA/B, report)
│   └── agents/
│       ├── supervisor.ts    planNode, makeResearchNode, makeReportNode
│       ├── worker.ts        runWorker — recall → search → synthesize → commit
│       └── tools.ts         webSearch (Tavily with LLM fallback)
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Prerequisites

- Node.js ≥ 18
- A MemForks tree provisioned on Sui testnet (`memfork init --quick`)
- An OpenAI API key
- Optional: Tavily API key for live web search (falls back to LLM knowledge without it)
- Optional: a deployed resolver ID for the full on-chain merge ceremony

---

## Setup

### 1. Install dependencies

```bash
cd apps/memforks-research
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# Required
OPENAI_API_KEY=sk-...

MEMFORK_TREE_ID=0x...
MEMFORK_PRIVATE_KEY=suiprivkey1...
MEMFORK_NETWORK=testnet

MEMFORK_MEMWAL_ACCOUNT=0x...
MEMFORK_MEMWAL_KEY=...
MEMFORK_RELAYER_URL=https://relayer.staging.memwal.ai

# Optional — removes gas cost for all on-chain operations (mainnet only)
# Requires MEMFORK_NETWORK=mainnet — the sponsor service does not support testnet.
MEMFORK_SPONSOR_URL=https://memforks-sponsor-production.up.railway.app/sponsor

# Optional — enable real web search (falls back to LLM knowledge if unset)
TAVILY_API_KEY=tvly-...

# Optional — enable full on-chain merge ceremony
# MEMFORK_RESOLVER_ID=0x...

# Optional — override the model (default: gpt-4o-mini)
# OPENAI_MODEL=gpt-4o
```

### 3. Run

```bash
npm run research "microservices vs monolith for a fintech startup"
```

---

## Usage

### Basic research

```bash
npm run research "your research question here"
```

The pipeline:
1. Supervisor breaks the question into two sub-topics
2. Two workers research in parallel on separate MemForks branches, each recalling prior findings first
3. Supervisor combines both streams into a final report, also recalling any prior supervisor-level synthesis
4. All findings are committed to MemForks — the next run builds on this

### Resume a killed run

If the pipeline is interrupted, restart with the same question. The checkpointer restores each agent from its last committed state. Workers that already finished do not re-run.

```bash
# First run — interrupted mid-way
npm run research "microservices vs monolith for a fintech startup"
^C

# Resume — supervisor picks up exactly where it stopped
npm run research "microservices vs monolith for a fintech startup"
```

### Force a fresh run

```bash
npm run research "microservices vs monolith" --fresh
```

This creates new branch IDs (new Walrus blobs, new on-chain branches). Prior knowledge is still accessible via recall — workers will pull it in at the start of their first step regardless.

---

## The compounding memory demo

Run the same question twice:

**First run:**
```
[Worker research-a] No prior research found — starting from scratch.
[Worker research-a] Committed findings to branch thread/research-a
[Worker research-b] No prior research found — starting from scratch.
[Worker research-b] Committed findings to branch thread/research-b
[Supervisor] Synthesizing final report...
```

**Second run:**
```
[Worker research-a] Recalled 1 prior finding(s) — building on them.
[Worker research-a] Committed findings to branch thread/research-a
[Worker research-b] Recalled 1 prior finding(s) — building on them.
[Worker research-b] Committed findings to branch thread/research-b
[Supervisor] Synthesizing final report...
```

The second report is deeper. Workers don't repeat what they already know — they identify gaps and go further. The supervisor's prior synthesis is also recalled, so the final report compounds across every run.

---

## On-chain merge vs. simple merge

**Simple merge** (`MEMFORK_RESOLVER_ID` not set, the default):

The supervisor commits its synthesis directly to `thread/supervisor`. Worker findings are in the synthesis prompt but no on-chain merge transaction is created. Works immediately, no resolver contract needed.

**Full on-chain merge** (`MEMFORK_RESOLVER_ID` set):

- `proposeMerge()` creates a Sui Move `MergeProposal` object on-chain
- A resolver daemon (the service in `services/resolver`) attests to the merge via jury / LLM workers
- `finalizeMerge()` settles the branch head on-chain
- Every merge is auditable: proposal ID, attestation transactions, blob IDs, timestamps

For local development, simple merge is sufficient. The full ceremony is the production story and what the demo video uses.

---

## Extending the pipeline

### Change the model

The checkpointer is model-agnostic. The LLM is configured in `src/research.ts`:

```typescript
const llm = new ChatOpenAI({
  model:       process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0.3,
});
```

Set `OPENAI_MODEL=gpt-4o` in `.env` or swap to a different provider in `src/research.ts`.

### Add more worker branches

The `runWorker` function in `src/agents/worker.ts` is generic — give it a topic, a thread ID, and a checkpointer. Extend `src/agents/supervisor.ts` to dispatch a third worker:

```typescript
const [findingsA, findingsB, findingsC] = await Promise.all([
  runWorker({ topic: state.topicA, threadId: threadA, checkpointer, llm }),
  runWorker({ topic: state.topicB, threadId: threadB, checkpointer, llm }),
  runWorker({ topic: state.topicC, threadId: threadC, checkpointer, llm }),
]);
```

### Cross-question recall

Workers recall by topic, not by question. A worker on `thread/research-a` accumulates knowledge across every run that used that thread. Ask "microservices for healthcare" next and the worker already has fintech context — it recalls it, notes the overlap, and builds on it.

---

## Relationship to memforks-chat

|                | memforks-chat               | memforks-research                     |
| -------------- | --------------------------- | ------------------------------------- |
| Interface      | Browser UI                  | CLI / Node script                     |
| Users          | Single user, conversational | Automated pipeline                    |
| Agents         | One (the LLM)               | Supervisor + 2 workers                |
| Branching      | Manual (user clicks)        | Programmatic (supervisor creates)     |
| Merge          | Simple (recall → commit)    | Full on-chain ceremony (if configured)|
| SDK            | `@memfork/vercel-ai` (Node) | `@memfork/langgraph` (Node)           |
| Shows          | Persistent personal memory  | Compounding multi-agent knowledge     |
