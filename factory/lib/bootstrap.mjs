import { parseConfig } from "./config.mjs";
import { callerWorkflow } from "./caller.mjs";
import { setupPullRequest } from "./setup-apply.mjs";
import { parseDocument } from "../vendor/yaml.mjs";
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const activeRepository = (repository) => repository && Number.isSafeInteger(repository.id) && repository.id > 0
  && /^[\w.-]+\/[\w.-]+$/.test(repository.full_name) && repository.permissions?.admin === true
  && !repository.archived && !repository.disabled;

// Bootstrap adds only the reviewed caller/config needed to inspect an existing
// GitHub-held key. It must not invent a verified App identity or initialize state.
export function bootstrapPlan({ repository, configText, baseSha, appIdCandidate, ciWorkflows, ref }) {
  if (!activeRepository(repository) || !sha(baseSha) || !sha(ref)
    || !/^[1-9]\d*$/.test(appIdCandidate ?? "") || !Number.isSafeInteger(Number(appIdCandidate))) throw new Error("Bootstrap needs administrator access, an existing App ID and an immutable shared commit");
  parseConfig(configText);
  return { mode: "bootstrap-read-only", repositoryId: String(repository.id), repo: repository.full_name,
    defaultBranch: repository.default_branch, stateBranch: "factory-state", baseSha, appIdCandidate: String(appIdCandidate),
    ciWorkflows: [...ciWorkflows], toolingSha: ref, files: [
      { path: ".github/workflows/factory.yml", content: callerWorkflow({ defaultBranch: repository.default_branch, ciWorkflows, ref, dryRun: true }) },
      { path: ".github/factory.yml", content: configText.endsWith("\n") ? configText : `${configText}\n` },
    ] };
}

export async function applyBootstrap({ plan, api, journal, preview = false, now = () => new Date().toISOString() }) {
  const repository = await api.repository();
  if (!activeRepository(repository) || String(repository.id) !== plan.repositoryId || repository.full_name !== plan.repo
    || repository.default_branch !== plan.defaultBranch || plan.mode !== "bootstrap-read-only") throw new Error("Bootstrap repository identity or administrator permission changed");
  const expected = bootstrapPlan({ repository, configText: plan.files?.[1]?.content, baseSha: plan.baseSha,
    appIdCandidate: plan.appIdCandidate, ciWorkflows: plan.ciWorkflows, ref: plan.toolingSha });
  if (JSON.stringify(plan.files) !== JSON.stringify(expected.files)) throw new Error("Bootstrap may publish only its generated read-only caller and config");
  const [tip, variable, names] = await Promise.all([api.branchSha(plan.defaultBranch), api.variable("AGENT_APP_ID"), api.secretNames()]);
  if (tip !== plan.baseSha || variable.value !== plan.appIdCandidate || !names.includes("AGENT_APP_PRIVATE_KEY")) {
    throw new Error("Bootstrap base, App ID or existing private-key secret changed; inspect and replan");
  }
  let existing;
  try { existing = await api.fileAt(plan.files[0].path, tip); }
  catch (error) { if (error.status !== 404) throw error; }
  if (existing) {
    const document = parseDocument(existing, { uniqueKeys: true, logLevel: "error" });
    if (document.errors.length || document.toJS({ maxAliasCount: 0 })?.jobs?.factory?.with?.["dry-run"] !== true) {
      throw new Error("Bootstrap cannot replace an active or unrecognized factory caller; use administrator setup");
    }
  }
  if (preview) return { status: "preview", plan, appVerified: false, next: "Review the caller/config PR, then manually dispatch request {\"kind\":\"inspect\"} on the default branch" };
  if (!journal) throw new Error("Bootstrap requires its administrator recovery journal");
  const result = await setupPullRequest({ plan, api, journal, baseSha: plan.baseSha, now });
  return { status: result.pr ? "pending-merge" : "inspection-ready", mode: plan.mode, ...result,
    request: { kind: "inspect" }, appVerified: false };
}
