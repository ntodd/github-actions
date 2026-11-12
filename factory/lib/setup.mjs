// Setup uses the administrator's authority, separately from the runtime App.
// These public-data plans are inspectable before any repository mutation.
import { parseConfig } from "./config.mjs";
import { callerWorkflow } from "./caller.mjs";
import { isDeepStrictEqual } from "node:util";

const positive = (v) => Number.isSafeInteger(v) && v > 0;
const same = isDeepStrictEqual;
const sorted = (xs) => [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const actorKey = (a) => ({ actor_type: a.actor_type, actor_id: a.actor_id, bypass_mode: a.bypass_mode });
const fail = (message) => { throw new Error(message); };
const identity = (login) => String(login).toLowerCase().replace(/\[bot\]$/, "");

export function setupChecks(checks) {
  if (!Array.isArray(checks) || !checks.length || checks.length > 100) fail("Setup needs explicit required checks");
  const result = checks.map((c) => {
    if (!c || typeof c.context !== "string" || !c.context.trim() || c.context.length > 256 || /[\x00-\x1f]/.test(c.context)
      || Object.keys(c).some((k) => !["context", "integration_id"].includes(k))
      || c.integration_id !== undefined && c.integration_id !== null && !positive(c.integration_id)) fail("Invalid required check identity");
    return { context: c.context, ...(c.integration_id == null ? {} : { integration_id: c.integration_id }) };
  });
  if (new Set(result.map((c) => c.context)).size !== result.length) fail("Duplicate required check names");
  return sorted(result);
}

export function validateSetupApp(app, config) {
  if (!positive(app?.id) || !/^[a-z\d][a-z\d-]*$/i.test(app.slug ?? "")) fail("Setup needs the App's current identity");
  const permissions = app.permissions ?? {};
  for (const permission of ["contents", "issues", "pull_requests", "actions"]) {
    if (permissions[permission] !== "write") fail(`The factory App needs ${permission}: write`);
  }
  for (const permission of ["checks", "statuses"]) {
    if (!["read", "write"].includes(permissions[permission])) fail(`The factory App needs ${permission}: read`);
  }
  if (permissions.administration && permissions.administration !== "none"
    || permissions.workflows && permissions.workflows !== "none") fail("The runtime App must not have administration or workflows permission");
  if (config.reviewBots.some((bot) => identity(bot) === identity(app.slug))) fail("The factory App cannot be its own review signal");
}

// Keep writer restrictions separate from history protection: a bypass on the
// update rule must never grant the App permission to delete/force-push state.
// https://docs.github.com/en/rest/repos/rules
export function setupRulesets(appId, checks) {
  if (!positive(appId)) fail("Invalid factory App ID");
  const required = setupChecks(checks);
  const make = (name, ref, bypass, rules) => ({ name, target: "branch", enforcement: "active",
    bypass_actors: bypass, conditions: { ref_name: { include: [ref], exclude: [] } }, rules });
  const admin = { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "exempt" };
  return [
    make("factory-state-writers", "refs/heads/factory-state", [
      { actor_type: "Integration", actor_id: appId, bypass_mode: "always" }, { ...admin, bypass_mode: "always" },
    ], [{ type: "creation" }, { type: "update", parameters: { update_allows_fetch_and_merge: false } }]),
    make("factory-state-history", "refs/heads/factory-state", [], [{ type: "deletion" }, { type: "non_fast_forward" }]),
    make("factory-approval", "~DEFAULT_BRANCH", [admin], [{ type: "deletion" }, { type: "non_fast_forward" },
      { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false, require_last_push_approval: true, required_review_thread_resolution: false } }]),
    make("factory-integration", "~DEFAULT_BRANCH", [], [{ type: "required_status_checks", parameters: {
      required_status_checks: required, strict_required_status_checks_policy: true, do_not_enforce_on_create: false,
    } }]),
  ];
}

function ruleSatisfies(actual, expected) {
  if (actual.type !== expected.type) return false;
  const a = actual.parameters ?? {}, e = expected.parameters ?? {};
  if (expected.type === "pull_request") return positive(a.required_approving_review_count) && a.require_last_push_approval === true;
  if (expected.type === "required_status_checks") return a.strict_required_status_checks_policy === true
    && a.do_not_enforce_on_create === false && Array.isArray(a.required_status_checks)
    && e.required_status_checks.every((check) => a.required_status_checks.some((c) => c.context === check.context
      && (check.integration_id === undefined || c.integration_id === check.integration_id)));
  return Object.entries(e).every(([key, value]) => same(a[key], value));
}

// Call with full administrator GET /rulesets/:id responses, not the abbreviated
// list or /rules/branches endpoint (which omits bypass identities).
export function verifySetupRulesets(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) fail("Ruleset observations are unavailable");
  const errors = [];
  for (const wanted of expected) {
    const matches = actual.filter((r) => r.name === wanted.name);
    if (matches.length !== 1) { errors.push(`${wanted.name}: expected exactly one managed ruleset`); continue; }
    const found = matches[0];
    if (found.target !== "branch" || found.enforcement !== "active" || !same(found.conditions, wanted.conditions)) errors.push(`${wanted.name}: wrong enforcement or branch scope`);
    if (!Array.isArray(found.bypass_actors) || !same(sorted(found.bypass_actors.map(actorKey)), sorted(wanted.bypass_actors.map(actorKey)))) errors.push(`${wanted.name}: bypass identities do not match`);
    if (!Array.isArray(found.rules) || new Set(found.rules.map((r) => r.type)).size !== found.rules.length
      || !wanted.rules.every((rule) => found.rules.some((r) => ruleSatisfies(r, rule)))) errors.push(`${wanted.name}: required protection is missing or weaker`);
  }
  return { valid: errors.length === 0, errors };
}

export function verifyStateSetupRules(rules, rulesets) {
  if (!Array.isArray(rules) || !Array.isArray(rulesets)) return { valid: false, errors: ["Effective state-branch rules are unavailable"] };
  const writers = rulesets.find((r) => r.name === "factory-state-writers"), history = rulesets.find((r) => r.name === "factory-state-history");
  const errors = [];
  if (!positive(writers?.id) || !positive(history?.id)) errors.push("State protections lack stable ruleset identities");
  for (const [type, id] of [["update", writers?.id], ["deletion", history?.id], ["non_fast_forward", history?.id]]) {
    if (!rules.some((r) => r.type === type && r.ruleset_id === id)) errors.push(`State branch does not report its ${type} protection`);
  }
  if (rules.some((r) => !["creation", "update", "deletion", "non_fast_forward"].includes(r.type)
    || ["creation", "update"].includes(r.type) && r.ruleset_id !== writers?.id)) errors.push("Additional rules may prevent the App from updating state; inspect their bypass policy");
  return { valid: errors.length === 0, errors };
}

export function setupPlan({ repository, app, configText, checks, ciWorkflows,
  toolingRepository = "ntodd/github-actions", ref = "main", dryRun = true, attachments = false }) {
  if (!positive(repository?.id) || !/^[\w.-]+\/[\w.-]+$/.test(repository.full_name ?? "")
    || repository.permissions?.admin !== true || repository.archived || repository.disabled) fail("Setup requires administrator access to an active repository");
  const config = parseConfig(configText);
  validateSetupApp(app, config);
  const descriptions = {
    "agent-ready": ["1f883d", "Accepted work is queued"], "agent-working": ["fbca04", "An operation owns this work"],
    "agent-review": ["0e8a16", "Waiting for human review and merge decision"], "agent-waiting": ["c5def5", "Waiting for an external result"],
    "agent-needs-you": ["d93f0b", "A human decision is needed"], "agent-failed": ["b60205", "Automatic recovery budget exhausted"],
    "agent-stopped": ["5319e7", "Work is explicitly paused"], "agent-covered": ["c2e0c6", "Another recorded PR covers this work"],
    "agent-complete": ["0e8a16", "All required work has an accepted final outcome"],
  };
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) descriptions[`effort:${effort}`] = ["c5def5", `Use ${effort} effort for subsequent runs`];
  return { repositoryId: String(repository.id), repo: repository.full_name, defaultBranch: repository.default_branch,
    mode: dryRun ? "read-only" : "active", stateBranch: "factory-state", appId: app.id, appLogin: `${app.slug.toLowerCase()}[bot]`,
    variable: { name: "AGENT_APP_ID", value: String(app.id) }, settings: { allow_auto_merge: true },
    rulesets: setupRulesets(app.id, checks), labels: Object.entries(descriptions).map(([name, [color, description]]) => ({ name, color, description })),
    files: [
      { path: ".github/workflows/factory.yml", content: callerWorkflow({ defaultBranch: repository.default_branch, ciWorkflows, toolingRepository, ref, dryRun, attachments }) },
      { path: ".github/factory.yml", content: configText.endsWith("\n") ? configText : `${configText}\n` },
      { path: ".github/workflows/factory-completion.yml", content: callerWorkflow({ defaultBranch: repository.default_branch,
        ciWorkflows, toolingRepository, ref, dryRun, attachments, completion: true }) },
    ],
  };
}
