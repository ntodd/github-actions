// A manual, default-branch setup inspection. The App JWT is used only for GET
// metadata; this path neither mints an installation token nor accesses state.
import { inspectSetupApp } from "./setup-client.mjs";
import { validateSetupApp } from "./setup.mjs";
import { verifyEntry } from "./entry.mjs";
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
