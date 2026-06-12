Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all bugfixes `patch`, all new features or breaking changes `minor` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check `README.md` to see if the documentation needs updating.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `mattpocock/sandcastle`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Commit tags

Conventional Commits: `<type>: <summary>` with imperative mood; tags: `feat`, `fix`, `docs`, etc. See `docs/agents/commit-tags.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Verify

How to confirm a change works. Run the Fast tier on every change; run the Full tier before opening a PR.

**Fast**

- `npm run typecheck` — `tsgo --noEmit`
- `npm test` — `vitest run`
- `npm run format:check` — `prettier --check .`

**Full**

- `npm run build` — `tsup` bundle (catches packaging/export breakage typecheck misses)
