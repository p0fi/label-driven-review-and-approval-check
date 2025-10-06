import * as core from "@actions/core";
import * as github from "@actions/github";
import { parse as parseYAML } from "yaml";

// Ambient fallback declarations (non-invasive). These suppress "Cannot find module" errors
// when node modules have not yet been installed locally. Once dependencies are installed
// (npm install), TypeScript will use the real type definitions instead.
declare module "@actions/core" {
  export function getInput(
    name: string,
    options?: { required?: boolean },
  ): string;
  export function setFailed(message: string | Error): void;
  export function info(message: string): void;
  export function warning(message: string): void;
  export function setOutput(name: string, value: string): void;
}
// (Removed ambient @actions/github module augmentation to avoid redeclaration conflicts)

/**
 * Configuration schema loaded from YAML.
 */
interface LabelConfig {
  labels: Record<string, string>; // label -> team slug (without org)
  requiredApprovals?: number;
  overrides?: Record<string, { requiredApprovals?: number }>;
  ignoreDraft?: boolean;
  retractOnUnlabeled?: boolean;
  // Future optional fields referenced in comments (unused here):
  // failOnUnresolvableTeam?: boolean;
}

interface EvaluatedDomain {
  domainKey: string; // canonical domain key from config (case-sensitive as in config)
  teamSlug: string; // team slug
  labelName: string; // actual label on PR (with prefix if any)
  approvals: number; // count of valid approvals
  required: number; // required approvals
  satisfied: boolean; // approvals >= required
  approvers: string[]; // user logins that counted
}

type SummaryMode = "minimal" | "standard" | "verbose";

interface Inputs {
  token: string;
  configPath: string;
  failOnMissingConfig: boolean;
  dryRun: boolean;
  debug: boolean;
  summaryMode: SummaryMode;
}

const CHECK_NAME = "label-driven-review-and-approval-check";

function getBooleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name) || "";
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function getSummaryMode(): SummaryMode {
  const raw = core.getInput("summary-mode").trim().toLowerCase();
  if (raw === "minimal" || raw === "verbose" || raw === "standard") return raw;
  return "standard";
}

function readInputs(): Inputs {
  return {
    token:
      core.getInput("token", { required: false }) ||
      process.env.GITHUB_TOKEN ||
      "",
    configPath: core.getInput("config-path") || ".github/label-teams.yml",
    failOnMissingConfig: getBooleanInput("fail-on-missing-config", true),
    dryRun: getBooleanInput("dry-run", false),
    debug: getBooleanInput("debug", false),
    summaryMode: getSummaryMode(),
  };
}

function debug(enabled: boolean, ...msg: unknown[]) {
  if (enabled) {
    core.info(
      `[debug] ${msg.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ")}`,
    );
  }
}

async function loadConfig(
  octokit: ReturnType<typeof github.getOctokit>,
  inputs: Inputs,
): Promise<LabelConfig | null> {
  const { owner, repo } = github.context.repo;
  // We attempt to read from base ref of the PR (so configuration changes in the PR itself do not affect gating).
  const pr = github.context.payload.pull_request;
  let ref: string | undefined = pr?.base?.ref;
  if (!ref) {
    // Fallback to default branch (if event not a PR event).
    try {
      const repoResp = await octokit.rest.repos.get({ owner, repo });
      ref = repoResp.data.default_branch;
    } catch {
      ref = "main";
    }
  }

  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: inputs.configPath,
      ref,
    });

    if (!Array.isArray(res.data) && "content" in res.data && res.data.content) {
      const buff = Buffer.from(
        res.data.content,
        res.data.encoding as BufferEncoding,
      );
      const text = buff.toString("utf8");
      const parsed = parseYAML(text) as unknown;
      const config = validateConfig(parsed);
      return config;
    }

    core.warning(
      `Configuration path "${inputs.configPath}" was a directory or unexpected format.`,
    );
    return null;
  } catch (err: any) {
    if (err.status === 404) {
      const msg = `Configuration file not found at ${inputs.configPath} (ref: ${ref}).`;
      if (inputs.failOnMissingConfig) {
        throw new Error(msg);
      }
      core.warning(msg);
      return null;
    }
    throw err;
  }
}

function validateConfig(raw: unknown): LabelConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config root must be an object.");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.labels !== "object" || obj.labels === null) {
    throw new Error(
      'Config must contain a "labels" object mapping label names to team slugs.',
    );
  }
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj.labels)) {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(
        `Domain "${k}" must map to a non-empty team slug string.`,
      );
    }
    labels[k.trim()] = v.trim();
  }
  const cfg: LabelConfig = {
    labels,
    requiredApprovals:
      typeof obj.requiredApprovals === "number" && obj.requiredApprovals >= 1
        ? Math.floor(obj.requiredApprovals)
        : 1,
    overrides: {},
    ignoreDraft:
      obj.ignoreDraft !== undefined ? Boolean(obj.ignoreDraft) : true,
    retractOnUnlabeled:
      obj.retractOnUnlabeled !== undefined
        ? Boolean(obj.retractOnUnlabeled)
        : true,
  };
  if (typeof obj.overrides === "object" && obj.overrides !== null) {
    for (const [k, spec] of Object.entries(obj.overrides)) {
      if (spec && typeof spec === "object") {
        const r = (spec as any).requiredApprovals;
        if (r !== undefined) {
          if (typeof r !== "number" || r < 1) {
            throw new Error(
              `Override for domain "${k}" has invalid requiredApprovals "${r}"`,
            );
          }
          cfg.overrides![k] = { requiredApprovals: Math.floor(r) };
        }
      }
    }
  }
  return cfg;
}

/**
 * Fetch all reviews for the PR, returning only the last state per user.
 */
async function getApprovalsByUser(
  octokit: ReturnType<typeof github.getOctokit>,
  pull_number: number,
) {
  const { owner, repo } = github.context.repo;
  const allReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });

  // Map login -> last review state (by submitted_at order)
  const byUser = new Map<string, { state: string; submitted_at?: string }>();
  for (const r of allReviews) {
    const login = r.user?.login;
    if (!login) continue;
    const current = byUser.get(login);
    if (!current) {
      byUser.set(login, {
        state: r.state || "",
        submitted_at: r.submitted_at || r.submitted_at || undefined,
      });
    } else {
      // Compare timestamps for last review
      const prev = current.submitted_at
        ? new Date(current.submitted_at).getTime()
        : 0;
      const curr = r.submitted_at ? new Date(r.submitted_at).getTime() : 0;
      if (curr >= prev) {
        byUser.set(login, {
          state: r.state || "",
          submitted_at: r.submitted_at || undefined,
        });
      }
    }
  }

  const approvedUsers = new Set<string>();
  for (const [user, info] of byUser.entries()) {
    if (info.state === "APPROVED") {
      approvedUsers.add(user);
    }
  }

  return {
    approvedUsers,
    allReviewStates: byUser,
  };
}

interface TeamMembersCache {
  [teamSlug: string]: Set<string>;
}

async function fetchTeamMembers(
  octokit: ReturnType<typeof github.getOctokit>,
  org: string,
  teamSlug: string,
  cache: TeamMembersCache,
  debugEnabled: boolean,
): Promise<Set<string>> {
  if (cache[teamSlug]) return cache[teamSlug];
  try {
    const members = (await octokit.paginate(
      octokit.rest.teams.listMembersInOrg,
      {
        org,
        team_slug: teamSlug,
        per_page: 100,
      },
    )) as Array<{ login: string | null | undefined }>;
    const set = new Set<string>(
      members
        .map((m) => m.login)
        .filter((l): l is string => typeof l === "string" && l.length > 0),
    );
    cache[teamSlug] = set;
    debug(debugEnabled, `Fetched ${set.size} members for team ${teamSlug}`);
    return set;
  } catch (err: any) {
    // If we cannot resolve team members, create empty set (treat as 0 approvals).
    core.warning(
      `Could not list members for team "${teamSlug}": ${err.message || err}`,
    );
    cache[teamSlug] = new Set<string>();
    return cache[teamSlug];
  }
}

interface DomainExtractionResult {
  domains: string[]; // config domain keys (case-sensitive)
  domainLabelMap: Map<string, string>; // domainKey -> actual label name on PR
}

/**
 * Extract domain labels present on the PR, given config & PR labels.
 */

function extractDomainLabels(
  config: LabelConfig,
  prLabels: ReadonlyArray<{ name?: string | null }>,
): DomainExtractionResult {
  // Exact, case-sensitive match only – label text must exactly equal the configured label key.
  const domainLabelMap = new Map<string, string>();
  for (const l of prLabels) {
    const name: string | undefined = l?.name ?? undefined;
    if (typeof name !== "string" || name.length === 0) continue;
    if (Object.prototype.hasOwnProperty.call(config.labels, name)) {
      domainLabelMap.set(name, name);
    }
  }
  return {
    domains: Array.from(domainLabelMap.keys()),
    domainLabelMap,
  };
}

/**
 * Request team reviewers for missing domain teams.
 */
async function ensureTeamReviewRequests(
  octokit: ReturnType<typeof github.getOctokit>,
  pull_number: number,
  org: string,
  config: LabelConfig,
  presentDomains: string[],
  existingRequestedTeamSlugs: Set<string>,
  inputs: Inputs,
) {
  // For each present domain, ensure team requested
  const toRequest: string[] = [];
  for (const d of presentDomains) {
    const teamSlug = config.labels[d];
    if (!teamSlug) continue;
    if (existingRequestedTeamSlugs.has(teamSlug)) continue;
    toRequest.push(teamSlug);
  }
  if (toRequest.length === 0) return;

  if (inputs.dryRun) {
    core.info(
      `[dry-run] Would request review from teams: ${toRequest.join(", ")}`,
    );
    return;
  }

  try {
    await octokit.rest.pulls.requestReviewers({
      owner: org,
      repo: github.context.repo.repo,
      pull_number,
      // Provide explicit empty reviewers array (API allows either individual users or teams)
      reviewers: [],
      // Cast to any to satisfy potential stricter type expectations in certain @octokit versions
      team_reviewers: toRequest as any,
    } as any);
    core.info(`Requested review from teams: ${toRequest.join(", ")}`);
  } catch (err: any) {
    if (err.status === 422) {
      core.warning(
        `Some team review requests may already exist: ${err.message}`,
      );
      return;
    }
    throw err;
  }
}

/**
 * If an unlabeled event occurred and the removed label is a domain label, optionally retract team request.
 */
async function maybeRetractOnUnlabeled(
  octokit: ReturnType<typeof github.getOctokit>,
  config: LabelConfig,
  inputs: Inputs,
  prNumber: number,
  org: string,
) {
  if (!config.retractOnUnlabeled) return;
  const payload = github.context.payload;
  if (
    github.context.eventName !== "pull_request" &&
    github.context.eventName !== "pull_request_target"
  )
    return;
  if (payload.action !== "unlabeled") return;
  const removedLabelName: string | undefined = payload.label?.name;
  if (!removedLabelName) return;

  if (!(removedLabelName in config.labels)) return;
  const teamSlug = config.labels[removedLabelName];
  if (!teamSlug) return;

  if (inputs.dryRun) {
    core.info(
      `[dry-run] Would remove requested reviewer team: ${teamSlug} due to label removal.`,
    );
    return;
  }

  try {
    await octokit.rest.pulls.removeRequestedReviewers({
      owner: org,
      repo: github.context.repo.repo,
      pull_number: prNumber,
      reviewers: [], // explicit empty list to satisfy required field in types
      team_reviewers: [teamSlug] as any,
    } as any);
    core.info(
      `Removed requested reviewer team "${teamSlug}" after label "${removedLabelName}" was removed.`,
    );
  } catch (err: any) {
    // If team not currently requested, ignore
    core.warning(
      `Failed to remove requested reviewer team "${teamSlug}": ${err.message || err}`,
    );
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
    core.warning("headSha undefined; skipping check run creation.");
    return;
  }
  const { owner, repo } = github.context.repo;
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
    });
  } catch (err: any) {
    core.warning(`Unable to create check run: ${err.message || err}`);
  }
}

function formatEvaluations(
  domains: EvaluatedDomain[],
  summaryMode: SummaryMode,
) {
  const lines: string[] = [];

  const passing = domains.filter((d) => d.satisfied);
  const failing = domains.filter((d) => !d.satisfied);

  if (domains.length === 0) {
    lines.push("No configured labels present.");
  } else {
    lines.push("Label evaluation:");
    for (const d of domains) {
      const statusEmoji = d.satisfied ? "✅" : "❌";
      if (summaryMode === "minimal") {
        lines.push(
          `- ${statusEmoji} ${d.domainKey} (${d.approvals}/${d.required})`,
        );
      } else if (summaryMode === "standard") {
        lines.push(
          `- ${statusEmoji} ${d.domainKey} -> team ${d.teamSlug}: approvals ${d.approvals}/${d.required}${d.approvers.length ? ` (by ${d.approvers.join(", ")})` : ""}`,
        );
      } else {
        lines.push(`- ${statusEmoji} Label: ${d.domainKey}
  Label: ${d.labelName}
  Team: ${d.teamSlug}
  Approvals: ${d.approvals}/${d.required}
  Approvers: ${d.approvers.length ? d.approvers.join(", ") : "(none)"}
`);
      }
    }
  }

  lines.push("");
  lines.push(
    `Passing labels: ${passing.length ? passing.map((p) => p.domainKey).join(", ") : "(none)"}`,
  );
  lines.push(
    `Failing labels: ${failing.length ? failing.map((f) => f.domainKey).join(", ") : "(none)"}`,
  );

  return lines.join("\n");
}

async function run(): Promise<void> {
  const inputs = readInputs();
  if (!inputs.token) {
    core.setFailed(
      "No GitHub token provided (input token or GITHUB_TOKEN env).",
    );
    return;
  }

  const octokit = github.getOctokit(inputs.token);
  const payload = github.context.payload;
  const pr = payload.pull_request;

  if (!pr) {
    core.info(
      "This action is intended for pull_request / pull_request_target events. Exiting gracefully.",
    );
    core.setOutput("status", "skipped");
    return;
  }

  const org = github.context.repo.owner;
  const pull_number = pr.number;
  const headSha = pr.head?.sha;
  if (!headSha) {
    core.setFailed("Could not determine head SHA for PR.");
    return;
  }

  let config: LabelConfig | null = null;
  try {
    config = await loadConfig(octokit, inputs);
  } catch (err: any) {
    core.setFailed(`Failed to load config: ${err.message || err}`);
    return;
  }

  if (!config) {
    core.info("No configuration available; skipping evaluation.");
    core.setOutput("status", "skipped");
    await createCheckRun(
      octokit,
      headSha,
      "skipped",
      "No config",
      "Configuration file missing or not loaded.",
    );
    return;
  }

  // Maybe retract pending team review request if label removed.
  await maybeRetractOnUnlabeled(octokit, config, inputs, pull_number, org);

  if (config.ignoreDraft && pr.draft) {
    const msg = "PR is draft; domain approvals check skipped.";
    core.info(msg);
    await createCheckRun(octokit, headSha, "skipped", "Draft PR", msg);
    core.setOutput("status", "skipped");
    return;
  }

  // Extract domain labels
  const prLabels: ReadonlyArray<{ name?: string | null }> = Array.isArray(
    pr.labels,
  )
    ? (pr.labels as ReadonlyArray<{ name?: string | null }>)
    : [];
  const extraction = extractDomainLabels(config, prLabels);

  // Gather existing requested teams to avoid duplicate requests
  let refreshedPR: any = pr as any;
  try {
    // Always refetch to capture requested teams state
    const fresh = await octokit.rest.pulls.get({
      owner: org,
      repo: github.context.repo.repo,
      pull_number,
    });
    refreshedPR = fresh.data;
  } catch (err: any) {
    core.warning(`Could not refresh PR: ${err.message || err}`);
  }

  const existingRequestedTeamSlugs: Set<string> = new Set<string>(
    (Array.isArray(refreshedPR.requested_teams)
      ? refreshedPR.requested_teams
      : []
    )
      .map((t: { slug?: string | null }) => t?.slug)
      .filter(
        (slug: unknown): slug is string =>
          typeof slug === "string" && (slug as string).length > 0,
      ),
  );

  // Request missing teams (side-effect)
  try {
    await ensureTeamReviewRequests(
      octokit,
      pull_number,
      org,
      config,
      extraction.domains,
      existingRequestedTeamSlugs,
      inputs,
    );
  } catch (err: any) {
    core.warning(`Failed ensuring team review requests: ${err.message || err}`);
  }

  // If no domain labels present and no unknown: pass trivially (or maybe success)
  if (extraction.domains.length === 0) {
    const msg = "No configured labels present; no approval requirements.";
    core.info(msg);
    await createCheckRun(octokit, headSha, "success", "No labels", msg);
    core.setOutput("status", "success");
    core.setOutput("required_labels", "");
    core.setOutput("missing_approvals", "");
    return;
  }

  // Collect approvals
  const { approvedUsers } = await getApprovalsByUser(octokit, pull_number);

  // For each domain label, compute approvals from that team
  const teamMembersCache: TeamMembersCache = {};
  const evaluations: EvaluatedDomain[] = [];

  for (const domainKey of extraction.domains) {
    const teamSlug = config.labels[domainKey];
    if (!teamSlug) {
      core.warning(
        `Label "${domainKey}" has no mapped team slug in configuration; skipping.`,
      );
      continue;
    }
    const overrideRequired = config.overrides?.[domainKey]?.requiredApprovals;
    const required = overrideRequired ?? config.requiredApprovals ?? 1;

    // Resolve the exact label name from the extraction map; if missing, skip safely
    const resolvedLabelName = extraction.domainLabelMap.get(domainKey);
    if (!resolvedLabelName) {
      core.warning(
        `Configured label key "${domainKey}" was not found among current PR labels; skipping its approval evaluation.`,
      );
      continue;
    }

    const members = await fetchTeamMembers(
      octokit,
      org,
      teamSlug,
      teamMembersCache,
      inputs.debug,
    );
    const approvers: string[] = [];
    for (const user of approvedUsers) {
      if (members.has(user)) {
        approvers.push(user);
      }
    }
    const approvals = approvers.length;
    evaluations.push({
      domainKey,
      teamSlug,
      labelName: resolvedLabelName,
      approvals,
      required,
      satisfied: approvals >= required,
      approvers,
    });
  }

  const missing = evaluations
    .filter((e) => !e.satisfied)
    .map((e) => e.domainKey);
  const anyFailure = missing.length > 0;

  const summary = anyFailure
    ? "label-driven-review-and-approval-check: missing required team approvals."
    : "label-driven-review-and-approval-check: all required team approvals satisfied.";
  const body = formatEvaluations(evaluations, inputs.summaryMode);

  // Create check run
  await createCheckRun(
    octokit,
    headSha,
    anyFailure ? "failure" : "success",
    summary,
    body,
  );

  // Outputs
  core.setOutput("status", anyFailure ? "failure" : "success");
  core.setOutput(
    "required_labels",
    evaluations.map((e) => e.domainKey).join(","),
  );
  core.setOutput("missing_approvals", missing.join(","));

  if (anyFailure) {
    core.setFailed(summary);
  } else {
    core.info(summary);
  }
}

run().catch((err) => {
  core.setFailed(
    err instanceof Error ? err.message : `Unhandled error: ${String(err)}`,
  );
});
