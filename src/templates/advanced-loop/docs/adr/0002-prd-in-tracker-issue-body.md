---
status: accepted
date: 2026-06-07
supersedes: an earlier file-based design (PRD prose in `tasks/<slug>/PRD.md`)
---

# PRD lives in the tracker issue body, not as a file in the repo

A PRD is a GitHub tracker issue carrying `prd:<slug>` + `kind:prd`; the PRD prose lives in the issue body. There is no `tasks/<slug>/PRD.md` file. All consumers (planner, implementer, pr-composer, reviewer, `/to-issues`) discover the tracker via `gh issue list --label "prd:<slug>" --label "kind:prd" --json number,body --limit 1` — one call captures tracker number + body.

We reversed an earlier file-based design once the smoke-pilot validated that a single GitHub-resident source avoids PRD/issue-body drift, eliminates a merge-conflict surface during concurrent agent edits, and uses GitHub's timeline as the audit trail for PRD revisions. Pr-composer's PR body uses a `## PRD\nImplements #<tracker>.` pointer rather than quoting the tracker body verbatim, so the PR doesn't go stale if the PRD evolves post-PR-creation.

## Considered options

- **`tasks/<slug>/PRD.md` file in repo.** Diff-able, git-versioned, easy to query in a worktree. Loses: a parallel source of truth that drifts when issues are edited via the GitHub UI; an extra artifact every PRD has to remember to keep in sync; merge conflicts on concurrent PRD edits during a long-running run.
