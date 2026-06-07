# Contributing to MemForks

Thanks for your interest in contributing. This document covers how to get started, what's worth working on, and how to get a pull request merged.

---

## Getting oriented

Read the README first, then `docs/architecture.md` for a deeper look at how the layers fit together. The codebase is a TypeScript monorepo with a small contracts directory:

```
contracts/    on-chain logic
sdk/          @memfork/core — the TypeScript client
cli/          @memfork/cli — the memfork binary
adapters/     framework integrations (LangGraph, Vercel AI, …)
plugins/      coding-agent plugins (Cursor, Codex)
runtime/      off-chain resolver daemon
app/          DAG visualizer
tests/        cli unit, integration, and E2E tests
```

---

## Setting up locally

```bash
git clone https://github.com/memforks-dev/memforks.git
cd memforks
npm install
npm run build
```

To run tests:

```bash
cd tests/cli
node --test
```

To spin up the DAG visualizer:

```bash
cd app && npm run dev
```

---

## What to work on

Good first issues are labelled [`good first issue`](../../issues?q=is%3Aopen+label%3A%22good+first+issue%22) on GitHub. Broader areas where contributions are welcome:

- **New adapters** — any agent framework that needs a checkpointer or middleware (CrewAI, AutoGen, smolagents, …)
- **New resolver kinds** — implement a new merge strategy in the off-chain resolver daemon
- **CLI UX** — error messages, `memfork doctor` checks, shell completions
- **DAG visualizer** — layout improvements, diff view, branch filtering
- **Docs** — examples, walkthroughs, architecture diagrams

If you have a larger idea, open an issue first so we can align on scope before you write code.

---

## Pull request process

1. Fork the repo and create a branch from `main`.
2. Make your changes. Keep commits focused — one logical change per commit.
3. Add or update tests where relevant. The test suite runs with `node --test` in `tests/cli/`.
4. Make sure `npm run build` passes cleanly.
5. Open a PR with a clear description of *what* changed and *why*.

There is no CLA. By submitting a PR you agree that your contributions are licensed under Apache-2.0.

---

## Code style

- TypeScript throughout. No `any` unless genuinely unavoidable.
- Prefer explicit types on public function signatures.
- No unnecessary comments — code should read clearly on its own.
- Match the style of the surrounding file rather than introducing new patterns.

---

## Reporting bugs

Open a GitHub issue. Include:

- What you ran
- What you expected
- What actually happened (full error output if applicable)
- Your OS, Node version, and `memfork --version`

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).
