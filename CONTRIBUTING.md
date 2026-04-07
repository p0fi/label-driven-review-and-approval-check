# Contributing

## Prerequisites

- Node.js ≥ 18
- npm

## Setup

```sh
git clone https://github.com/your-org/label-driven-review-and-approval-check
cd label-driven-review-and-approval-check
npm install
```

## Build & Verify

```sh
npm run build        # rimraf dist && tsc && ncc build src/index.ts -o dist
npm run typecheck    # tsc --noEmit
npm run lint         # biome check .
npm run lint:fix     # biome check --apply .
```

Always run `npm run typecheck` and `npm run lint` before committing. Run `npm run build` after any change to `src/` — the bundled `dist/` must be committed when tagging a release.

## Project Structure

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entire action logic (single file) |
| `action.yml` | GitHub Action metadata (inputs, outputs) |
| `dist/` | ncc bundle output (committed for releases) |
| `.github/label-approvals.yml` | Example label → approvers configuration |
| `.github/workflows/example.yml` | Example consuming workflow |
| `biome.json` | Linter & formatter configuration |
| `tsconfig.json` | TypeScript compiler configuration |

## Code Conventions

- **TypeScript strict mode** with `noUncheckedIndexedAccess` enabled.
- **Biome** enforces style: 2-space indent, double quotes, no semicolons (ASI).
- Runtime dependencies are kept minimal: `@actions/core`, `@actions/github`, `yaml`.
- Target ES2023 with Node16 module resolution.

## Tests

No tests exist yet. When adding tests, place them in `src/__tests__/` or as `*.test.ts` files — these are excluded from the build via `tsconfig.json`.

## Submitting Changes

1. Fork the repo and create a feature branch.
2. Edit files under `src/`.
3. Run `npm run typecheck` and `npm run lint`.
4. Run `npm run build`.
5. Commit `src/` and `dist/` together.
6. Update `action.yml` if inputs or outputs changed.
7. Update `README.md` if user-facing behavior changed.
8. Open a pull request.

## Roadmap Ideas

- Fallback approvers per label.
- Optional CODEOWNERS confirmation gating.
- Comment reminders for pending approvals.
- Rate-limiting and caching enhancements.

## License

MIT