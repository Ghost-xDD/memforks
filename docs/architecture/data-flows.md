# Data Flows

This page shows the main runtime flows in MemForks.

## Recall

Recall is semantic search scoped to a branch.

```mermaid
sequenceDiagram
  participant App
  participant Core as @memfork/core
  participant MemWal
  participant Relayer as MemWal relayer
  participant Walrus

  App->>Core: recall(query, { branch })
  Core->>MemWal: recall({ query, namespace })
  MemWal->>Relayer: authenticated semantic search
  Relayer->>Relayer: vector search by namespace
  Relayer->>Walrus: fetch matching blobs
  Walrus-->>Relayer: encrypted blob content
  Relayer-->>MemWal: decrypted ranked results
  MemWal-->>Core: results
  Core-->>App: facts with distance and blobId
```

## Commit

Commit writes a JSON payload through MemWal. It does not require a Sui transaction for every fact.

```mermaid
sequenceDiagram
  participant App
  participant Core as @memfork/core
  participant Head as Local head tracker
  participant MemWal
  participant Walrus

  App->>Core: commit(branch, { facts, message })
  Core->>Head: read current branch head
  Core->>Core: build commit payload
  Core->>Core: hash payload
  Core->>MemWal: rememberAndWait(payloadJson)
  MemWal->>Walrus: upload content-addressed blob
  Walrus-->>MemWal: blob_id
  MemWal-->>Core: remember result
  Core->>Head: advance local branch head
  Core-->>App: { blobId, contentHash }
```

## Branch

Branch creation is on-chain because it changes the `MemoryTree`.

```mermaid
sequenceDiagram
  participant App
  participant Core as @memfork/core
  participant Sui
  participant Head as Local head tracker

  App->>Core: branch("experiment/a", { from: "main" })
  Core->>Sui: tree::branch transaction
  Sui-->>Core: transaction digest
  Core->>Head: copy parent live head to new branch
  Core-->>App: digest
```

The new branch inherits the parent's head without copying memory blobs.

## Semantic Merge

Simple apps often implement a semantic cherry-pick merge.

```mermaid
flowchart TD
  Source["source branch"] --> Sweep["recall broad sweep queries"]
  Sweep --> Dedupe["dedupe recalled fact text"]
  Dedupe --> Review["optional human or app review"]
  Review --> Commit["commit selected facts to target"]
  Commit --> Target["target branch updated"]
```

This pattern is used by the reference chat app. It is not the full governed merge ceremony, but it is useful for product workflows.

## Governed Merge

Governed merges create an on-chain proposal and let a resolver settle the result.

```mermaid
sequenceDiagram
  participant App
  participant Core as @memfork/core
  participant Sui
  participant Resolver
  participant MemWal

  App->>Core: proposeMerge({ fromBranch, intoBranch, resolverId })
  Core->>Sui: resolver::propose_merge transaction
  Sui-->>Core: proposal digest
  Resolver->>Sui: watch MergeProposed events
  Resolver->>MemWal: fetch and reconcile branch memories
  Resolver->>Sui: submit attestations
  Resolver->>Sui: finalize merge
```

## Vercel AI SDK Adapter

```mermaid
flowchart TD
  Request["streamText or generateText"] --> Middleware["@memfork/vercel-ai"]
  Middleware --> Recall["recall branch facts"]
  Recall --> Prompt["inject system context"]
  Prompt --> Model["call model"]
  Model --> Response["return response"]
  Response --> AutoCommit["autoCommit response facts"]
  AutoCommit --> BranchMemory["branch memory"]
```

## LangGraph Checkpointer

Each LangGraph thread maps to a branch by default.

```mermaid
flowchart LR
  ThreadA["thread_id: research-a"] --> BranchA["branch: thread/research-a"]
  ThreadB["thread_id: research-b"] --> BranchB["branch: thread/research-b"]
  Supervisor["thread_id: supervisor"] --> BranchSupervisor["branch: thread/supervisor"]
  BranchA --> Merge["proposeMerge"]
  BranchB --> Merge
  Merge --> BranchSupervisor
```

The checkpointer persists graph checkpoints through MemForks, so state can resume across processes and machines.
