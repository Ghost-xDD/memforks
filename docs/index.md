---
layout: doc
aside: false
sidebar: false
pageClass: memforks-landing-page
---

<section class="mf-landing-hero">
  <span class="mf-hero-mark">
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M24 4 L42 14 L42 34 L24 44 L6 34 L6 14 Z" stroke="currentColor" stroke-width="3" stroke-linejoin="round" />
      <circle cx="19" cy="15.5" r="3.2" stroke="currentColor" stroke-width="2.8" />
      <circle cx="30" cy="19.5" r="3.2" stroke="currentColor" stroke-width="2.8" />
      <path d="M19 18.7 L19 39.5" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" />
      <path d="M30 22.7 L30 26.5 L19 32.5" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </span>
  <p class="mf-eyebrow">MemForks Documentation</p>
  <h1>Git for <span class="mf-grad">AI agent memory</span></h1>
  <p>
    Branch-aware, verifiable, mergeable memory anchored on Sui. Fork an
    experiment, let it diverge, diff what it learned, then merge trusted
    knowledge back into main.
  </p>
  <div class="mf-hero-actions">
    <a href="/getting-started/quickstart">Get started →</a>
    <a href="/concepts/overview">Learn the model</a>
  </div>
</section>

<section class="mf-pillars" aria-label="What MemForks gives agents">
  <div>
    <h3>Verifiable</h3>
    <p>Every memory is anchored on Sui and stored in Walrus — provenance you can audit, not trust blindly.</p>
  </div>
  <div>
    <h3>Branch-aware</h3>
    <p>Agents inherit memory along lineage. Branches diverge cleanly and stay queryable, never contaminated.</p>
  </div>
  <div>
    <h3>Mergeable</h3>
    <p>Promote what an experiment learned back to main through governed, reviewable merges — not blind writes.</p>
  </div>
</section>

<p class="mf-section-label">Explore the docs</p>

<section class="mf-card-grid" aria-label="Documentation sections">
  <a class="mf-card" href="/getting-started/quickstart">
    <span>01</span>
    <h2>Get Started</h2>
    <p>Install the CLI, provision a memory tree, verify setup, and make your first branch commit.</p>
  </a>

  <a class="mf-card" href="/concepts/overview">
    <span>02</span>
    <h2>Concepts</h2>
    <p>Understand MemWal vs MemForks, branch lineage, commits, diffs, and merge governance.</p>
  </a>

  <a class="mf-card" href="/architecture/">
    <span>03</span>
    <h2>Architecture</h2>
    <p>Explore the Sui, Walrus, MemWal, SDK, CLI, and adapter layers that power the system.</p>
  </a>

  <a class="mf-card" href="/sdk/core">
    <span>04</span>
    <h2>Core SDK</h2>
    <p>Use <code>@memfork/core</code> directly for branch, commit, recall, delegate, and merge flows.</p>
  </a>

  <a class="mf-card" href="/sdk/vercel-ai">
    <span>05</span>
    <h2>Vercel AI SDK</h2>
    <p>Add branch-aware recall and auto-commit to chat, streaming, and structured generation.</p>
  </a>

  <a class="mf-card" href="/sdk/langgraph">
    <span>06</span>
    <h2>LangGraph</h2>
    <p>Persist graph checkpoints to MemForks and map each LangGraph thread to a memory branch.</p>
  </a>

  <a class="mf-card" href="/cli/">
    <span>07</span>
    <h2>CLI</h2>
    <p>Provision trees, inspect status, create branches, recall facts, commit memory, and propose merges.</p>
  </a>

  <a class="mf-card" href="/examples/chat">
    <span>08</span>
    <h2>Examples</h2>
    <p>Run the Next.js chat app and LangGraph research workflow to see MemForks in practice.</p>
  </a>

  <a class="mf-card" href="/operations/troubleshooting">
    <span>09</span>
    <h2>Operations</h2>
    <p>Configure hosted apps, troubleshoot credentials, and run gas sponsorship infrastructure.</p>
  </a>
</section>

<section class="mf-landing-model">
  <div>
    <h2>Memory with lineage</h2>
    <p>
      MemWal stores encrypted memories and recalls them by meaning. MemForks adds
      the version-control layer: which branch learned a fact, what it inherited,
      and how knowledge should merge back.
    </p>
  </div>

```text
main:          c1 ── c2 ── c3 ─────────── c7
                          \                /
hypothesis-a:              c4 ── c5 ──────
                               \
hypothesis-b:                   c6          abandoned, still queryable
```
</section>
