---
status: accepted
date: 2026-06-03
---

# Agents own all side effects; main.ts is pure orchestration

Each agent in the advanced loop owns its own `gh` calls, `git` writes, and label edits inside its scope, and self-discovers repo vocabulary from `docs/agents/triage-labels.md`. `main.mts` sequences agents and reads only the Zod-validated output it actually consumes. The host has zero `gh`, zero `git`, zero label strings, zero English text generation.

We picked this over a host-owns-side-effects model so each agent prompt is runnable by a human with Claude Code + `gh` + `git` alone (no sandcastle required), vocabulary edits ripple through a single source-of-truth file, and `main.mts` stays small (~340 lines today). The schema-scope corollary — `main.mts` carries a Zod schema only for agents whose output it consumes — falls out of the same principle: keep domain vocabulary inside prompts where it belongs.

## Considered options

- **Host owns `gh` and `git`; agents emit structured data.** Tighter Zod surface but `main.mts` carries every label string + English text template, and each agent's contract becomes coupled to host code. Agents stop being runnable by hand.
- **Hybrid (host owns `gh`; agents own `git` + labels).** Inconsistent contract; the host/agent seam migrates as features land; harder to reason about which side owns what.
