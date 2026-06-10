# Advanced Loop

An autonomous coding loop that takes a PRD's triaged issues through implementation, PR creation, and code review without a human in the middle.

The human is the bookend — they author the PRD and approve the final PR. Everything in between is automated.

## What it does

For one PRD scoped by the `prd:<slug>` tracker (GitHub) label:

1. **Plans** which `ready-for-agent` issues are currently workable (drops anything still blocked).
2. **Implements** each workable issue on the shared `agent/<slug>` branch — TDD, Fast-tier verify, commit, push, close.
3. **Opens or updates** a draft PR with a clear, mode-aware body.
4. **Reviews** the PR either in light mode (default) or full mode. Light mode refines the PR in place for clarity / redundancy / safety, fast-verifies each edit, commits and pushes passing edits; adds `ready-for-human` label. Full mode uses `/code-review`, classifies findings, applies mechanical fixes and files judgment findings as new issues; adds `needs-info` if anything is filed.

The loop ends either **complete** (every PRD issue closed) or **partial** (a limit fired or no workable issues remain). Both endings produce a draft PR — never a merge.

## Architecture

Four sequenced phases. Each runs as a separate claude code agent inside a sandcastle Docker sandbox. Contracts are the four `*-prompt.md` files in this directory.

| Phase          | Prompt                     | Model  | Output                                                                                                              |
| -------------- | -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| Plan           | `planner-prompt.md`        | Opus   | `<plan>` JSON (workable issues, open set, wip branches)                                                             |
| Implement      | `implementer-prompt.md`    | Sonnet | One closed issue + one commit on the agent branch (or a wip-branch bail)                                            |
| PR             | `pr-composer-prompt.md`    | Sonnet | Draft PR opened or updated                                                                                          |
| Review (light) | `light-reviewer-prompt.md` | Sonnet | Refinement commits on the PR + `ready-for-human` label                                                              |
| Review (full)  | `full-reviewer-prompt.md`  | Opus   | Mechanical fixes committed, judgment findings filed as issues, PR labelled either `ready-for-human` or `needs-info` |

The outer loop repeats Plan + Implement until the planner returns an empty plan with an empty open set (complete), or a limit fires (partial). PR runs first to open or update the draft; Review then evaluates the PR and labels it.

## Workflow

```
Human                                              Agent                                           Human
─────                                              ─────                                           ─────

/grill-with-context  ───►  PRD context
/to-prd <slug>       ───►  tracker issue (prd:<slug> + kind:prd; PRD prose in body) +
                           empty agent/<slug> branch
/to-issues <slug>    ───►  per-issue tickets (prd:<slug> + needs-triage)
/triage <slug>       ───►  flip initially-unblocked to ready-for-agent

npx tsx .sandcastle/main.mts
                          ├─ Plan         (opus reads issues, parses `## Blocked by`)
                          ├─ Implement    (sonnet, per issue: TDD → verify → commit → close)
                          ├─ PR           (sonnet, draft PR with mode-aware body)
                          └─ Review       (light -> sonnet performs refinement commits, label PR)
                          └─ Review       (full -> opus performs code review, classify, fix/file, label PR)

                                                                                PR appears
                                                                                ───►  Review + squash-merge
```

### When the PR appears

| PR state                  | Meaning                                     | Action                                          |
| ------------------------- | ------------------------------------------- | ----------------------------------------------- |
| Draft, no triage label    | Agent still working                         | Wait                                            |
| Draft + `needs-info`      | Stalled — partial mode or reviewer blockers | Inspect open issues, unstick, optionally re-run |
| Ready + `ready-for-human` | Complete + reviewer-approved                | Final review and squash-merge                   |

`needs-info` is the unified "needs human attention" signal — it appears on both issues and PRs.

## CLI

```
npx tsx .sandcastle/main.mts [phase] [--review=light|full]
```

| Phase              | What it runs                                                |
| ------------------ | ----------------------------------------------------------- |
| _(none)_ or `auto` | Full Plan → Implement loop → PR → Review                    |
| `plan`             | Planner only; prints the JSON plan                          |
| `implement <N>`    | Implementer for one issue                                   |
| `pr`               | Re-plan, derive PR mode (complete/partial), run pr-composer |
| `review`           | Reviewer only                                               |

Use `--review=full` in `auto` or `review` mode to select full review; `--review=light` is the default. The flag is an upfront human call on what level of review is needed based on the PRD's risk profile.

## Required env (`.sandcastle/.env`)

| Var                                                | Purpose                                             |
| -------------------------------------------------- | --------------------------------------------------- |
| `GH_TOKEN`                                         | Fine-grained GitHub PAT (target repo only)          |
| `CLAUDE_CODE_OAUTH_TOKEN` _or_ `ANTHROPIC_API_KEY` | Claude auth                                         |
| `PRD_SLUG`                                         | The PRD this run targets (e.g. `smoke-pilot`)       |
| `IMAGE_NAME`                                       | Docker image to use (e.g. `sandcastle:<your-repo>`) |

`PRD_SLUG` and `IMAGE_NAME` are required.

## Prerequisites in the target repo

| What                        | Where                                                                          | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Verify tiers                | `AGENTS.md` `## Verify` section                                                | Fast (in-loop, must pass before commit) + Full (CI on PR)    |
| Issue labels                | `docs/agents/triage-labels.md`                                                 | Canonical → actual labels mapping                            |
| Commit tags                 | `docs/agents/commit-tags.md`                                                   | Canonical → actual tags mapping + subject template           |
| Branch protection on `main` | Repo settings                                                                  | Require PR + ≥1 human approval + CI green + block force-push |
| Pre-commit substrate        | Husky + lint-staged                                                            | Pre-commit hooks for format/lint/typecheck/tests             |
| Skills                      | Baked in `.sandcastle/Dockerfile` at pinned SHA. Bump by rebuilding the image. | `/tdd`, `/commit`, `/code-review`, `/diagnose`, etc.         |

The implementer falls back through `AGENTS.md` → `CONTEXT.md` → `README.md` → `package.json` scripts to discover Fast-tier verify commands. If nothing surfaces, it leaves a setup-incomplete comment and stops.

## Naming conventions

| Artifact                     | Pattern                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| PRD scoping label            | `prd:<slug>`                                                             |
| Tracker structural marker    | `kind:prd` (fixed string)                                                |
| Agent working branch         | `agent/<slug>`                                                           |
| Stuck-implementer WIP branch | `wip/issue-<N>`                                                          |
| PRD tracker issue            | open issue carrying `prd:<slug>` + `kind:prd` (body holds the PRD prose) |
| Reviewer-filed issue         | title `Review: <imperative summary>`; labels `prd:<slug>` + `needs-info` |

`<slug>` is kebab-case. Re-runs against the same PRD land deterministically — no timestamps anywhere.

## Limits (runaway prevention)

| Limit                               | Value                                                   |
| ----------------------------------- | ------------------------------------------------------- |
| Outer iterations                    | 20                                                      |
| Outer wall-time                     | 4 hours                                                 |
| Per-implementer wall-time           | 15 min                                                  |
| Per-reviewer wall-time              | 15 min                                                  |
| Per-planner / pr-composer wall-time | 5 min each                                              |
| Same-issue retry                    | exit on 2nd pick of the same issue in one run           |
| Empty-plan retry                    | exit on 1st empty plan with non-empty open queue        |
| Token cap                           | none (Anthropic billing alarm + wall-time caps suffice) |

When any limit fires, the loop opens a partial-mode PR with the reason as a free-form sentence (e.g. `"outer iteration limit (20) reached"`) and labels it `needs-info`.

## Per-run logs

Each `main.mts` invocation creates `.sandcastle/logs/<slug>-<iso-timestamp>/` and writes one `<role>.log` per agent call (`planner.log`, `implementer-<N>.log`, `reviewer.log`, `pr-composer.log`). The path prints to stderr on startup. Re-invocations of the same role within one run append with a `--- Run started: ... ---` delimiter, so chronology is preserved across repeated picks.

## Issue states

```
                   needs-triage              (created by human using /to-issues)
                          │
                   /triage                   (human review)
                          │
                          ▼
       ┌──────── ready-for-agent ────────┐
       │                                 │
   (agent picks)                     wontfix (open or closed)
       │
       ▼
   needs-info  ◄────── implementer bail-out (wip/issue-<N> pushed)
       │                or reviewer-filed judgment finding
   /triage
       │
       ▼
   ready-for-agent  (loop picks up again)
       │
       ▼
    closed       (implementer finished, ready-for-agent stripped on close)
```

`ready-for-agent` is stripped on both close (success) and bail-out (`needs-info` pushed). To retry a closed or stalled issue, reopen if needed and re-add `ready-for-agent` — reopen alone is not enough; the planner only dispatches issues carrying that label.

`wontfix` is filtered out by the planner whether the issue is open or closed — humans can leave wontfix issues open as tombstones or close them; the loop treats both the same.

## PR states

```
pr-composer pushes branch + creates draft PR
       │
       ├─ partial mode  ──► draft + needs-info  ◄── stalled; reviewer self-gates and skips
       │
       └─ complete mode ──► draft, no labels (strips stale needs-info label if present)
                                  │
                            (reviewer runs)
                                  │
                                  ├─ judgment findings filed ──► draft + needs-info  ◄── human attention
                                  │
                                  └─ all clean / mechanical only ──► ready + ready-for-human
                                                                           │
                                                                           ▼
                                                                      human squash-merges
```

## Safety

- **PAT scope**: target repo only. `Issues` / `Pull requests` / `Contents` R/W + `Metadata` R. No `Workflows`, `Actions`, `Administration`, `Secrets`, `Packages`. 90-day rotation.
- **Branch protection**: `main` requires PR + human approval; `agent/*` blocks force-push and deletion; `wip/*` unprotected.
- **Container env**: only `GH_TOKEN` + Claude auth. No prod credentials, no third-party API keys.

Worst case: a bad commit on `agent/<slug>`. Recoverable via `git reset` or `gh pr close`. `main` is unreachable from the agent.

## Skills the loop uses

| Skill          | Used by               | What it handles                                      |
| -------------- | --------------------- | ---------------------------------------------------- |
| `/tdd`         | Implementer           | Red-green-refactor; recognises refactor-only changes |
| `/commit`      | Implementer, Reviewer | Tagged subject + body, pre-commit hook retry         |
| `/code-review` | Reviewer              | Posts one inline PR comment per finding              |
| `/diagnose`    | Implementer           | One disciplined recovery pass before bailing         |

All baked into the Docker image at a pinned commit SHA. Bump by rebuilding the image.

## First-time setup

For a new target repo (one-time):

1. `sandcastle init --template advanced-loop ...` to scaffold `.sandcastle/` (including the template-shipped `Dockerfile`).
2. Optionally bump the pinned `SKILLS_SHA` in `.sandcastle/Dockerfile`; build: `sandcastle docker build-image`.
3. Run `setup-repo-skills` to scaffold issue labels, commit tags, verify tiers, agent instructions, and the `kind:prd` label in one pass.
4. Run `/setup-pre-commit` to install the pre-commit substrate.
5. Configure branch protection per **Safety**.
6. Issue the PAT and Claude auth (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`); populate `.sandcastle/.env`.

After that, each PRD is `/grill-with-context` → `/to-prd` → `/to-issues` → `/triage` → `npx tsx .sandcastle/main.mts`.
