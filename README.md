# MemForks

**Git for AI agent memory.** Branchable, mergeable, verifiable memory for autonomous agents — built on Sui, MemWal, Walrus, and SEAL.

```
main:        c1 ── c2 ── c3 ─────────── c7 (HEAD)
                       \                /
hypothesis-A:           c4 ── c5 ──────/      (merged)
                            \
hypothesis-B:                c6                (abandoned, still queryable)
```

Sui Overflow 2026 · Walrus Track

---

## Quick start

### Prerequisites

- [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install) ≥ 1.73  
  _(current testnet server version; upgrade with `suiup install sui`)_
- Node.js ≥ 20
- A funded testnet address (`sui client faucet`)

### First-time setup

```bash
# 1. Health check — run this first
memfork doctor

# 2. Create a MemoryTree on testnet
memfork init
```

### Deploy the contracts (development)

```bash
./scripts/deploy.sh
```

The script writes the package ID to `.deployed.env`.  Source it before running spikes:

```bash
source .deployed.env
```

---

## Repository structure

```
contracts/          Sui Move package (memforks::tree, ::acl, ::resolver)
sdk/                @memfork/core TypeScript SDK
spikes/             Phase 0 spike scripts (D-1 … D-4) — see SPIKES.md
scripts/            Deploy + seed helpers
.github/workflows/  CI — Move build/test + SDK typecheck
research/           PRD, SPEC, DX, DEMO, IMPLEMENTATION docs
```

> **Not a monorepo.** Each directory (`sdk/`, `spikes/`) is an independent
> package with its own `package.json`.  There is no root-level workspace.

---

## Phase status

| Phase | Theme | Status |
|---|---|---|
| **0** | De-risk + scaffold | 🔄 In progress |
| **1** | Core graph MVP | ⬜ Not started |
| **2** | Resolvers + merge protocol | ⬜ Not started |
| **3** | Adapters, plugins, CLI, UI | ⬜ Not started |
| **4** | Demos, traction, ship | ⬜ Not started |

See [`SPIKES.md`](./SPIKES.md) for the Phase 0 gate checklist.  
See [`research/IMPLEMENTATION.md`](./research/IMPLEMENTATION.md) for the full plan.

---

## Spec version

Protocol spec: [`research/SPEC.md`](./research/SPEC.md) v0.1.0 (locked)

---

## License

Apache-2.0
