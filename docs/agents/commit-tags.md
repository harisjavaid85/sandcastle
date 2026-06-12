# Commit Tags

The `commit` skill prefixes each commit subject with a tag. This repo uses **Conventional Commits**: a lowercase type, then `: `, then an imperative summary. This file maps the eight canonical roles to the type strings this repo uses, and sets the subject format. When the skill builds a commit message, it uses the right-hand column and the template below.

| Canonical role | Type in this repo | Covers                                                        |
| -------------- | ----------------- | ------------------------------------------------------------- |
| `Feature`      | `feat`            | new functionality                                             |
| `Bugfix`       | `fix`             | fixes broken behavior                                         |
| `Doc`          | `docs`            | documentation                                                 |
| `Refactor`     | `refactor`        | behavior-preserving restructure, including `perf` and `style` |
| `Test`         | `test`            | tests                                                         |
| `Chore`        | `chore`           | non-code housekeeping: deps, build, ci, config, tooling       |
| `Merge`        | `merge`           | manual merge resolution                                       |
| `Revert`       | `revert`          | manually backing out a previous change                        |

**Subject template:** `<type>: <summary>`

`<type>` is the right-column string; `<summary>` is an imperative summary (≤ ~50 chars, no trailing period, no leading capital). An optional scope is allowed (`feat(templates): …`). The mood is always imperative.

Edit the right-hand column and the subject template if the house style changes.
