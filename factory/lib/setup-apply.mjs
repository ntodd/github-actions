import { createHash } from "node:crypto";
import { canonical } from "./store.mjs";
import { setupEffect } from "./setup-journal.mjs";
import { verifySetupRulesets, verifyStateSetupRules } from "./setup.mjs";
import { recordFactoryApp } from "./protocol.mjs";
import { parseConfig } from "./config.mjs";
import { selectProjectSecrets } from "./project-environment.mjs";
import { assertRuntimeIsolation } from "./runtime-guard.mjs";
const digest = (v) => createHash("sha256").update(typeof v === "string" ? v : canonical(v)).digest("hex");
const sha = (v) => /^[a-f\d]{40}$/.test(v ?? "");
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const missing = async (read) => { try { return await read(); } catch (error) { if (error.status === 404) return null; throw error; } };
const noState = (error) => error.code === "corrupt" && error.message.startsWith("factory-state is missing");

function mergeRule(existing, wanted) {
  const merged = structuredClone(wanted);
  merged.rules = [...(existing.rules ?? []).filter((r) => !wanted.rules.some((w) => w.type === r.type)), ...wanted.rules.map((rule) => {
    const previous = existing.rules?.find((r) => r.type === rule.type);
    if (!previous?.parameters) return rule;
    const parameters = { ...previous.parameters, ...rule.parameters };
    if (rule.type === "pull_request") {
      parameters.required_approving_review_count = Math.max(previous.parameters.required_approving_review_count ?? 0, rule.parameters.required_approving_review_count);
      for (const key of ["dismiss_stale_reviews_on_push", "require_code_owner_review", "required_review_thread_resolution"]) {
        parameters[key] = Boolean(previous.parameters[key] || rule.parameters[key]);
      }
    }
    if (rule.type === "required_status_checks") {
      const checks = new Map((previous.parameters.required_status_checks ?? []).map((c) => [c.context, c]));
      for (const c of rule.parameters.required_status_checks) {
        const old = checks.get(c.context);
        if (old?.integration_id && c.integration_id && old.integration_id !== c.integration_id) throw new Error(`Check ${c.context} is bound to a different App; inspect the existing policy`);
        checks.set(c.context, { ...c, ...(old?.integration_id ? { integration_id: old.integration_id } : {}) });
      }
      parameters.required_status_checks = [...checks.values()];
    }
    return { ...rule, parameters };
  })];
  return merged;
}

export async function applySetupPlan({ plan, api, store, journal, secrets = {}, preview = false, now = () => new Date().toISOString() }) {
  const repository = await api.repository();
  if (String(repository.id) !== plan.repositoryId || repository.full_name.toLowerCase() !== plan.repo.toLowerCase()
    || repository.default_branch !== plan.defaultBranch || repository.permissions?.admin !== true
    || repository.archived || repository.disabled) throw new Error("Repository identity, default branch or administrator permission changed");
  if (!["read-only", "active"].includes(plan.mode) || plan.stateBranch !== "factory-state"
    || plan.files?.length !== 2 || plan.files[0].path !== ".github/workflows/factory.yml" || plan.files[1].path !== ".github/factory.yml") throw new Error("Invalid setup plan");
  for (const [name, value] of Object.entries(secrets)) if (!["AGENT_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SETUP_SECRETS", "AGENT_ATTACH_TOKEN"].includes(name)
    || typeof value !== "string" || !value || Buffer.byteLength(value) > 48 * 1024) throw new Error("Invalid setup secret input (maximum 48 KiB)");
  const config = parseConfig(plan.files[1].content);
  if (secrets.SETUP_SECRETS !== undefined) selectProjectSecrets(config.environment, secrets.SETUP_SECRETS);
  let before;
  try { before = await store.load(); } catch (error) { if (!noState(error)) throw error; }
  const factoryApp = { id: String(plan.appId), login: plan.appLogin };
  // Refuse an identity switch in preview too, before any administrator writes.
  if (before) recordFactoryApp(before.state, factoryApp);
  const names = new Set([...await api.secretNames(), ...Object.keys(secrets)]);
  if (!names.has("AGENT_APP_PRIVATE_KEY")) throw new Error("Setup needs an existing or supplied AGENT_APP_PRIVATE_KEY secret");
  if (plan.mode === "active") {
    if ((config.environment.setupSecrets.length || config.environment.workerSecrets.length) && !names.has("SETUP_SECRETS")) {
      throw new Error("Activation requires SETUP_SECRETS for the declared project secret names");
    }
    if (!names.has("CLAUDE_CODE_OAUTH_TOKEN") && !names.has("ANTHROPIC_API_KEY")) throw new Error("Activation requires a worker model credential");
    await assertRuntimeIsolation(api);
    const known = new Set(Object.values(before?.state.items ?? {}).flatMap((item) => item.prs.map((pr) => pr.number)));
    const unknown = (await api.openPulls()).filter((pr) => pr.user?.login?.toLowerCase() === plan.appLogin && !known.has(pr.number));
    if (unknown.length) throw new Error(`Migrate App PR membership before activation: ${unknown.map((p) => `#${p.number}`).join(", ")}`);
    const issues = await api.openIssues();
    if (!Array.isArray(issues) || issues.some((i) => !Number.isSafeInteger(i.number) || i.number < 1 || !Array.isArray(i.labels))) throw new Error("Legacy issue inventory is incomplete; activation is withheld");
    const legacy = issues.filter((i) => {
      const recorded = before?.state.items[`issue:${i.number}`];
      return !(recorded?.migration || recorded?.prs.length || recorded?.attempts.length)
        && i.labels.some((l) => ["agent-working", "agent-blocked", "agent-done", "agent-covered", "agent-conflict"].includes(l.name ?? l));
    });
    if (legacy.length) throw new Error(`Migrate legacy issue records before activation: ${legacy.map((i) => `#${i.number}`).join(", ")}`);
  }
  const baseSha = await api.branchSha(plan.defaultBranch);
  if (!sha(baseSha)) throw new Error("The default branch returned an invalid commit");
  if (preview) return { status: "preview", plan, state: before ? "existing" : "initialize", secrets: Object.keys(secrets),
    warnings: names.has("OPENAI_API_KEY") ? [] : ["Mentions will ask for exact commands until OPENAI_API_KEY is configured"] };
  if (!journal) throw new Error("Applying setup requires its durable administrator journal");
  const effect = (slot, definition, inspect, submit, repeatable = false) => setupEffect({ journal, slot, definition, inspect, submit, repeatable, now });
  await store.initialize();
  for (const wanted of plan.rulesets) {
    const found = (await api.rulesets()).filter((r) => r.name === wanted.name);
    if (found.length > 1) throw new Error(`Several rulesets claim ${wanted.name}; inspect them before proceeding`);
    const oldCreate = journal.get(`ruleset-create:${wanted.name}`);
    if (!found.length || oldCreate?.status === "pending") {
      await effect(`ruleset-create:${wanted.name}`, { kind: "ruleset-create", value: wanted }, async () => {
        const rows = (await api.rulesets()).filter((r) => r.name === wanted.name);
        if (rows.length > 1) throw new Error(`Several rulesets claim ${wanted.name}`);
        return rows.length === 1 && verifySetupRulesets(rows, [wanted]).valid ? { applied: true, receipt: { id: rows[0].id } } : null;
      }, async () => { const result = await api.createRuleset(wanted); if (!positive(result.id)) throw new Error("Invalid ruleset receipt"); return { id: result.id }; });
    } else if (!verifySetupRulesets(found, [wanted]).valid) {
      const value = mergeRule(found[0], wanted), id = found[0].id;
      await effect(`ruleset-update:${id}:${digest(value)}`, { kind: "ruleset-update", id, value }, async () => {
        const rows = (await api.rulesets()).filter((r) => r.id === id);
        return verifySetupRulesets(rows, [wanted]).valid ? { applied: true, receipt: { id } } : null;
      }, async () => { const result = await api.updateRuleset(id, value); if (result.id !== id) throw new Error("Invalid ruleset receipt"); return { id }; }, true);
    }
  }
  const protection = verifySetupRulesets(await api.rulesets(), plan.rulesets);
  if (!protection.valid) throw new Error(`Repository protections are not verified: ${protection.errors.join("; ")}`);
  const stateProtection = verifyStateSetupRules(await api.branchRules(plan.stateBranch), await api.rulesets());
  if (!stateProtection.valid) throw new Error(`State access policy is not verified: ${stateProtection.errors.join("; ")}`);
  await store.transact((s) => recordFactoryApp(s, factoryApp));
  for (const label of plan.labels) {
    const slot = `label:${label.name}:${digest(label)}`;
    await effect(slot, { kind: "label", value: label }, async () => {
      const found = (await api.labels()).find((l) => l.name === label.name);
      return found?.color === label.color && found?.description === label.description ? { applied: true, receipt: { name: label.name } } : null;
    }, async () => {
      const found = (await api.labels()).find((l) => l.name === label.name);
      await (found ? api.updateLabel(label.name, label) : api.createLabel(label)); return { name: label.name };
    }, true);
  }
  await effect(`variable:${plan.variable.value}`, { kind: "variable", ...plan.variable }, async () => {
    const value = await missing(() => api.variable(plan.variable.name));
    return value?.value === plan.variable.value ? { applied: true, receipt: { name: plan.variable.name } } : null;
  }, async () => {
    const found = await missing(() => api.variable(plan.variable.name));
    await (found ? api.updateVariable(plan.variable.name, plan.variable) : api.createVariable(plan.variable)); return { name: plan.variable.name };
  }, true);
  for (const [name, value] of Object.entries(secrets)) {
    // The value goes only to gh's stdin. A local digest distinguishes explicit
    // changes without persisting credentials or printing them in the plan.
    await effect(`secret:${name}:${digest(value)}`, { kind: "secret", name, fingerprint: digest(value) }, async (record) =>
      record.status === "done" && (await api.secretNames()).includes(name) ? { applied: true, receipt: { name } } : null,
    async () => { await api.setSecret(name, value); return { name }; }, true);
  }
  await effect("auto-merge", { kind: "repository-setting", allow_auto_merge: true }, async () =>
    (await api.repository()).allow_auto_merge === true ? { applied: true, receipt: { allow_auto_merge: true } } : null,
  async () => { await api.settings(plan.settings); return { allow_auto_merge: true }; }, true);
  const state = (await store.load()).state;
  if (state.repositoryId !== plan.repositoryId) throw new Error("State verification belongs to another repository");
  const result = await setupPullRequest({ plan, api, journal, baseSha, now });
  const current = await api.repository(), finalProtection = verifySetupRulesets(await api.rulesets(), plan.rulesets);
  if (String(current.id) !== plan.repositoryId || current.default_branch !== plan.defaultBranch || !current.allow_auto_merge || !finalProtection.valid) throw new Error("Setup changed during verification; the repository is not enabled");
  const finalLabels = await api.labels(), finalVariable = await api.variable(plan.variable.name);
  if (finalVariable.value !== plan.variable.value || !plan.labels.every((wanted) => finalLabels.some((found) => found.name === wanted.name
    && found.color === wanted.color && found.description === wanted.description))) throw new Error("Setup labels or App ID were not observed after writing");
  const finalNames = new Set(await api.secretNames());
  if (!finalNames.has("AGENT_APP_PRIVATE_KEY") || Object.keys(secrets).some((name) => !finalNames.has(name))) throw new Error("Setup credentials were not observed after writing");
  if (!result.pr) {
    const currentSha = await api.branchSha(plan.defaultBranch);
    if (!(await Promise.all(plan.files.map(async (file) => await missing(() => api.fileAt(file.path, currentSha)) === file.content))).every(Boolean)) throw new Error("The default-branch caller/config changed during setup verification");
  }
  return { status: result.pr ? "pending-merge" : plan.mode, mode: plan.mode, protectionsVerified: true,
    ...result, warnings: finalNames.has("OPENAI_API_KEY") ? [] : ["Mentions require OPENAI_API_KEY; exact commands remain available"] };
}

export async function setupPullRequest({ plan, api, journal, baseSha, now }) {
  if ((await Promise.all(plan.files.map(async (file) => await missing(() => api.fileAt(file.path, baseSha)) === file.content))).every(Boolean)) return { pr: null };
  const contentHash = digest({ baseSha, files: plan.files }), branch = `factory/setup-${contentHash.slice(0, 24)}`;
  if (branch === plan.defaultBranch || branch === plan.stateBranch) throw new Error("Setup cannot publish to the default or state branch");
  const slot = `branch:${branch}`, prior = journal.get(slot);
  let definition = prior?.definition;
  if (!definition) {
    const base = await api.commit(baseSha);
    if (!sha(base.tree?.sha)) throw new Error("Invalid setup base tree");
    const tree = await api.createTree(plan.files.map((file) => ({ path: file.path, type: "blob", mode: "100644", content: file.content })), base.tree.sha);
    if (!sha(tree.sha)) throw new Error("Invalid setup tree receipt");
    let commitSha = await missing(() => api.branchSha(branch));
    if (commitSha) {
      const found = await api.commit(commitSha);
      if (found.tree?.sha !== tree.sha || found.parents?.length !== 1 || found.parents[0].sha !== baseSha) throw new Error("The reserved setup branch contains other work");
    } else {
      const commit = await api.createCommit(tree.sha, baseSha); commitSha = commit.sha;
      if (!sha(commitSha) || commit.tree?.sha !== tree.sha || commit.parents?.length !== 1 || commit.parents[0].sha !== baseSha) throw new Error("Invalid setup commit receipt");
    }
    definition = { kind: "branch", branch, commitSha, treeSha: tree.sha, baseSha, contentHash };
  }
  if (definition.branch !== branch || definition.baseSha !== baseSha || definition.contentHash !== contentHash
    || !sha(definition.commitSha) || !sha(definition.treeSha)) throw new Error("Setup branch intent changed");
  await setupEffect({ journal, slot, definition, now, inspect: async () => {
    const head = await missing(() => api.branchSha(branch));
    if (head && head !== definition.commitSha) throw new Error("The setup branch changed; it will not be overwritten");
    return head ? { applied: true, receipt: { branch, sha: head } } : null;
  }, submit: async () => {
    const ref = await api.createBranch(branch, definition.commitSha);
    if (ref.object?.sha !== definition.commitSha) throw new Error("Invalid setup branch receipt");
    return { branch, sha: definition.commitSha };
  } });
  const marker = `<!-- factory:setup=${contentHash} -->`;
  const matches = async () => {
    const rows = await api.pullsFor(branch, plan.defaultBranch);
    if (rows.length > 1) throw new Error("Several PRs claim this setup branch");
    const found = rows[0];
    if (found && (found.state !== "open" || !found.body?.includes(marker) || found.head?.sha !== definition.commitSha
      || found.head?.ref !== branch || found.base?.ref !== plan.defaultBranch)) throw new Error("The setup PR changed or closed; inspect it before replacing it");
    return found;
  };
  const receipt = await setupEffect({ journal, slot: `pr:${branch}`, definition: { kind: "pull-request", branch, base: plan.defaultBranch, marker }, now,
    inspect: async () => { const found = await matches(); return found ? { applied: true, receipt: { number: found.number, url: found.html_url } } : null; },
    submit: async () => {
      const bootstrap = plan.mode === "bootstrap-read-only";
      const body = bootstrap
        ? `Install the factory caller/config in read-only mode, pinned to shared commit ${plan.toolingSha}. After review and merge, the repository owner can manually dispatch request {"kind":"inspect"} to verify the existing App secret through public metadata.\n\nAdministrator setup, protected-state initialization and migration follow inspection. The legacy runtime can remain active during this read-only step.`
        : `Add the shared factory caller and repository configuration. The caller starts in ${plan.mode} mode.\n\nRepository protections and the state branch were configured separately by the administrator. Review these files before merging.`;
      const pr = await api.createPull({ title: bootstrap ? "Prepare read-only factory App inspection" : "Configure factory issue handling", head: branch, base: plan.defaultBranch,
        draft: bootstrap, body: `${body}\n\n${marker}` });
      if (!positive(pr.number)) throw new Error("Invalid setup PR receipt"); return { number: pr.number, url: pr.html_url };
    } });
  return { pr: receipt.number, url: receipt.url, branch };
}
