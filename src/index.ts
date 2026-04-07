import * as core from "@actions/core"
import * as github from "@actions/github"
import { parse as parseYAML } from "yaml"

// Ambient fallback declarations (non-invasive). These suppress "Cannot find module" errors
// when node modules have not yet been installed locally. Once dependencies are installed
// (npm install), TypeScript will use the real type definitions instead.
declare module "@actions/core" {
  export function getInput(name: string, options?: { required?: boolean }): string
  export function setFailed(message: string | Error): void
  export function info(message: string): void
  export function warning(message: string): void
  export function setOutput(name: string, value: string): void
}
// (Removed ambient @actions/github module augmentation to avoid redeclaration conflicts)

/**
 * Per-label entry in the configuration.
 */
interface LabelEntry {
  approvers: string[]
  requiredApprovals?: number
}

/**
 * Configuration schema loaded from YAML.
 */
interface LabelConfig {
  labels: Record<string, LabelEntry>
  requiredApprovals?: number
  ignoreDraft?: boolean
  retractOnUnlabeled?: boolean
}

interface EvaluatedDomain {
  domainKey: string // canonical domain key from config (case-sensitive as in config)
  approverPool: string[] // configured approvers for this label
  labelName: string // actual label on PR (with prefix if any)
  approvals: number // count of valid approvals
  required: number // required approvals
  satisfied: boolean // approvals >= required
  approvers: string[] // user logins that counted
}

type SummaryMode = "minimal" | "standard" | "verbose"

interface Inputs {
  token: string
  configPath: string
  failOnMissingConfig: boolean
  dryRun: boolean
  debug: boolean
  summaryMode: SummaryMode
}

const CHECK_NAME = "label-driven-review-and-approval-check"

function getBooleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name) || ""
  if (!raw) return defaultValue
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

function getSummaryMode(): SummaryMode {
  const raw = core.getInput("summary-mode").trim().toLowerCase()
  if (raw === "minimal" || raw === "verbose" || raw === "standard") return raw
  return "standard"
}

function readInputs(): Inputs {
  return {
    token: core.getInput("token", { required: false }) || process.env.GITHUB_TOKEN || "",
    configPath: core.getInput("config-path") || ".github/label-approvals.yml",
    failOnMissingConfig: getBooleanInput("fail-on-missing-config", true),
    dryRun: getBooleanInput("dry-run", false),
    debug: getBooleanInput("debug", false),
    summaryMode: getSummaryMode(),
  }
}

async function loadConfig(
  octokit: ReturnType<typeof github.getOctokit>,
  inputs: Inputs,
): Promise<LabelConfig | null> {
  const { owner, repo } = github.context.repo
  // We attempt to read from base ref of the PR (so configuration changes in the PR itself do not affect gating).
  const pr = github.context.payload.pull_request
  let ref: string | undefined = pr?.base?.ref
  if (!ref) {
    // Fallback to default branch (if event not a PR event).
    try {
      const repoResp = await octokit.rest.repos.get({ owner, repo })
      ref = repoResp.data.default_branch
    } catch {
      ref = "main"
    }
  }

  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: inputs.configPath,
      ref,
    })

    if (!Array.isArray(res.data) && "content" in res.data && res.data.content) {
      const buff = Buffer.from(res.data.content, res.data.encoding as BufferEncoding)
      const text = buff.toString("utf8")
      const parsed = parseYAML(text) as unknown
      const config = validateConfig(parsed)
      return config
    }

    core.warning(`Configuration path "${inputs.configPath}" was a directory or unexpected format.`)
    return null
  } catch (err: any) {
    if (err.status === 404) {
      const msg = `Configuration file not found at ${inputs.configPath} (ref: ${ref}).`
      if (inputs.failOnMissingConfig) {
        throw new Error(msg)
      }
      core.warning(msg)
      return null
    }
    throw err
  }
}

function validateConfig(raw: unknown): LabelConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config root must be an object.")
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.labels !== "object" || obj.labels === null) {
    throw new Error('Config must contain a "labels" object mapping label names to approver entries.')
  }

  const labels: Record<string, LabelEntry> = {}
  for (const [k, v] of Object.entries(obj.labels)) {
    if (typeof v !== "object" || v === null) {
      throw new Error(`Label "${k}" must map to an object with an "approvers" array.`)
    }
    const entry = v as Record<string, unknown>
    if (!Array.isArray(entry.approvers) || entry.approvers.length === 0) {
      throw new Error(`Label "${k}" must have a non-empty "approvers" array.`)
    }
    for (const a of entry.approvers) {
      if (typeof a !== "string" || !a.trim()) {
        throw new Error(
          `Label "${k}" has an invalid approver value: each approver must be a non-empty string.`,
        )
      }
    }

    const labelEntry: LabelEntry = {
      approvers: entry.approvers.map((a: string) => a.trim()),
    }

    if (entry.requiredApprovals !== undefined) {
      if (typeof entry.requiredApprovals !== "number" || entry.requiredApprovals < 1) {
        throw new Error(
          `Label "${k}" has invalid requiredApprovals "${entry.requiredApprovals}"; must be an integer >= 1.`,
        )
      }
      labelEntry.requiredApprovals = Math.floor(entry.requiredApprovals)
    }

    labels[k.trim()] = labelEntry
  }

  const cfg: LabelConfig = {
    labels,
    requiredApprovals:
      typeof obj.requiredApprovals === "number" && obj.requiredApprovals >= 1
        ? Math.floor(obj.requiredApprovals)
        : 1,
    ignoreDraft: obj.ignoreDraft !== undefined ? Boolean(obj.ignoreDraft) : true,
    retractOnUnlabeled: obj.retractOnUnlabeled !== undefined ? Boolean(obj.retractOnUnlabeled) : true,
  }

  return cfg
}

/**
 * Fetch all reviews for the PR, returning only the last state per user.
 */
async function getApprovalsByUser(octokit: ReturnType<typeof github.getOctokit>, pull_number: number) {
  const { owner, repo } = github.context.repo
  const allReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  })

  // Map login -> last review state (by submitted_at order)
  const byUser = new Map<string, { state: string; submitted_at?: string }>()
  for (const r of allReviews) {
    const login = r.user?.login
    if (!login) continue
    const current = byUser.get(login)
    if (!current) {
      byUser.set(login, {
        state: r.state || "",
        submitted_at: r.submitted_at || undefined,
      })
    } else {
      // Compare timestamps for last review
      const prev = current.submitted_at ? new Date(current.submitted_at).getTime() : 0
      const curr = r.submitted_at ? new Date(r.submitted_at).getTime() : 0
      if (curr >= prev) {
        byUser.set(login, {
          state: r.state || "",
          submitted_at: r.submitted_at || undefined,
        })
      }
    }
  }

  const approvedUsers = new Set<string>()
  for (const [user, info] of byUser.entries()) {
    if (info.state === "APPROVED") {
      approvedUsers.add(user)
    }
  }

  return {
    approvedUsers,
    allReviewStates: byUser,
  }
}

interface DomainExtractionResult {
  domains: string[] // config domain keys (case-sensitive)
  domainLabelMap: Map<string, string> // domainKey -> actual label name on PR
}

/**
 * Extract domain labels present on the PR, given config & PR labels.
 */
function extractDomainLabels(
  config: LabelConfig,
  prLabels: ReadonlyArray<{ name?: string | null }>,
): DomainExtractionResult {
  // Exact, case-sensitive match only – label text must exactly equal the configured label key.
  const domainLabelMap = new Map<string, string>()
  for (const l of prLabels) {
    const name: string | undefined = l?.name ?? undefined
    if (typeof name !== "string" || name.length === 0) continue
    if (Object.prototype.hasOwnProperty.call(config.labels, name)) {
      domainLabelMap.set(name, name)
    }
  }
  return {
    domains: Array.from(domainLabelMap.keys()),
    domainLabelMap,
  }
}

/**
 * Request individual user reviewers for missing approvers.
 */
async function ensureReviewRequests(
  octokit: ReturnType<typeof github.getOctokit>,
  pull_number: number,
  config: LabelConfig,
  presentDomains: string[],
  existingRequestedUsers: Set<string>,
  existingReviewers: Set<string>,
  prAuthor: string,
  inputs: Inputs,
) {
  // Collect all approvers we need to request across all present domains
  const toRequest = new Set<string>()
  for (const d of presentDomains) {
    const entry = config.labels[d]
    if (!entry) continue
    for (const approver of entry.approvers) {
      // Skip if: PR author, already requested, already submitted a review
      if (approver.toLowerCase() === prAuthor.toLowerCase()) continue
      if (existingRequestedUsers.has(approver)) continue
      if (existingReviewers.has(approver)) continue
      toRequest.add(approver)
    }
  }

  if (toRequest.size === 0) return

  const requestList = Array.from(toRequest)

  if (inputs.dryRun) {
    core.info(`[dry-run] Would request review from users: ${requestList.join(", ")}`)
    return
  }

  try {
    await octokit.rest.pulls.requestReviewers({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number,
      reviewers: requestList,
      team_reviewers: [],
    } as any)
    core.info(`Requested review from users: ${requestList.join(", ")}`)
  } catch (err: any) {
    if (err.status === 422) {
      core.warning(`Some review requests may already exist or users are invalid: ${err.message}`)
      return
    }
    throw err
  }
}

/**
 * If an unlabeled event occurred and the removed label is a domain label, optionally retract
 * review requests for approvers unique to that label (not shared by other still-present labels).
 */
async function maybeRetractOnUnlabeled(
  octokit: ReturnType<typeof github.getOctokit>,
  config: LabelConfig,
  inputs: Inputs,
  prNumber: number,
  prLabels: ReadonlyArray<{ name?: string | null }>,
) {
  if (!config.retractOnUnlabeled) return
  const payload = github.context.payload
  if (github.context.eventName !== "pull_request" && github.context.eventName !== "pull_request_target")
    return
  if (payload.action !== "unlabeled") return
  const removedLabelName: string | undefined = payload.label?.name
  if (!removedLabelName) return

  if (!Object.prototype.hasOwnProperty.call(config.labels, removedLabelName)) return
  const removedEntry = config.labels[removedLabelName]
  if (!removedEntry) return

  // Build the set of approvers that are still needed by other present labels
  const stillNeeded = new Set<string>()
  for (const l of prLabels) {
    const name = l?.name ?? undefined
    if (typeof name !== "string" || name.length === 0) continue
    if (name === removedLabelName) continue // skip the removed label
    if (Object.prototype.hasOwnProperty.call(config.labels, name)) {
      const entry = config.labels[name]
      if (entry) {
        for (const a of entry.approvers) {
          stillNeeded.add(a)
        }
      }
    }
  }

  // Only retract approvers unique to the removed label
  const toRetract = removedEntry.approvers.filter((a) => !stillNeeded.has(a))
  if (toRetract.length === 0) return

  if (inputs.dryRun) {
    core.info(`[dry-run] Would remove requested reviewers: ${toRetract.join(", ")} due to label removal.`)
    return
  }

  try {
    await octokit.rest.pulls.removeRequestedReviewers({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
      reviewers: toRetract,
      team_reviewers: [],
    } as any)
    core.info(
      `Removed requested reviewers "${toRetract.join(", ")}" after label "${removedLabelName}" was removed.`,
    )
  } catch (err: any) {
    core.warning(
      `Failed to remove requested reviewers for label "${removedLabelName}": ${err.message || err}`,
    )
  }
}

async function createCheckRun(
  octokit: ReturnType<typeof github.getOctokit>,
  headSha: string | undefined,
  conclusion: "success" | "failure" | "neutral" | "skipped",
  summary: string,
  text: string,
) {
  if (!headSha) {
    core.warning("headSha undefined; skipping check run creation.")
    return
  }
  const { owner, repo } = github.context.repo
  try {
    await octokit.rest.checks.create({
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title: CHECK_NAME,
        summary,
        text,
      },
    })
  } catch (err: any) {
    core.warning(`Unable to create check run: ${err.message || err}`)
  }
}

function formatEvaluations(domains: EvaluatedDomain[], summaryMode: SummaryMode) {
  const lines: string[] = []

  const passing = domains.filter((d) => d.satisfied)
  const failing = domains.filter((d) => !d.satisfied)

  if (domains.length === 0) {
    lines.push("No configured labels present.")
  } else {
    lines.push("Label evaluation:")
    for (const d of domains) {
      const statusEmoji = d.satisfied ? "✅" : "❌"
      if (summaryMode === "minimal") {
        lines.push(`- ${statusEmoji} ${d.domainKey} (${d.approvals}/${d.required})`)
      } else if (summaryMode === "standard") {
        lines.push(
          `- ${statusEmoji} ${d.domainKey} -> approvers: ${d.approverPool.join(", ")}: approvals ${d.approvals}/${d.required}${d.approvers.length ? ` (by ${d.approvers.join(", ")})` : ""}`,
        )
      } else {
        lines.push(`- ${statusEmoji} Label: ${d.domainKey}
  Label: ${d.labelName}
  Approvers: ${d.approverPool.join(", ")}
  Approvals: ${d.approvals}/${d.required}
  Approved by: ${d.approvers.length ? d.approvers.join(", ") : "(none)"}
`)
      }
    }
  }

  lines.push("")
  lines.push(`Passing labels: ${passing.length ? passing.map((p) => p.domainKey).join(", ") : "(none)"}`)
  lines.push(`Failing labels: ${failing.length ? failing.map((f) => f.domainKey).join(", ") : "(none)"}`)

  return lines.join("\n")
}

async function run(): Promise<void> {
  const inputs = readInputs()
  if (!inputs.token) {
    core.setFailed("No GitHub token provided (input token or GITHUB_TOKEN env).")
    return
  }

  const octokit = github.getOctokit(inputs.token)
  const payload = github.context.payload
  const pr = payload.pull_request

  if (!pr) {
    core.info("This action is intended for pull_request / pull_request_target events. Exiting gracefully.")
    core.setOutput("status", "skipped")
    return
  }

  const org = github.context.repo.owner
  const pull_number = pr.number
  const headSha = pr.head?.sha
  if (!headSha) {
    core.setFailed("Could not determine head SHA for PR.")
    return
  }

  const prAuthor: string = pr.user?.login ?? ""

  let config: LabelConfig | null = null
  try {
    config = await loadConfig(octokit, inputs)
  } catch (err: any) {
    core.setFailed(`Failed to load config: ${err.message || err}`)
    return
  }

  if (!config) {
    core.info("No configuration available; skipping evaluation.")
    core.setOutput("status", "skipped")
    await createCheckRun(
      octokit,
      headSha,
      "skipped",
      "No config",
      "Configuration file missing or not loaded.",
    )
    return
  }

  // Extract PR labels early so we can pass them to retraction logic
  const prLabels: ReadonlyArray<{ name?: string | null }> = Array.isArray(pr.labels)
    ? (pr.labels as ReadonlyArray<{ name?: string | null }>)
    : []

  // Maybe retract pending review requests if label removed.
  await maybeRetractOnUnlabeled(octokit, config, inputs, pull_number, prLabels)

  if (config.ignoreDraft && pr.draft) {
    const msg = "PR is draft; domain approvals check skipped."
    core.info(msg)
    await createCheckRun(octokit, headSha, "skipped", "Draft PR", msg)
    core.setOutput("status", "skipped")
    return
  }

  // Extract domain labels
  const extraction = extractDomainLabels(config, prLabels)

  // Gather existing requested users and reviewers to avoid duplicate requests
  let refreshedPR: any = pr as any
  try {
    const fresh = await octokit.rest.pulls.get({
      owner: org,
      repo: github.context.repo.repo,
      pull_number,
    })
    refreshedPR = fresh.data
  } catch (err: any) {
    core.warning(`Could not refresh PR: ${err.message || err}`)
  }

  const existingRequestedUsers = new Set<string>(
    (Array.isArray(refreshedPR.requested_reviewers) ? refreshedPR.requested_reviewers : [])
      .map((u: { login?: string | null }) => u?.login)
      .filter((login: unknown): login is string => typeof login === "string" && (login as string).length > 0),
  )

  // Collect approvals
  const { approvedUsers, allReviewStates } = await getApprovalsByUser(octokit, pull_number)

  // Build set of users who have submitted any review
  const existingReviewers = new Set<string>(allReviewStates.keys())

  // Request missing reviewers (side-effect)
  try {
    await ensureReviewRequests(
      octokit,
      pull_number,
      config,
      extraction.domains,
      existingRequestedUsers,
      existingReviewers,
      prAuthor,
      inputs,
    )
  } catch (err: any) {
    core.warning(`Failed ensuring review requests: ${err.message || err}`)
  }

  // If no domain labels present: pass trivially
  if (extraction.domains.length === 0) {
    const msg = "No configured labels present; no approval requirements."
    core.info(msg)
    await createCheckRun(octokit, headSha, "success", "No labels", msg)
    core.setOutput("status", "success")
    core.setOutput("required_labels", "")
    core.setOutput("missing_approvals", "")
    return
  }

  // For each domain label, compute approvals from its approver pool
  const evaluations: EvaluatedDomain[] = []

  for (const domainKey of extraction.domains) {
    const entry = config.labels[domainKey]
    if (!entry) {
      core.warning(`Label "${domainKey}" has no entry in configuration; skipping.`)
      continue
    }

    const required = entry.requiredApprovals ?? config.requiredApprovals ?? 1

    // Resolve the exact label name from the extraction map; if missing, skip safely
    const resolvedLabelName = extraction.domainLabelMap.get(domainKey)
    if (!resolvedLabelName) {
      core.warning(
        `Configured label key "${domainKey}" was not found among current PR labels; skipping its approval evaluation.`,
      )
      continue
    }

    const approverPoolSet = new Set(entry.approvers)
    const matchedApprovers: string[] = []
    for (const user of approvedUsers) {
      if (approverPoolSet.has(user)) {
        matchedApprovers.push(user)
      }
    }
    const approvals = matchedApprovers.length
    evaluations.push({
      domainKey,
      approverPool: entry.approvers,
      labelName: resolvedLabelName,
      approvals,
      required,
      satisfied: approvals >= required,
      approvers: matchedApprovers,
    })
  }

  const missing = evaluations.filter((e) => !e.satisfied).map((e) => e.domainKey)
  const anyFailure = missing.length > 0

  const summary = anyFailure
    ? "label-driven-review-and-approval-check: missing required approvals."
    : "label-driven-review-and-approval-check: all required approvals satisfied."
  const body = formatEvaluations(evaluations, inputs.summaryMode)

  // Create check run
  await createCheckRun(octokit, headSha, anyFailure ? "failure" : "success", summary, body)

  // Outputs
  core.setOutput("status", anyFailure ? "failure" : "success")
  core.setOutput("required_labels", evaluations.map((e) => e.domainKey).join(","))
  core.setOutput("missing_approvals", missing.join(","))

  if (anyFailure) {
    core.setFailed(summary)
  } else {
    core.info(summary)
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : `Unhandled error: ${String(err)}`)
})
