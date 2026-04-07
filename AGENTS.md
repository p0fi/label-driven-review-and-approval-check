# AGENTS.md

## Project overview

GitHub Action (TypeScript, Node 20) that maps PR labels to configured approvers, auto-requests reviews, and enforces required approvals as a single check run.

## Build & run

```sh
npm install
npm run build        # rimraf dist && tsc && ncc build src/index.ts -o dist
npm run typecheck    # tsc --noEmit
npm run lint         # biome check .
npm run lint:fix     # biome check --apply .
```

Always run `npm run build` after changing `src/`. The bundled `dist/` must be committed when tagging a release.

## Code layout

- `src/index.ts` — entire action logic (single file)
- `action.yml` — GitHub Action metadata (inputs, outputs)
- `.github/label-approvals.yml` — example label→approvers configuration
- `.github/workflows/example.yml` — example consuming workflow
- `dist/` — ncc bundle output (committed for releases)

## Conventions

- **TypeScript strict mode** — all strict flags enabled in `tsconfig.json`, including `noUncheckedIndexedAccess`.
- **Biome** for linting and formatting — 2-space indent, double quotes, no semicolons (ASI). Run `npm run lint` before committing.
- **No tests yet** — when adding tests, place them in `src/__tests__/` or as `*.test.ts` files. These are excluded from the build via `tsconfig.json`.
- Keep runtime dependencies minimal (`@actions/core`, `@actions/github`, `yaml` only).
- Target ES2023 with Node16 module resolution.

## Key design rules

- Labels are matched **exactly, case-sensitive** against keys in the config `labels:` map. No prefix matching or normalization.
- Config is always read from the PR's **base branch** (not the PR head) for security with fork PRs.
- The action produces a single check run named `label-driven-review-and-approval-check`.
- Only the **latest review per user** counts (by `submitted_at` timestamp).
- Approvers are defined statically in config — no org-level API calls required.
- `dry-run` mode must never mutate state (no review requests, no retractions).

## Making changes

1. Edit files under `src/`.
2. Run `npm run typecheck` and `npm run lint`.
3. Run `npm run build` and commit both `src/` and `dist/`.
4. Update `action.yml` if inputs or outputs change.
5. Update `README.md` if user-facing behavior changes.
