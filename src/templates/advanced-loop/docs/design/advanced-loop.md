---
last_revised: 2026-06-10
status: current state
audience: developers extending the advanced-loop template
---

# Advanced loop — design

The architecture of the autonomous coding loop that ships as the `advanced-loop` sandcastle template. Operator-facing docs are in [`README.md`](../../README.md); this file is what you need to know to safely change the loop without breaking its invariants.

## Mission

The loop takes a PRD's triaged GitHub Issues, implements each one with tests, opens a draft PR, and labels it for human review. It **never** auto-merges to `main`, **never** loses work (stuck implementer state is preserved on `wip/issue-<N>`), and **never** requires LLM judgment for vocabulary or mechanical bookkeeping where deterministic alternatives exist.

## Architectural principle (load-bearing)

> Agents own all side effects within their scope, including `gh` calls, `git` writes, and label edits. Each agent self-discovers repo vocabulary by reading `docs/agents/triage-labels.md`. `main.mts` sequences agents and reads only the Zod-validated output it actually consumes; it has zero `gh`, zero `git`, zero label strings, zero English text generation.

A corollary: `main.mts` carries a Zod schema only for agents whose output it consumes (currently just the planner — see § The four agents). Reviewer / pr-composer / implementer have no schemas; their work is observable as side effects on the PR.

See [ADR-0001](../adr/0001-agents-own-side-effects.md) for the why and the considered alternatives.

## Target repo assumptions

This template is designed around a specific tech stack that should be present in the target repo where it will be used. Changing any of these means surgery on the prompts or `main.mts`, not config.

- **GitHub repo + Issues.** Prompts hardcode `gh issue`, `gh pr`, `gh api graphql`. Scaffold with `sandcastle init --issue-tracker github-issues`; other trackers won't work end-to-end even though the Dockerfile's `{{ISSUE_TRACKER_TOOLS}}` token will substitute the right CLI install.
- **Node.js + pnpm target.** The Dockerfile bakes corepack + a pnpm store; `main.mts` runs `pnpm install --prefer-offline` on each sandbox start.
- **Skills sourced from [`harisjavaid85/ai-agent-skills`](https://github.com/harisjavaid85/ai-agent-skills).** `setup-repo-skills` scaffolds `docs/agents/triage-labels.md`, `docs/agents/commit-tags.md`, an `AGENTS.md` preamble, and the `kind:prd` label from this repo. The same repo's skills (`/tdd`, `/commit`, `/code-review`, `/diagnose`) are baked into the `Dockerfile`.

## Pipeline

```
Human (per PRD):
  /grill-with-context → /to-prd → /to-issues → /triage

Loop (npx tsx .sandcastle/main.mts, defaults to auto):
  while (within limits):
    plan = sandbox.run(planner)
    if (plan.unblockedIssues.length === 0):
      if (plan.openIssues.length === 0):
        phasePR(plan, mode=complete) + phaseReview() → exit 0
      empty-plan-retry: throw IncompleteError
    detect-same-issue-retry: throw IncompleteError
    for (issue of plan.unblockedIssues):
      sandbox.run(implementer, issueNum)
  throw IncompleteError("outer iteration limit reached")

  catch IncompleteError as e:
    phasePR(undefined, mode=partial, reason=e.message) + phaseReview()
    rethrow → exit 1

Human (when PR has ready-for-human label):
  Review, squash-merge.
```

### Outer-loop end-states

| Closed | Open | Exit reason                                                      | Path                                                   | Exit |
| ------ | ---- | ---------------------------------------------------------------- | ------------------------------------------------------ | ---- |
| all    | none | empty plan + empty open queue                                    | `phasePR(complete)` + `phaseReview()`                  | 0    |
| any    | any  | outer iter (20) / wall-time (4h) / same-issue ×2 / empty-plan ×1 | `IncompleteError` → `phasePR(partial)` + `phaseReview` | 1    |
| any    | any  | planner Zod-output invalid (`StructuredOutputError`)             | propagates; no finalize                                | 2    |
| any    | any  | planner `plan.error` set (config failure)                        | propagates as plain `Error`; no finalize               | 2    |

Planner failures are not partially-finalized because finalize re-invokes the planner, which would re-throw and mask the original cause.

## The four agents + `main.mts`

| Agent       | Model                        | maxIter | Wall-time | Zod schema (consumed by `main.mts`)                  | Side-effect contract                                                                                                                       |
| ----------- | ---------------------------- | ------- | --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Planner     | Opus                         | 1       | 5 min     | `{unblockedIssues, openIssues, wipBranches, error?}` | None beyond reads.                                                                                                                         |
| Implementer | Sonnet                       | 1       | 15 min    | —                                                    | Commits on `agent/<slug>`; on completion closes the issue; on bail-out pushes `wip/issue-<N>` and swaps the issue's label to `needs-info`. |
| PR-composer | Sonnet                       | 1       | 5 min     | —                                                    | Drafts/updates a PR; in complete mode strips stale `needs-info`; in partial mode adds `needs-info` + status comment.                       |
| Reviewer    | Opus (full) / Sonnet (light) | 1       | 15 min    | —                                                    | Commits review fixes; labels PR `ready-for-human` (clean exit) or `needs-info` (full-mode judgment findings filed as new issues).          |

Prompts live in `.sandcastle/`:

- `planner-prompt.md`
- `implementer-prompt.md`
- `pr-composer-prompt.md`
- `light-reviewer-prompt.md` (default)
- `full-reviewer-prompt.md` (opt-in)

Each prompt orchestrates skills (`/tdd`, `/commit`, `/code-review`, `/diagnose`), self-discovers vocabulary from `docs/agents/triage-labels.md`, and reads `AGENTS.md` / `CONTEXT.md` / `README.md` for project conventions.

### Planner

Returns `unblockedIssues` (workable now), `openIssues` (everything still open, minus `wontfix`), `wipBranches` (existing `wip/issue-*`). Parses `## Blocked by` body sections to compute "workable now"; no `blocked` label. Filters `wontfix` whether open or closed — humans can leave `wontfix` issues open as tombstones. Optional `error: {code, message}` field surfaces config failures (e.g. unresolvable label vocabulary); planner stays strictly side-effect-free, host catches and rethrows.

### Implementer

One issue per invocation. Delegates discipline to `/tdd` (recognizes refactor-only changes internally) + `/commit`. Discovers Fast-tier verify commands via `AGENTS.md` → `CONTEXT.md` → `README.md` → `package.json` scripts; fails loudly if none surfaces. On normal completion: commit + push + close. On bail-out (e.g. `/diagnose` exhausted): push `wip/issue-<N>` and swap the issue's `ready-for-agent` label for `needs-info`. Never leaves broken state on `agent/<slug>`.

### PR-composer

Drafts or updates the single draft PR for the run. Body includes a `## PRD\nImplements #<tracker>.` pointer rather than quoting the tracker body verbatim (avoids staleness if the PRD evolves post-PR). In complete mode: reads PR labels via `gh pr view --json labels`; if `needs-info` is present, removes it (closes the deadlock where a previous partial cycle's stale label would cause the reviewer to self-gate and skip). In partial mode: adds `needs-info` + a status comment whose body carries the `IncompleteError.message` verbatim.

### Reviewer — two modes

The reviewer is invoked in one of two modes, selected upfront per PRD via `--review=light|full` (light is default).

**Light mode** (`light-reviewer-prompt.md`, Sonnet) — a thin co-author. Reads the PRD + `AGENTS.md` + `git diff`, edits in place for clarity / redundancy / safety, fast-tier-verifies each edit with revert-on-fail, commits and pushes passing edits, adds `ready-for-human` at clean exit. No `/code-review`, no inline comments, no judgment-issue filing, no `needs-info` ever (clean exit only).

**Full mode** (`full-reviewer-prompt.md`, Opus) — the heavy reviewer. Delegates depth-finding to `/code-review --comment` (medium effort pinned for v1), then classifies each finding:

| Bucket         | Examples                                                                  | Action                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mechanical** | Typo, formatting, naming nit, missing null check, obvious missing test    | Read file → Edit → Fast verify (revert + reclassify on fail) → `/commit auto` → reply to thread → resolve thread.                                                              |
| **Judgment**   | Wrong logic, bad abstraction, perf regression, security, intent-dependent | File new issue (`prd:<slug>` + `needs-info`), title `Review: <imperative summary>`, body uses the same `/to-issues` envelope. Reply on thread with issue URL → resolve thread. |
| **Skip**       | Out-of-scope vs PRD                                                       | Reply on thread with `Skipped: complies with PRD #<n>` → resolve thread.                                                                                                       |

Judgment findings become first-class triageable work items: human `/triage`s the new issue, flips `needs-info` → `ready-for-agent`, and the loop picks it up next tick. This preserves "no agent touches judgment findings without explicit human intent" while collapsing the reviewer's special lifecycle into the same primitives the rest of the loop uses (issues, labels, planner, implementer).

**Self-gate (both modes)**: first action is `gh pr view --json labels`. If `needs-info` is present, log "skipping — incomplete PR" and exit. Lets `main.mts` invoke reviewer unconditionally; humans running reviewer by hand against a partial PR are protected from accidentally green-lighting it.

**Thread operations** (full mode): all three (read / reply / resolve) go through `gh api graphql`. REST has no `isResolved` field, so the read query must be GraphQL; keeping all three on the same API surface avoids carrying two parallel identifiers (REST `databaseId` + GraphQL `thread.id`) through the prompt.

**Picking light vs full**: upfront human call per PRD. Light fits most cases (clarity / safety / redundancy refinement on a draft PR). Full fits PRDs where deeper correctness review is warranted — e.g. security-sensitive code or non-trivial new logic where `/code-review`'s heavier analysis is worth the cost.

## Vocabulary

**Single source of truth: `docs/agents/triage-labels.md`.** Markdown, human-edited. Agents resolve canonical → actual at runtime. `main.mts` has zero label strings.

Canonical label roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. A target repo can rename the right-hand actual labels; canonical names stay fixed.

**`kind:prd` is a fixed structural marker** (not part of the canonical role vocabulary). The PRD tracker issue carries `prd:<slug>` + `kind:prd`. All consumers find the tracker via positive lookup: `gh issue list --label "prd:<slug>" --label "kind:prd"`. Positive lookup decouples tracker discovery from the triage role vocabulary; consumers don't need to know what counts as "not a work item."

`kind:prd` is a one-member namespace — it's a structural marker, not a classification axis. A general `kind:bug` / `kind:feature` / etc. classification is in § Known limitations.

**Naming conventions:**

| Artifact                      | Pattern                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| Agent's working branch        | `agent/<prd-slug>`                                                       |
| Stuck-implementer WIP         | `wip/issue-<N>`                                                          |
| PRD scoping label             | `prd:<prd-slug>`                                                         |
| Tracker structural marker     | `kind:prd` (fixed string)                                                |
| PRD tracker issue             | open issue carrying `prd:<slug>` + `kind:prd` (body holds the PRD prose) |
| Reviewer-filed judgment issue | title `Review: <imperative summary>`; labels `prd:<slug>` + `needs-info` |

`<scope>:<value>` namespaces labels so they don't collide with existing repo labels and extends to future axes. Re-runs against the same PRD land deterministically; no timestamps in names.

## PRD lifecycle

A PRD is a GitHub tracker issue bound by slug. The PRD prose lives **in the tracker body** — there is no `tasks/<slug>/PRD.md` file. See [ADR-0002](../adr/0002-prd-in-tracker-issue-body.md) for the why.

| Artifact                     | Created by                               | Lifecycle                                                                                                                                            |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracker issue (PRD body)     | `/to-prd <slug>`                         | Labels: `prd:<slug>` + `kind:prd`. Body holds the PRD prose. Edits via `gh issue edit`. Human closes at PR merge.                                    |
| Remote branch `agent/<slug>` | `/to-prd <slug>` (via `gh api git/refs`) | Empty ref pointing at `main` HEAD. Sandcastle's `branchStrategy: branch` fast-forwards from it. First implementer commit lands here.                 |
| Per-issue work tickets       | `/to-issues <slug>`                      | `prd:<slug>` + `needs-triage` initially; `/triage <slug>` promotes all (or some) to `ready-for-agent`. Body reads PRD via `gh issue view <tracker>`. |

`/to-prd` owns branch creation (not `main.mts`, not first implementer): sandcastle's worktree setup happens before the agent runs, the architectural principle says `main.mts` has zero `git` / `gh`, and `/to-prd` is the natural PRD lifecycle setup point.

## PR state model

| State                     | Meaning                                                           | Human action                                          |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| draft, no labels          | Agent still working                                               | Wait                                                  |
| draft + `needs-info`      | Stalled — partial mode, or full reviewer filed a judgment finding | Inspect; `/triage` open issues; re-run if appropriate |
| ready + `ready-for-human` | Complete + reviewer-approved                                      | Final review + squash-merge                           |

`needs-info` is the unified attention-needed signal across issues and PRs.

## Verify tiers — declared in target's `AGENTS.md`

```markdown
## Verify

### Fast (run by agent after each edit, must pass before commit)

- pnpm typecheck
- pnpm test:unit
- pnpm lint

### Full (run by CI on PR — not by the agent)

- pnpm test:integration
- pnpm test:e2e
- pnpm build
```

Implementer runs **all** Fast commands (no judgment about relevance). CI runs Full on PR — branch protection requires it green before merge. Discovery fallback: `AGENTS.md` → `CONTEXT.md` → `README.md` → `package.json` scripts. Fail loudly if none surfaces.

## Limits + error model

| Limit                       | Value                                                       |
| --------------------------- | ----------------------------------------------------------- |
| Outer iterations            | 20                                                          |
| Outer wall-time             | 4 hours                                                     |
| Per-implementer / -reviewer | 15 min each                                                 |
| Per-planner / -pr-composer  | 5 min each                                                  |
| Same-issue retry            | exit on 2nd pick of the same `#N` in one run                |
| Empty-plan retry            | exit on 1st empty plan with non-empty open queue (no retry) |
| Token cap                   | none (Anthropic billing alarm + wall-time caps suffice)     |

One handled-exit class: **`IncompleteError`**. Thrown by `runAuto` on any limit; `message` carries the reason verbatim and flows into pr-composer's partial-mode body. Examples: `"outer iteration limit (20) reached"`, `"same issue (#N) picked 2× — stuck"`, `"empty plan returned 1× — N issues still open but none workable"`. No typed `reason` field, no enum.

Planner output failures are **not** wrapped: sandcastle's `StructuredOutputError` (malformed/Zod-invalid) and a plain `Error("planner: <code>: <msg>")` from the planner's self-reported `error` field both propagate without partial-finalize.

`runAuto` owns the catch internally — logs, calls `phasePR(undefined, e.message)` + `phaseReview()`, then rethrows so the entry point sets exit 1.

## Logging

Per-run timestamped directory: `.sandcastle/logs/<slug>-<iso-timestamp>/`. One file per agent invocation: `<role>.log` (`planner.log`, `implementer-<N>.log`, `reviewer.log`, `pr-composer.log`). Re-invocations of the same role within one run append with a `--- Run started: ... ---` delimiter, so chronology is preserved.

The directory path prints to stderr at run start. Zero log loss for retro-diagnostics: a failed run can be inspected after the fact without terminal scrollback.

## Safety boundaries

**PAT scope** — fine-grained, target repo only: `Issues` / `Pull requests` / `Contents`: R/W; `Metadata`: R. **DO NOT ADD**: `Workflows`, `Actions`, `Administration`, `Secrets`, `Packages`, cross-repo. 90-day expiry, rotated.

**Branch protection** — `main`: require PR + ≥1 human approval + dismiss stale reviews on new commits + CI green + block force-push + block deletions + include administrators. `agent/*`: block force-push + block deletions. `wip/*`: unprotected.

**Container env** — only `GH_TOKEN` + Claude auth (`CLAUDE_CODE_OAUTH_TOKEN` preferred, `ANTHROPIC_API_KEY` as alt). **Nothing else** — no prod DB creds, no third-party API keys. If a test needs them, that test belongs in CI's Full tier, not the loop.

Worst case: a bad commit on `agent/<slug>`. Recoverable via `git reset` or `gh pr close`. `main` is unreachable from the agent.

## Working practices (for the extender)

- **Consult the other templates in `src/templates/` before changing this one.** `parallel-planner`, `sequential-reviewer`, and `parallel-planner-with-review` carry patterns worth borrowing; this repo's own dogfood in local or upstream's `.sandcastle/` is another useful reference. When this design and an upstream pattern disagree, raise it — don't silently diverge.
- **Read sandcastle's TypeScript source when API behavior is ambiguous** (env handling, branch strategies, `Output.object` semantics). The sources at `src/` in this repo are the ground truth.
- **Develop changes against a target repo's `.sandcastle/` first; backport here once stable** across multiple PRDs. Avoids round-trips during iteration.

## Known limitations and open work

| Item                                                                                                         | Revisit when                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blocked` orthogonal label                                                                                   | After 2-3 PRD runs, if humans can't tell at a glance which issues are stuck.                                                                                                                                                                             |
| `wip/*` branch cleanup policy                                                                                | After wip branches accumulate; manual delete works for now.                                                                                                                                                                                              |
| Agent/Loop/AFK trigger via cron / GH webhook                                                                 | After 12+ confident terminal runs.                                                                                                                                                                                                                       |
| Standalone NPM package (vs sandcastle fork)                                                                  | When running on >2-3 target repos.                                                                                                                                                                                                                       |
| Parallel implementer dispatch                                                                                | After sequential is boring; requires a merger agent.                                                                                                                                                                                                     |
| Mid-mode human pause between implementers                                                                    | If trust-budget pattern requires per-commit human review.                                                                                                                                                                                                |
| Token budget cap in `main.mts`                                                                               | If billing alarm proves insufficient.                                                                                                                                                                                                                    |
| `priority:`, `kind:bug` / `kind:feature` / `area:` namespaced labels (classification axis)                   | When PRD volume + variety needs the classification. `kind:prd` is a structural marker, separate from this axis.                                                                                                                                          |
| Reviewer effort level (full mode: `medium` → `high` / `ultra`)                                               | If first 2-3 full-mode PRD runs show `medium` misses important issues.                                                                                                                                                                                   |
| `/code-review --fix` instead of wrapper-driven Read+Edit+`/commit`                                           | If wrapper-driven fixing proves too slow or noisy in full mode.                                                                                                                                                                                          |
| Refine reviewer mechanical-vs-judgment rule                                                                  | If full-mode reviewer keeps mis-classifying — e.g. auto-fixing things humans wanted to debate.                                                                                                                                                           |
| OAuth token refresh strategy for long AFK runs                                                               | When scheduled / cron triggers land — `CLAUDE_CODE_OAUTH_TOKEN` will eventually expire mid-run with no refresh path.                                                                                                                                     |
| Improve reviewer post-review human-intervention workflow (dedup + magic-reply markers + termination cap)     | After Run-2/3 quantify how often `/code-review` re-discovery re-files findings. If observed >2× per PRD, this design starts paying for itself. Re-derive the design when implementation starts.                                                          |
| `main.mts` post-condition `git ls-remote` check that reviewer-claimed commits exist on `origin/<branch>`     | Orchestrator-level guard over per-prompt push-discipline. Two confirmed cases of "agent claimed to commit but didn't push." Threshold reached but not yet gating; revisit if a third surfaces.                                                           |
| Pre-launch skill/plugin presence check (declare per-prompt dependencies, verify they're in the pinned image) | Surfaced by the 2026-06-08 `/code-review` bypass diagnosis (missing plugin produced silent fallback, not error). Composes with the post-condition check above.                                                                                           |
| `main.mts` post-condition scan of `reviewer.log` for `Skill(` tool calls; absence → escalate                 | Bypass-detection lever for full mode. Prompt-side discipline alone could not stop the full reviewer from self-emulating `/code-review` via `git diff`. Lower priority since the 2026-06-09 light/full split — full reviewer is now the rare opt-in path. |
