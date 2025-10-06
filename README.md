# label-driven-review-and-approval-check GitHub Action

Automatically:
1. Auto‑requests reviews from GitHub Teams based on PR labels you configure.
2. Enforces that each configured label present on the PR has the required number of approvals from members of its mapped team.
3. Publishes a single check run you can make a required branch protection status.
4. Lets you add or adjust labels by editing one config file (no workflow/code changes).

> Dynamic by design: add a label → team mapping to the config, push to default branch, start using the label.

---

## Why

You have labels that semantically represent ownership areas (e.g. `frontend`, `billing`, `security`). You want:
- Automatic, consistent team review requests.
- Gating merges until the owning team(s) approve.
- A single, easy to protect status instead of many.
- Config‑as‑code; zero code edits to extend.

---

## Core Features (Label‑Centric)

- Exact (case‑sensitive) label → team slug mapping (`labels:` section).
- Per‑label approval override (`overrides:`).
- Draft PRs can be skipped until ready.
- Optional retraction of pending team review requests when a label is removed.
- One consolidated check: “label-driven-review-and-approval-check”.
- Dry‑run mode for safe rollout.
- Adjustable summary verbosity: `minimal | standard | verbose`.

(Deprecated concepts removed: prefixes, normalization, unknown label handling flags.)

---

## Quick Start

### 1. Add the configuration file

Create `.github/label-teams.yml` on your default branch:

```yaml
labels:
  frontend: web-platform
  backend: api-core
  billing: finance-eng
  security: appsec

# Labels must match these keys exactly (case-sensitive).
requiredApprovals: 1

overrides:
  billing:
    requiredApprovals: 2
  security:
    requiredApprovals: 2

ignoreDraft: true
retractOnUnlabeled: true
```

### 2. Add a workflow

Recommended: `pull_request_target` so config + action code run from the trusted base branch (safe for forks).

```yaml
# .github/workflows/label-approvals.yml
name: label-driven-review-and-approval-check

on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  approvals:
    runs-on: ubuntu-latest
    steps:
      - name: Run label approvals
        uses: your-org/label-driven-review-and-approval-check@v0.1.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-path: .github/label-teams.yml
          summary-mode: standard
          dry-run: "false"
          debug: "false"
```

### 3. Mark the check as Required

In Branch Protection, add required status check: `label-driven-review-and-approval-check`.

### 4. Use It

Apply or remove a configured label (`frontend`, `billing`, etc.). The action:
- Requests the mapped team as reviewers (if not already requested).
- Evaluates approvals.
- Fails until each present configured label meets its approval threshold.

---

## Configuration Reference (`.github/label-teams.yml`)

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `labels` | map<string,string> | Yes | Exact label text → team slug (org inferred from repo owner). |
| `requiredApprovals` | number | No | Global default approvals per label (default: 1). |
| `overrides` | map | No | Per‑label override `{ requiredApprovals: N }`. |
| `ignoreDraft` | boolean | No | Skip draft PRs (`true` default). |
| `retractOnUnlabeled` | boolean | No | Remove pending team review request when label removed (`true` default). |

### Example With Comments

```yaml
labels:
  frontend: web-platform   # <org>/web-platform
  backend: api-core
  billing: finance-eng
  security: appsec

requiredApprovals: 1

overrides:
  billing:
    requiredApprovals: 2
  security:
    requiredApprovals: 2

ignoreDraft: true
retractOnUnlabeled: true
```

---

## Inputs

| Input | Default | Purpose |
|-------|---------|---------|
| `token` | `${{ github.token }}` | GitHub token (PAT w/ `read:org` if team membership is restricted). |
| `config-path` | `.github/label-teams.yml` | Path to config (loaded from base ref). |
| `fail-on-missing-config` | `true` | Fail when config missing (set `false` to skip). |
| `dry-run` | `false` | Evaluate only; no review request / retraction side-effects. |
| `debug` | `false` | Verbose debug logging. |
| `summary-mode` | `standard` | `minimal | standard | verbose`. |

## Outputs

| Output | Description |
|--------|-------------|
| `status` | `success` | `failure` | `skipped`. |
| `required_labels` | Comma-separated list of enforced labels. |
| `missing_approvals` | Comma-separated list of labels still below threshold. |

---

## Approval Logic

1. Collect labels on the PR.
2. Select only labels that exactly match keys in `labels`.
3. For each matched label:
   - Determine required approvals (override > global > 1).
   - Fetch team members.
   - Count unique users whose latest review state is `APPROVED` and who are on that team.
4. If any matched label is below its requirement → failure; otherwise success.
5. Produces a single check run summarizing per-label status.

No fuzzy matching, no prefixes, no normalization.

---

## Team Membership Resolution

- Org inferred from repository owner.
- Uses REST API to list team members.
- If membership cannot be listed (permissions), team counts as 0 and a warning is logged (you may supply a PAT with `read:org`).

---

## Events & Timing

Recommended triggers:
`opened`, `reopened`, `ready_for_review`, `synchronize`, `labeled`, `unlabeled`.

You may add `workflow_dispatch` or a cron re-check for long‑lived PRs.

---

## Draft PR Handling

If `ignoreDraft: true`, draft PRs produce a `skipped` check until marked ready.

---

## Retraction Behavior

With `retractOnUnlabeled: true` removing a configured label:
- Attempts to remove that team’s pending review request.
- Does not dismiss existing approvals (historical record stays intact).

---

## Dry Run Mode

Set `dry-run: "true"`:
- Evaluates & emits check.
- Skips requesting/removing reviewers.
- Useful during rollout or config experimentation.

---

## Example

Config excerpt:

```yaml
labels:
  frontend: web-platform
  billing: finance-eng
requiredApprovals: 1
overrides:
  billing:
    requiredApprovals: 2
```

PR Labels & Approvals:

| Label | Approvers (team members) | Required | Status |
|-------|--------------------------|----------|--------|
| frontend | alice                  | 1        | ✅ |
| billing  | bob                    | 2        | ❌ (needs one more) |

Check result: failure, `missing_approvals=billing`.

---

## Local Development

```bash
git clone https://github.com/your-org/label-driven-review-and-approval-check
cd label-driven-review-and-approval-check
npm install
npm run build
```

Commit the generated `dist/` when tagging a release.

---

## Troubleshooting

| Symptom | Cause | Remedy |
|---------|-------|--------|
| Approvals not counted | Token cannot list team members | Use PAT with `read:org`. |
| Always skipped | PR is draft & `ignoreDraft: true` | Mark ready or set `ignoreDraft: false`. |
| Review not auto-requested | Already requested or slug mismatch | Verify exact team slug (URL slug, not display name). |
| 422 on requestReviewers | Duplicate request | Benign; already requested. |

---

## Limitations

- Only latest review per user counts (GitHub semantics).
- No dismissal management beyond GitHub core.
- One team per label (multi-team per label not yet implemented).
- No auto-labeling; integrate with other automation if needed.

---

## Roadmap Ideas

- Multi-team or fallback teams per label.
- Optional CODEOWNERS confirmation gating.
- Comment reminders for pending approvals.
- Rate-limiting and caching enhancements.

---

## Contributing

1. Fork & branch.
2. Make changes in `src/`, run `npm run build`.
3. Commit `src`, `dist`, and metadata.
4. Open a PR.

---

## License

MIT

---

## Cheat Sheet

| Task | How |
|------|-----|
| Add new label requirement | Add to `labels:` map (optional override) |
| Increase approvals for a label | Add/edit entry in `overrides:` |
| Skip drafts? | `ignoreDraft: true` (default) |
| Stop skipping drafts | `ignoreDraft: false` |
| Test safely | `dry-run: true` |
| Get concise summary | `summary-mode: minimal` |
| Detailed diagnostics | `summary-mode: verbose` |

---

Happy shipping – with clear, enforced label‑based ownership!