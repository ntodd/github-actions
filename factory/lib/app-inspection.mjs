// A manual, default-branch setup inspection. The App JWT is used only for GET
// metadata; this path neither mints an installation token nor accesses state.
import { inspectSetupApp } from "./setup-client.mjs";
import { validateSetupApp } from "./setup.mjs";
import { verifyEntry } from "./entry.mjs";
import { callerWorkflow } from "./caller.mjs";
import { parseConfig } from "./config.mjs";
import { resultFiles } from "./actions.mjs";
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const permissions = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100
    || Object.entries(value).some(([key, permission]) => !/^[a-z_]{1,100}$/.test(key) || !["read", "write", "none"].includes(permission))) {
    throw new Error("App inspection returned invalid permission metadata");
  }
  return Object.fromEntries(Object.entries(value));
};

export async function inspectFactoryApp({ api, env, context, inspect = inspectSetupApp, now = () => new Date().toISOString() }) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("App inspection requires a manual default-branch dispatch");
  const repository = await api.repository();
  const owner = repository.owner?.login;
  if (typeof owner !== "string" || repository.owner?.type !== "User" || repository.full_name !== env.GITHUB_REPOSITORY
    || String(repository.id) !== context.repositoryId || repository.default_branch !== context.defaultBranch
    || env.GITHUB_ACTOR !== owner || env.GITHUB_TRIGGERING_ACTOR !== owner) {
    throw new Error("App inspection requires the personal repository owner's manual request");
  }
  const run = await verifyEntry({ api, env, context });
  if (run.event !== "workflow_dispatch" || run.actor?.login !== owner || run.triggering_actor?.login !== owner) {
    throw new Error("App inspection run identity does not match the owner's manual dispatch");
  }
  if (env.GITHUB_REF !== `refs/heads/${context.defaultBranch}` || context.sha !== env.GITHUB_SHA || await api.branchSha(context.defaultBranch) !== env.GITHUB_SHA
    || !sha(env.FACTORY_TOOLING_SHA) || env.FACTORY_TOOLING_REPOSITORY !== "ntodd/github-actions") {
    throw new Error("App inspection must use the current default branch and the trusted shared runtime");
  }
  const appId = Number(env.FACTORY_APP_ID), privateKey = env.FACTORY_APP_PRIVATE_KEY;
  if (!Number.isSafeInteger(appId) || appId < 1 || !/^[1-9]\d*$/.test(env.FACTORY_APP_ID ?? "")
    || typeof privateKey !== "string" || !privateKey || Buffer.byteLength(privateKey) > 48 * 1024) throw new Error("App inspection needs the existing App ID and private-key secret");
  let result;
  try { result = await inspect({ appId, privateKey, repo: repository.full_name }); }
  catch { throw new Error("App inspection could not verify the key and active installation; check the App ID, secret and installation"); }
  const { app, installation } = result ?? {};
  if (app?.id !== appId || installation?.app_id !== appId || !Number.isSafeInteger(installation.id) || installation.id < 1
    || installation.suspended_at !== null || !["all", "selected"].includes(installation.repository_selection)) throw new Error("App inspection returned inconsistent installation metadata");
  const appPermissions = permissions(app.permissions), installationPermissions = permissions(installation.permissions);
  validateSetupApp(app, context.config);
  validateSetupApp({ ...app, permissions: installation.permissions }, context.config);
  const observedAt = now();
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) throw new Error("App inspection requires a valid observation timestamp");
  // Select public fields explicitly; never serialize the input environment or
  // the inspection adapter's whole response (which might gain credential fields).
  return { schemaVersion: 1, observedAt, repository: { id: String(repository.id), fullName: repository.full_name,
    defaultBranch: repository.default_branch, headSha: env.GITHUB_SHA },
  run: { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) }, actor: owner,
  tooling: { repository: env.FACTORY_TOOLING_REPOSITORY, sha: env.FACTORY_TOOLING_SHA },
  app: { id: app.id, slug: app.slug, permissions: appPermissions },
  installation: { id: installation.id, app_id: installation.app_id, permissions: installationPermissions,
    repository_selection: installation.repository_selection, suspended_at: null } };
}

// Administrator setup selects an API run/attempt, never a local JSON report.
// The current generated caller and actual referenced SHA establish which clean
// code produced the digest-bound artifact before its public identity is used.
export async function readAppInspection({ api, actions, repository, runId, attempt = 1, toolingSha, ciWorkflows,
  now = () => new Date().toISOString() }) {
  const instant = Date.parse(now()), owner = repository?.owner?.login, workflow = ".github/workflows/factory.yml";
  if (!/^[1-9]\d*$/.test(runId ?? "") || !Number.isSafeInteger(attempt) || attempt < 1 || !sha(toolingSha)
    || !Number.isFinite(instant) || !Number.isSafeInteger(repository?.id) || repository.id < 1
    || repository.permissions?.admin !== true || repository.owner?.type !== "User" || typeof owner !== "string"
    || repository.archived || repository.disabled) throw new Error("Inspection setup requires administrator access, a personal repository, a run/attempt and an immutable shared SHA");
  const head = await api.branchSha(repository.default_branch);
  const caller = await api.fileAt(workflow, head);
  if (!sha(head) || caller !== callerWorkflow({ defaultBranch: repository.default_branch, ciWorkflows, ref: toolingSha, dryRun: true })) {
    throw new Error("Inspection setup requires the current generated read-only caller pinned to --ref; inspect the installed caller and dispatch again");
  }
  const run = await api.run(runId, attempt), started = Date.parse(run.run_started_at), finished = Date.parse(run.updated_at);
  const paths = [workflow, `${workflow}@${repository.default_branch}`, `${workflow}@refs/heads/${repository.default_branch}`];
  if (String(run.id) !== runId || run.run_attempt !== attempt || run.status !== "completed" || run.conclusion !== "success"
    || run.event !== "workflow_dispatch" || !paths.includes(run.path) || run.head_sha !== head || run.head_branch !== repository.default_branch
    || run.repository?.id !== repository.id || run.head_repository?.id !== repository.id
    || run.actor?.login !== owner || run.triggering_actor?.login !== owner || !Number.isFinite(started) || !Number.isFinite(finished)
    || finished < started || finished > instant + 60000 || instant - started > 86400000) throw new Error("Inspection needs a recent successful owner-dispatched attempt on the current default branch");
  const shared = (name) => `ntodd/github-actions/.github/workflows/${name}.yml@${toolingSha}`;
  if (!Array.isArray(run.referenced_workflows) || run.referenced_workflows.filter((w) => w.path === shared("factory-runtime")).length !== 1
    || run.referenced_workflows.some((w) => ![shared("factory-runtime"), shared("factory-wakeup")].includes(w.path) || w.sha !== toolingSha)) {
    throw new Error("Inspection run does not prove the pinned shared workflow provenance");
  }
  const jobs = await api.jobs(runId, attempt), role = (job, name) => job.name === name || job.name?.endsWith(` / ${name}`);
  const controls = jobs.filter((j) => role(j, "factory-control"));
  if (controls.length !== 1 || controls[0].status !== "completed" || controls[0].conclusion !== "success"
    || String(controls[0].run_id) !== runId || controls[0].run_attempt !== attempt || controls[0].head_sha !== head
    || !Array.isArray(controls[0].steps) || controls[0].steps.filter((s) => s.name === "Upload public App inspection metadata"
      && s.status === "completed" && s.conclusion === "success").length !== 1
    || jobs.some((j) => (role(j, "factory-worker") || role(j, "factory-update")) && j.conclusion !== "skipped")) {
    throw new Error("Inspection requires the successful clean inspection job and no executed worker/update job");
  }
  const matches = (await api.artifacts(runId)).filter((a) => a.name === `factory-inspection-${runId}-${attempt}`);
  const artifact = matches[0], created = Date.parse(artifact?.created_at), expires = Date.parse(artifact?.expires_at);
  if (matches.length !== 1 || !Number.isSafeInteger(artifact?.id) || artifact.id < 1 || artifact.expired !== false
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || !Number.isSafeInteger(artifact.size_in_bytes)
    || artifact.size_in_bytes < 22 || artifact.size_in_bytes > 128 * 1024 || !Number.isFinite(created)
    || created < started - 1000 || created > finished + 1000 || !Number.isFinite(expires) || expires <= instant
    || String(artifact.workflow_run?.id) !== runId || artifact.workflow_run.repository_id !== repository.id
    || artifact.workflow_run.head_repository_id !== repository.id || artifact.workflow_run.head_sha !== head
    || artifact.workflow_run.head_branch !== repository.default_branch) throw new Error("Inspection artifact is missing, expired, ambiguous or has inconsistent provenance");
  const files = resultFiles(await actions.downloadArchive(artifact, 128 * 1024), { inspection: true });
  const report = JSON.parse(files.get("factory-app-inspection.json").toString("utf8")), observed = Date.parse(report.observedAt);
  const [variable, names, configText] = await Promise.all([api.variable("AGENT_APP_ID"), api.secretNames(), api.fileAt(".github/factory.yml", head)]);
  if (report.schemaVersion !== 1 || report.repository?.id !== String(repository.id) || report.repository.fullName !== repository.full_name
    || report.repository.defaultBranch !== repository.default_branch || report.repository.headSha !== head
    || report.run?.id !== runId || report.run.attempt !== attempt || report.actor !== owner
    || report.tooling?.repository !== "ntodd/github-actions" || report.tooling.sha !== toolingSha
    || !Number.isFinite(observed) || observed < started - 1000 || observed > finished + 1000 || observed > instant + 60000
    || !/^[1-9]\d*$/.test(variable.value) || String(report.app?.id) !== variable.value || !names.includes("AGENT_APP_PRIVATE_KEY")
    || report.installation?.app_id !== report.app.id || !Number.isSafeInteger(report.installation.id) || report.installation.id < 1
    || report.installation.suspended_at !== null || !["all", "selected"].includes(report.installation.repository_selection)) throw new Error("Inspection report does not match the verified run, current App variable and installed key");
  const config = parseConfig(configText), app = { id: report.app.id, slug: report.app.slug, permissions: permissions(report.app.permissions) };
  const installation = { id: report.installation.id, app_id: report.installation.app_id,
    permissions: permissions(report.installation.permissions), repository_selection: report.installation.repository_selection, suspended_at: null };
  validateSetupApp(app, config); validateSetupApp({ ...app, permissions: installation.permissions }, config);
  const current = await api.repository();
  if (current.id !== repository.id || current.full_name !== repository.full_name || current.default_branch !== repository.default_branch
    || current.owner?.login !== owner || current.owner?.type !== "User" || current.permissions?.admin !== true
    || current.archived || current.disabled || await api.branchSha(repository.default_branch) !== head) throw new Error("Repository or default branch changed while verifying inspection; dispatch again");
  return { app, installation, provenance: { run: { id: runId, attempt }, artifact: { id: String(artifact.id), digest: artifact.digest },
    headSha: head, toolingSha, observedAt: report.observedAt } };
}
