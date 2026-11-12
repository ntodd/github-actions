import { createHash } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { inspectIssue, inspectOwnPr, readFeedback } from "./admission.mjs";
import { threadRevision } from "./threads.mjs";
import { effectMarker, publishedPushes, landedCommits } from "./effects.mjs";
import { pendingControls } from "./commands.mjs";
import { factoryReadApi } from "./identity.mjs";
import { diagnoseChecks } from "./diagnostics.mjs";
import { attributeFailures } from "./failure-report.mjs";
import { repairSpec } from "./main-repair.mjs";
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const success = new Set(["success", "neutral", "skipped"]);
function latest(facts, key, date) {
  const byKey = new Map();
  for (const fact of facts) {
    const previous = byKey.get(key(fact));
    if (!previous || String(date(fact) ?? "").localeCompare(String(date(previous) ?? "")) > 0
      || (date(fact) === date(previous) && Number(fact.id) > Number(previous.id))) byKey.set(key(fact), fact);
  }
  return [...byKey.values()];
}
export function requiredChecks(rules) {
  if (!Array.isArray(rules)) throw new Error("Required-check rules are unavailable");
  const checks = rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters?.required_status_checks ?? []);
  if (!checks.length || checks.some((c) => typeof c.context !== "string" || !c.context)) throw new Error("No required checks are configured for the default branch");
  return checks.map((c) => ({ name: c.context, appId: c.integration_id ?? null }));
}
// Checks/statuses come from exact commit API endpoints. A missing, old or
// ambiguous observation is pending; a worker's test report cannot fill the gap.
export function checkFacts(raw, required, headSha = raw.sha) {
  const checks = latest(raw.checkRuns.filter((c) => c.head_sha === raw.sha), (c) => `${c.name}:${c.app?.id}`, (c) => c.started_at ?? c.completed_at);
  const statuses = latest(raw.statuses, (c) => c.context, (c) => c.updated_at ?? c.created_at);
  const records = required.map((r) => {
    const matches = checks.filter((c) => c.name === r.name && (r.appId === null || c.app?.id === r.appId));
    const legacy = r.appId === null ? statuses.filter((c) => c.context === r.name) : [];
    const observations = [...matches.map((c) => ({ kind: "check", id: c.id, name: c.name, appId: c.app?.id,
      state: c.status !== "completed" ? "pending" : success.has(c.conclusion) ? "success" : "failure", url: c.details_url,
      summary: String(c.output?.summary ?? "").slice(0, 16000), conclusion: c.conclusion })),
    ...legacy.map((c) => ({ kind: "status", id: c.id, name: c.context, provider: String(c.creator?.id ?? c.creator?.login ?? "unknown"),
      state: c.state === "success" ? "success" : ["error", "failure"].includes(c.state) ? "failure" : "pending", url: c.target_url, summary: String(c.description ?? "") }))];
    return { ...r, state: !observations.length || observations.some((o) => o.state === "pending") ? "pending"
      : observations.some((o) => o.state === "failure") ? "failure" : "success", observations };
  });
  return { headSha, testedSha: raw.sha, state: records.some((r) => r.state === "failure") ? "failure"
    : records.some((r) => r.state !== "success") ? "pending" : "success",
  failed: records.flatMap((r) => r.observations.filter((o) => o.state === "failure").map((o) => ({ ...o, sharedMain: false, signature: null }))), records };
}

async function prChecks(api, pr, baseSha = pr.base.sha) {
  const raw = await api.checks(pr.head.sha);
  if (pr.merge_commit_sha && pr.mergeable === true) {
    const commit = await api.commit(pr.merge_commit_sha);
    if (commit.parents?.length === 2 && commit.parents[0].sha === baseSha && commit.parents[1].sha === pr.head.sha) {
      const merge = await api.checks(pr.merge_commit_sha);
      if (merge.checkRuns.length || merge.statuses.length) return merge;
    }
  }
  return raw;
}

export async function diagnosticChecks(api, raw, required, context, scope = "pr", headSha = raw.sha) {
  return diagnoseChecks(api, checkFacts(raw, required, headSha), raw, { ...context, headSha }, scope);
}

async function baseChecks(api, sha, required, context, cache) {
  const key = `base:${sha}`;
  if (!cache.has(key)) cache.set(key, (async () => diagnosticChecks(api, await api.checks(sha), required, context, "base"))());
  return cache.get(key);
}
function checkFeedback(raw, config, pr) {
  const signals = checkFacts(raw, config.signals.map((s) => ({ name: s.check, appId: null })), pr.head.sha);
  const feedback = signals.records.flatMap((r) => r.observations.filter((o) => o.state === "failure").map((finding) => ({
    sourceId: `${finding.kind}:${finding.id}`, revision: fingerprint([finding, pr.head.sha]),
    authority: "signal", requiresResponse: true, target: pr.number, body: finding.summary, head: pr.head.sha,
    createdAt: new Date(0).toISOString(),
  })));
  return { signals, feedback };
}

export async function observeAuthorization(api, item, context) {
  const number = Number(item.key.split(":")[1]);
  if (!item.evidence.own) {
    const found = await inspectIssue(api, number, context.config, { evidence: item.evidence, allowClosed: true });
    return { authorization: found, subject: found.issue };
  }
  const found = await inspectOwnPr(api, number, context, { evidence: item.evidence, allowClosed: true });
  return { authorization: found, subject: found.pr };
}

export async function publishObservation(api, item, op, repo, appLogin = null) {
  api = factoryReadApi(api, appLogin?.toLowerCase());
  const context = { ...await loadConfig(api), repo };
  const [{ authorization, subject }, feedback] = await Promise.all([
    observeAuthorization(api, item, context),
    readFeedback(api, { issue: item.evidence.own ? null : Number(item.key.split(":")[1]), prs: item.prs.map((p) => p.number) }, context.config),
  ]);
  if ((op.feedbackInputs ?? []).some((f) => /^(check|status):/.test(f.sourceId))) {
    for (const record of item.prs) {
      const current = await api.pull(record.number);
      if (current.state === "open") feedback.push(...checkFeedback(await prChecks(api, current), context.config, current).feedback);
    }
  }
  // A stop visible before its controller acknowledgement still fences a new
  // write. Unconsumed work after it requires a controller pass to resume.
  const controls = pendingControls(item, feedback, op.inputs);
  const commandsValid = (op.inputs ?? []).every((id) => {
    const command = item.commands[id];
    return command && feedback.some((f) => f.sourceId === command.sourceId && f.revision === command.revision
      && f.authority === "instruction" && f.command);
  });
  const feedbackValid = (op.feedbackInputs ?? []).every((input) => feedback.some((f) => f.sourceId === input.sourceId
    && f.revision === input.revision && ["instruction", "signal"].includes(f.authority)));
  let head;
  try { head = await api.branchSha(op.target.branch); }
  catch (error) { if (error.status === 404) head = null; else throw error; }
  const pr = op.target.number ? await api.pull(op.target.number) : null;
  const expectedBranch = !pr || pr.head?.ref === op.target.branch && pr.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase() && pr.base?.ref === op.base.ref;
  const threadRevisions = {};
  for (const target of op.threadTargets ?? []) {
    const facts = feedback.filter((f) => f.target === op.target.number && f.thread === target.id && !(appLogin
      && f.author === appLogin.toLowerCase() && op.effects.some((e) => e.type === "thread-reply" && e.thread === target.id && f.body.includes(effectMarker(op, e)))));
    if (facts.length) threadRevisions[target.id] = threadRevision(facts);
  }
  return { authorization: controls.length || !commandsValid || !feedbackValid
    ? { valid: false, reason: controls.length ? "A stop or restart command is pending" : "Authorizing feedback changed or disappeared" } : authorization,
    head, baseSha: await api.branchSha(context.defaultBranch), threadRevisions,
    open: op.base.ref === context.defaultBranch && expectedBranch && subject.state === "open" && (!pr || pr.state === "open") };
}

async function observeLandings(api, ledger, key, prs, main, at, limit) {
  if (!limit) return [];
  const updates = [], proven = prs.filter((p) => p.state === "merged").map((p) => p.mergedSha), commits = new Map(), comparisons = new Map();
  const item = ledger.items[key], accepted = item.completionAcceptance;
  const commit = (sha) => { if (!commits.has(sha)) commits.set(sha, api.commit(sha)); return commits.get(sha); };
  let attempts = 0;
  for (const row of publishedPushes(ledger, key).reverse()) {
    const pr = prs.find((p) => p.number === row.number), old = row.effect.landing;
    if (!row.pr.required || pr?.state !== "merged" || old?.status === "landed" || landedCommits(ledger, key, proven).has(row.commit)
      || accepted?.revision === item.revision && row.op.generation <= accepted.generation
      || old?.nextAt && Date.parse(at) < Date.parse(old.nextAt) && main.sha !== row.commit || attempts >= limit && main.sha !== row.commit) continue;
    if (main.sha !== row.commit) attempts++;
    const checks = Math.min((old?.checks ?? 0) + 1, 1000000), common = { commit: row.commit, at, checks, firstAt: old?.firstAt ?? at };
    const targets = [{ source: "pr", number: pr.number, destination: pr.mergedSha }];
    if (main.sha !== pr.mergedSha) targets.push({ source: "main", ref: main.ref, destination: main.sha });
    let landing = main.sha === row.commit ? { ...common, source: "main", ref: main.ref, destination: main.sha, status: "landed", method: "commit" } : null, unavailable = false;
    for (const target of landing ? [] : targets) {
      if (!/^[a-f\d]{40}$/.test(target.destination)) { unavailable = true; continue; }
      if (target.destination === row.commit) { landing = { ...common, ...target, status: "landed", method: "commit" }; break; }
      const pair = `${row.commit}:${target.destination}`;
      try {
        if (!comparisons.has(pair)) comparisons.set(pair, api.compare(row.commit, target.destination));
        const found = await comparisons.get(pair);
        if (found.status === "ahead" && found.base_commit?.sha === row.commit && found.merge_base_commit?.sha === row.commit) {
          landing = { ...common, ...target, status: "landed", method: "ancestor" }; break;
        }
        if (!["ahead", "behind", "diverged", "identical"].includes(found.status) || found.base_commit?.sha !== row.commit) unavailable = true;
      } catch { unavailable = true; }
      try {
        const [published, merged] = await Promise.all([commit(row.commit), commit(target.destination)]);
        if (published.sha !== row.commit || merged.sha !== target.destination || !/^[a-f\d]{40}$/.test(published.tree?.sha)
          || !/^[a-f\d]{40}$/.test(merged.tree?.sha)) throw new Error("Incomplete commit-tree observation");
        if (published.tree.sha === merged.tree.sha) { landing = { ...common, ...target, status: "landed", method: "tree", tree: published.tree.sha }; break; }
      } catch { unavailable = true; }
    }
    if (landing) proven.push(row.commit);
    else landing = { ...common, status: "unknown", reason: unavailable ? "unavailable" : "unverified",
      nextAt: new Date(Date.parse(at) + Math.min(3600000, 60000 * 2 ** Math.min(checks - 1, 6))).toISOString() };
    updates.push({ operationId: row.operation, effectId: row.effect.id, landing });
  }
  return updates;
}

export async function observeItem({ api, actions, ledger, key, context, rules, now = () => new Date().toISOString(), landingLimit = 4 }) {
  if (!Number.isSafeInteger(landingLimit) || landingLimit < 0 || landingLimit > 4) throw new Error("Invalid landing observation bound");
  const item = ledger.items[key], op = ledger.operations[item.activeOperation];
  const [{ authorization, subject }, feedback] = await Promise.all([
    observeAuthorization(api, item, context), readFeedback(api, {
      issue: item.evidence.own ? null : Number(key.split(":")[1]), prs: item.prs.map((p) => p.number),
    }, context.config),
  ]);
  const required = requiredChecks(rules), prs = [];
  const cache = context.failureReads ?? new Map();
  let mainSha = context.sha, mainChecks;
  try {
    mainSha = await api.branchSha(context.defaultBranch);
    mainChecks = await baseChecks(api, mainSha, required, context, cache);
  } catch { mainChecks = { headSha: mainSha, state: "pending", failed: [], records: [], reason: "Default-branch CI could not be observed completely" }; }
  const spec = repairSpec(authorization, context.config);
  let repairBaseline = null;
  if (spec) {
    try {
      const ancestor = spec.baseSha === mainSha || ["ahead", "identical"].includes((await api.compare(spec.baseSha, mainSha)).status);
      if (ancestor) repairBaseline = { ancestor: true, checks: await baseChecks(api, spec.baseSha, required, context, cache) };
    } catch { /* A missing historical observation cannot register a repair. */ }
  }
  for (const record of item.prs) {
    const pr = await api.pull(record.number), state = pr.merged_at ? "merged" : pr.state;
    const head = pr.head?.sha;
    if (state !== "open") { prs.push({ number: pr.number, state, mergedSha: pr.merge_commit_sha, headSha: head }); continue; }
    if (pr.head?.repo?.full_name?.toLowerCase() !== context.repo.toLowerCase() || pr.base.ref !== context.defaultBranch) {
      prs.push({ number: pr.number, state, headSha: head, baseRef: pr.base.ref, unsupported: true });
      continue;
    }
    const base = await api.branchSha(pr.base.ref);
    const [status, tested, comparison] = await Promise.all([api.pullStatus(pr.number), prChecks(api, pr, base), api.compare(base, head)]);
    const fresh = status?.headRefOid === head && status?.baseRefOid === base;
    const { signals, feedback: findings } = checkFeedback(tested, context.config, pr);
    const pending = signals.records.filter((r, i) => context.config.signals[i].blocking && r.state !== "success").map((r) => r.name);
    const prFeedback = [...feedback.filter((f) => f.target === pr.number), ...findings];
    const diagnosed = await diagnosticChecks(api, tested, required, context, "pr", head);
    let baseline;
    try { baseline = pr.base.ref === context.defaultBranch ? await baseChecks(api, base, required, context, cache) : null; }
    catch { baseline = null; }
    for (const bot of context.config.reviewBots) if (!prFeedback.some((f) => f.authority === "signal" && f.sourceId.startsWith("review:")
      && f.author === bot && f.head === head)) pending.push(`review:${bot}`);
    const apiReruns = [];
    for (const effect of Object.values(item.apiEffects ?? {}).filter((e) => e.definition.kind === "ci-rerun"
      && e.definition.target === pr.number && e.definition.payload.head === head && e.status !== "superseded")) {
      const run = await api.run(effect.definition.payload.runId);
      if (String(run.id) !== effect.definition.payload.runId || run.head_sha !== effect.definition.payload.runHead
        || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
        || !["queued", "in_progress", "completed", "waiting", "pending", "requested"].includes(run.status)) throw new Error("CI rerun status is not a complete observation of its recorded run");
      apiReruns.push({ effectId: effect.id, effectStatus: effect.status, requestedAttempt: effect.definition.payload.attempt,
        attempt: run.run_attempt, status: run.status, requests: effect.requests.length, createdAt: effect.createdAt, nextAt: effect.nextAt });
    }
    prs.push({ number: pr.number, state, draft: pr.draft, branch: pr.head.ref, headSha: head, baseRef: pr.base.ref, baseSha: base,
      mergeable: fresh ? status.mergeable : "UNKNOWN", behind: comparison.behind_by > 0, autoMerge: Boolean(status?.autoMergeRequest),
      approvalRequired: status?.reviewDecision !== "APPROVED", checks: attributeFailures(diagnosed, baseline, base),
      signals: { pending }, feedback: prFeedback, apiReruns,
      reruns: (record.reruns?.filter((r) => r.head === head).length ?? 0) + apiReruns.filter((r) => r.requests > 0 || r.effectStatus === "applied").length,
      unsupported: pr.head?.repo?.full_name?.toLowerCase() !== context.repo.toLowerCase() || pr.base.ref !== context.defaultBranch });
  }
  try {
    const current = await api.branchSha(context.defaultBranch);
    if (current !== mainSha) { mainSha = current; mainChecks = { headSha: current, state: "pending", failed: [], records: [], reason: "The default branch moved during observation" }; }
  } catch { mainChecks = { headSha: mainSha, state: "pending", failed: [], records: [], reason: "The default branch could not be reobserved" }; }
  let result = {}, owner = null;
  if (op?.owner && ["claimed", "result-ready", "publishing"].includes(op.phase)) {
    result = await actions.inspect(op, context); owner = result.owner;
  }
  const main = { ref: context.defaultBranch, sha: mainSha, checks: mainChecks };
  const landings = await observeLandings(api, ledger, key, prs, main, now(), landingLimit);
  return { authorization, issueState: subject.state, feedback, prs, owner, result, landings,
    main, repairSpec: spec, repairBaseline, unsupportedStack: prs.some((p) => p.unsupported) };
}
