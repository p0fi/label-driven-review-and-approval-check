# label-driven-review-and-approval-check

Automatically request reviews from configured approvers based on PR labels and enforce required approvals by failing the workflow job when thresholds are not met.

> Add a label → approvers mapping to the config, push to your default branch, and start using the label. No workflow or code changes needed.

---

## Why

You have labels that represent ownership areas (e.g. `frontend`, `billing`, `security`). You want:

- Automatic, consistent review requests to the right people.
- Merge gating until the designated approver(s) approve.
- A single required status check (the job itself) instead of many.
- Config‑as‑code — zero code edits to extend.
- No org‑level permissions — `GITHUB_TOKEN` is sufficient.

---

## Features

- Exact, case‑sensitive label → approver list mapping.
- Per‑label approval threshold (`requiredApprovals` inline).
- Draft PR skipping until marked ready.
- Automatic retraction of pending review requests when a label is removed.
- Fails the workflow job when approvals are missing — use the job as a required status check.
- Dry‑run mode for safe rollout.
- Adjustable summary verbosity: `minimal | standard | verbose`.

---

## Quick Start

### 1. Add the configuration file

Create `.github/label-approvals.yml` on your default branch:

```yaml
labels:
  frontend:
    approvers: [alice, bob, charlie]
  backend:
    approvers: [dave, eve, frank]
  billing:
    approvers: [grace, heidi]
    requiredApprovals: 2
  security:
    approvers: [ivan, judy]
    requiredApprovals: 2

requiredApprovals: 1
ignoreDraft: true
retractOnUnlabeled: true
```

### 2. Add a workflow

Use `pull_request_target` so config and action code run from the trusted base branch (safe for forks).

```yaml
# .github/workflows/label-approvals.yml
name: label-driven-review-and-approval-check

on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write

jobs:
  approvals:
    runs-on: ubuntu-latest
    steps:
      - name: Run label approvals
        uses: your-org/label-driven-review-and-approval-check@v0.1.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-path: .github/label-approvals.yml
          summary-mode: standard
          dry-run: "false"
          debug: "false"
```

### 3. Mark the check as required

In **Settings → Rules → Rulesets**, create or edit a ruleset targeting your default branch. Add a **Require status checks to pass** rule and include `label-driven-review-and-approval-check` as a required check.

### 4. Use it

Apply or remove a configured label. The action will:

- Request reviews from the label's configured approvers (if not already requested).
- Evaluate approvals — only reviews from listed approvers count.
- Fail until each present configured label meets its approval threshold.

---

## Configuration Reference

The configuration file (default: `.github/label-approvals.yml`) is always read from the PR's **base branch**.

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `labels` | map | Yes | — | Label name → `{ approvers: string[], requiredApprovals?: number }`. |
| `requiredApprovals` | number | No | `1` | Global default approvals per label. |
| `ignoreDraft` | boolean | No | `true` | Skip draft PRs. |
| `retractOnUnlabeled` | boolean | No | `true` | Retract pending review requests when label removed. |

Each entry under `labels` has:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `approvers` | string[] | Yes | GitHub usernames whose approvals count for this label. |
| `requiredApprovals` | number | No | Per‑label override (falls back to global `requiredApprovals`). |

---

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `token` | `${{ github.token }}` | GitHub token. `GITHUB_TOKEN` with `pull-requests: write` and `contents: read` is sufficient. |
| `config-path` | `.github/label-approvals.yml` | Path to the YAML config (loaded from base ref). |
| `fail-on-missing-config` | `true` | Fail when the config file is missing. Set `false` to skip gracefully. |
| `dry-run` | `false` | Evaluate only — no review requests or retractions. |
| `debug` | `false` | Verbose debug logging. |
| `summary-mode` | `standard` | Detail level in the check summary: `minimal`, `standard`, or `verbose`. |

## Outputs

| Output | Description |
|--------|-------------|
| `status` | `success`, `failure`, or `skipped`. |
| `required_labels` | Comma‑separated list of enforced labels. |
| `missing_approvals` | Comma‑separated list of labels still below threshold (empty if passing). |

---

## Approval Logic

1. Collect labels on the PR.
2. Keep only labels that exactly match keys in `labels`.
3. For each matched label:
   - Determine required approvals (per‑label `requiredApprovals` → global `requiredApprovals` → `1`).
   - Count unique users whose **latest** review is `APPROVED` and who appear in that label's `approvers` list.
4. If any label is below its threshold → **failure**; otherwise **success**.
5. The action writes a job summary with per‑label status and fails the job (`core.setFailed`) when approvals are missing. The job's own check run serves as the required status check.

---

## Events & Timing

Recommended `pull_request_target` triggers:

`opened`, `reopened`, `ready_for_review`, `synchronize`, `labeled`, `unlabeled`

You may also add `workflow_dispatch` or a cron schedule to periodically re‑evaluate long‑lived PRs.

---

## Draft PR Handling

When `ignoreDraft: true` (the default), draft PRs produce a `skipped` check. The check runs normally once the PR is marked ready for review.

---

## Retraction Behavior

When `retractOnUnlabeled: true` (the default) and a configured label is removed:

- The action removes pending review requests for that label's approvers.
- Existing approvals are **not** dismissed (the historical record stays intact).

---

## Dry Run Mode

Set `dry-run: "true"` to:

- Evaluate approval status and write a job summary as normal.
- Skip all mutations (no review requests, no retractions).
- Useful during initial rollout or config experimentation.

---

## Example

```yaml
labels:
  frontend:
    approvers: [alice, bob]
  billing:
    approvers: [carol, dave, eve]
    requiredApprovals: 2
requiredApprovals: 1
```

| Label | Approved by | Required | Status |
|-------|-------------|----------|--------|
| frontend | alice | 1 | ✅ |
| billing | dave | 2 | ❌ (needs one more from `[carol, dave, eve]`) |

Check result: **failure**, `missing_approvals=billing`.

---

## Troubleshooting

| Symptom | Cause | Remedy |
|---------|-------|--------|
| Approver not counted | User not in `approvers` list for that label | Add username to the label's `approvers` array. |
| Always skipped | PR is draft and `ignoreDraft: true` | Mark the PR ready or set `ignoreDraft: false`. |
| Review not auto‑requested | Already requested, or username mismatch | Verify the exact GitHub username (case‑sensitive). |
| 422 on review request | Duplicate request | Benign — the user is already requested. |

---

## Limitations

- Only the latest review per user counts (GitHub semantics).
- No dismissal management beyond GitHub's built‑in behavior.
- No auto‑labeling — integrate with other automation if needed.

---

## Cheat Sheet

| Task | How |
|------|-----|
| Add a new label requirement | Add an entry to `labels:` with an `approvers` list |
| Increase approvals for a label | Set `requiredApprovals` on that label entry |
| Skip draft PRs | `ignoreDraft: true` (default) |
| Stop skipping drafts | `ignoreDraft: false` |
| Test safely | `dry-run: "true"` |
| Concise summary | `summary-mode: minimal` |
| Detailed diagnostics | `summary-mode: verbose` |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT