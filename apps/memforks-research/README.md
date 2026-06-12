# memforks-research

A reference multi-agent research pipeline demonstrating MemForks' branching and merge governance model — built with LangGraph and `@memfork/langgraph`.

---

## What this demonstrates

Where `memforks-chat` shows single-user conversational memory, this app shows **automated multi-agent workflows** where parallel agents accumulate knowledge on separate branches, then merge their findings on-chain.

The key MemForks capability on display here is **compounding memory**: run the same research question twice and the second run builds on the first. Workers recall what they already know, skip ground they've covered, and go deeper. Knowledge accumulates over time instead of starting fresh every invocation.

```
Question: "What are the tradeoffs of microservices vs. monolith for a fintech startup?"
         │
         ├─→ Worker A  branch: thread/research-microservices
         │   recalls prior microservices research
         │   searches, synthesises, commits findings
         │
         ├─→ Worker B  branch: thread/research-monolith
         │   recalls prior monolith research
         │   searches, synthesises, commits findings
         │
         └─→ Supervisor  branch: main
             waits for both workers to complete
             proposeMerge(A → main), proposeMerge(B → main)
             recalls from merged context
             produces final report
```

---

## Why this is different from a normal LangGraph app

| | SQLite / in-memory checkpointer | MemForks checkpointer |
|---|---|---|
| Checkpoint storage | Local file or RAM | Walrus blobs — permanent, content-addressed |
| State recovery | Re-run the process | Resume from anywhere, any machine |
| Cross-thread recall | Not possible | `checkpointer.recall(query, { threadId })` |
| Parallel branches | Separate thread IDs, no relationship | On-chain branch objects with parent lineage |
| Merging knowledge | Manual, undefined | `proposeMerge()` → on-chain governance |
| Audit trail | None | Every checkpoint anchored on Sui |

The moment that shows the difference: kill the process mid-research, restart, and the pipeline resumes exactly from the last checkpoint. Worker A is still mid-way through its findings. Worker B already finished. The supervisor picks up where it left off. None of this is in a local file — it's in Walrus.

---

## Architecture

### Thread → branch mapping

Each LangGraph thread maps to a MemForks branch via the `threadToBranch` convention:

```
LangGraph thread ID          MemForks branch
─────────────────────────    ──────────────────────────────────
research-microservices    →  thread/research-microservices
research-monolith         →  thread/research-monolith
supervisor                →  thread/supervisor  (or "main")
```

Memory is fully isolated per thread at the MemWal level — `(treeId, branchName)` is the namespace key.

### Checkpoint flow

```
Worker A step N completes
       │
       ▼
checkpointer.put(config, checkpoint, metadata)
       │
       ├── client.commit("thread/research-microservices", {
       │     facts: ["checkpoint_id:...", <full state JSON>],
       │     message: "checkpoint: thread=research-microservices step=N"
       │   })
       │
       └── returns updated config with { memforks_blob_id, memforks_branch }

Worker A step N+1 starts
       │
       ▼
checkpointer.getTuple(config)
       │
       └── client.recall("memforks_blob_id:<id>", { branch })
           returns exact blob → restores state
```

### Merge ceremony

After both workers complete, the supervisor uses `checkpointer.proposeMerge()`:

```
proposeMerge({ fromThread: "research-microservices", intoThread: "supervisor", resolverId })
       │
       ▼
client.proposeMerge({ fromBranch: "thread/research-microservices",
                      intoBranch: "thread/supervisor",
                      resolverId })
       │
       ▼
Sui Move tx → MergeProposal object created on-chain
       │
       ▼
Resolver daemon attests → finalizeMerge() → branch head settled on Sui
```

Once settled, `recall()` on the supervisor branch surfaces facts from both worker branches. The final report is grounded in merged, verified knowledge.

---

## Project structure

```
apps/memforks-research/
├── research_agent.py        entry point — parse args, build graph, run pipeline
├── agents/
│   ├── supervisor.py        orchestrates workers, merges, writes final report
│   ├── worker.py            reusable worker agent (recall → research → commit)
│   └── tools.py             web search, summarise, recall tool wrappers
├── graph.py                 LangGraph StateGraph definition
├── state.py                 shared AgentState type
├── checkpointer.py          MemForksCheckpointer setup + thread naming helpers
├── requirements.txt         Python deps
└── .env.example             env var template
```

---

## Prerequisites

- Python ≥ 3.11
- A MemForks tree provisioned on Sui testnet (`memfork init --quick`)
- An OpenAI API key
- A deployed resolver contract ID (for `proposeMerge` — see below)

---

## Setup

### 1. Install dependencies

```bash
cd apps/memforks-research
pip install -r requirements.txt
```

### 2. Configure environment

```env
# OpenAI
OPENAI_API_KEY=sk-...

# MemForks
MEMFORK_TREE_ID=0x...
MEMFORK_PRIVATE_KEY=suiprivkey1...
MEMFORK_NETWORK=testnet

# MemWal
MEMFORK_MEMWAL_ACCOUNT=0x...
MEMFORK_MEMWAL_KEY=...
MEMFORK_RELAYER_URL=https://relayer.staging.memwal.ai

# Resolver — Sui object ID of a deployed MemForks resolver contract
# Required for the full on-chain merge ceremony.
# Leave empty to use simple merge (recall → commit) instead.
MEMFORK_RESOLVER_ID=0x...
```

### 3. Run

```bash
python research_agent.py "microservices vs monolith for a fintech startup"
```

---

## Usage

### Basic research

```bash
python research_agent.py "your research question here"
```

The pipeline:
1. Supervisor breaks the question into two sub-questions
2. Workers research in parallel on separate branches
3. Supervisor merges findings and produces a report
4. All knowledge is committed to MemForks — the next run builds on it

### Resume a killed run

If the pipeline is interrupted, restart with the same question. The checkpointer restores each agent from its last committed state. Workers that already finished do not re-run.

```bash
# First run — interrupted at Worker A step 3
python research_agent.py "microservices vs monolith for a fintech startup"
^C

# Resume — Worker B already finished, Worker A resumes from step 3
python research_agent.py "microservices vs monolith for a fintech startup"
```

### Force a fresh run

```bash
python research_agent.py "microservices vs monolith" --fresh
```

This creates new thread IDs (new branches). Prior knowledge is still accessible via recall — workers will pull it in at the start of their first step.

---

## The compounding memory demo

Run the same question twice:

**First run output:**
```
[Worker A] No prior research found. Starting from scratch.
[Worker A] Researching: microservices in fintech...
[Worker A] Committed 4 findings to thread/research-microservices
...
[Supervisor] Final report: ...
```

**Second run output:**
```
[Worker A] Recalled 4 prior findings on microservices. Building on them.
[Worker A] Researching: gaps identified — regulatory compliance patterns...
[Worker A] Committed 3 new findings to thread/research-microservices
...
[Supervisor] Final report: (deeper, references first-run findings)
```

This is the moment that distinguishes MemForks from a database: the agent doesn't repeat what it already knows. It recalls, builds on it, and goes deeper. Knowledge compounds.

---

## On-chain merge vs. simple merge

The pipeline supports both:

**Simple merge** (no `MEMFORK_RESOLVER_ID` set):
- Recalls facts from worker branches, commits them onto the supervisor branch
- Works immediately, no resolver contract needed
- Same mechanism as the merge button in `memforks-chat`

**Full on-chain merge** (`MEMFORK_RESOLVER_ID` set):
- `proposeMerge()` creates an on-chain Sui Move `MergeProposal` object
- A resolver daemon attests to the merge (jury / LLM reconciliation)
- `finalizeMerge()` settles the branch head on-chain
- Every merge is auditable: who proposed it, when, from what blob IDs
- This is MemForks' core governance differentiator

For the demo, simple merge is sufficient. The full ceremony is the production story.

---

## Extending the pipeline

### Add more worker agents

The `WorkerAgent` class is generic — give it a topic and it handles recall, research, and commit. Add as many workers as your question needs:

```python
workers = [
    WorkerAgent(topic="regulatory compliance in fintech"),
    WorkerAgent(topic="team structure and scaling"),
    WorkerAgent(topic="deployment complexity"),
]
```

### Use a different LLM

The checkpointer is model-agnostic. Swap the model in `agents/worker.py`:

```python
# Switch from OpenAI to Anthropic
from langchain_anthropic import ChatAnthropic
llm = ChatAnthropic(model="claude-opus-4-5")
```

### Cross-question recall

Workers use `checkpointer.recall()` at the start of each run. This means a worker on `thread/research-microservices` accumulates knowledge across *all* questions that involved microservices. Ask "microservices for healthcare" and the worker already knows fintech context — it recalls it and notes the overlap.

---

## Relationship to memforks-chat

| | memforks-chat | memforks-research |
|---|---|---|
| Interface | Browser UI | CLI / Python script |
| Users | Single user, conversational | Automated pipeline |
| Agents | One (the LLM) | Supervisor + N workers |
| Branching | Manual (user clicks) | Programmatic (supervisor creates) |
| Merge | Simple (recall → commit) | Full on-chain ceremony |
| SDK | `@memfork/vercel-ai` (Node) | `@memfork/langgraph` (Python) |
| Shows | Persistent personal memory | Compounding multi-agent knowledge |

---

## Roadmap

- **Streaming output** — pipe worker findings to stdout as they are committed
- **Branch graph output** — print the branch DAG at the end of each run
- **Custom resolver** — include a simple LLM-based resolver daemon so the full merge ceremony runs end-to-end without a separately deployed contract
- **Web UI** — a minimal dashboard showing active worker branches, checkpoint history, and merge status in real time
