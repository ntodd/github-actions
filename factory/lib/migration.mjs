// Explicit legacy cutover in the clean controller job. Planning reads only;
// importing records ownership and history, never dispatches or publishes work.
import { createHash } from "node:crypto";
import { admit, evolve, validateLedger, recordFactoryApp, revisionOf, validBranch, TERMINAL } from "./protocol.mjs";
import { authorizeIssue, inspectOwnPr, classifyText, readFeedback } from "./admission.mjs";
import { ingestCommands } from "./commands.mjs";
import { loadConfig, withFactoryApp } from "./config.mjs";
import { factoryReadApi } from "./identity.mjs";
import { verifyEntry } from "./entry.mjs";
import { assertRuntimeIsolation } from "./runtime-guard.mjs";
const sha = (value) => typeof value === "string" && /^[a-f\d]{40}$/.test(value);
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keyOf = (item) => item.issue ? `issue:${item.issue}` : `pr:${item.pr}`;

export function migrationItems(value = []) {
  if (!Array.isArray(value) || value.length > 25) throw new Error("Migration needs at most 25 explicit work-item mappings");
  const keys = new Set(), prs = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((k) => !["issue", "pr", "prs", "source", "disposition", "reason"].includes(k))
      || !positive(item.issue ?? item.pr) || (item.issue !== undefined) === (item.pr !== undefined)
      || item.pr !== undefined && item.prs !== undefined
      || item.source !== undefined && (typeof item.source !== "string" || !/^(label|issue-comment|review-comment):[1-9]\d*$/.test(item.source))
      || !["continue", "question", "stop"].includes(item.disposition ?? "question")
      || item.reason !== undefined && (typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 2000)) throw new Error("Invalid migration mapping or disposition");
    const numbers = item.pr ? [item.pr] : item.prs ?? [];
    if (!Array.isArray(numbers) || numbers.length > 25 || numbers.some((n) => !positive(n) || prs.has(n) || (prs.add(n), false))) throw new Error("Migration PR membership must be explicit, positive and unique");
    const key = keyOf(item);
    if (keys.has(key) || item.issue && !numbers.length && item.disposition === "continue") throw new Error("A migration without PRs needs a question or stop; do not admit a replacement build");
    keys.add(key);
    return { ...(item.issue ? { issue: item.issue, prs: [...numbers].sort((a, b) => a - b) } : { pr: item.pr }),
      ...(item.source ? { source: item.source } : {}), disposition: item.disposition ?? "question", ...(item.reason ? { reason: item.reason } : {}) };
  }).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

export function validateMigrationRequest(request) {
  if (request?.kind !== "migrate" || Object.keys(request).some((k) => !["kind", "apply", "digest", "items"].includes(k))
    || request.apply !== undefined && typeof request.apply !== "boolean"
    || request.apply === true && (typeof request.digest !== "string" || !/^[a-f\d]{64}$/.test(request.digest) || !request.items?.length)
    || request.apply !== true && request.digest !== undefined) throw new Error("Migration needs an explicit mapping and reviewed digest to apply");
  migrationItems(request.items);
  return request;
}

export async function verifyMigrationEntry({ api, env, context }) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !context.config.trustedUsers.includes(env.GITHUB_ACTOR?.toLowerCase())
    || env.GITHUB_ACTOR !== env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR?.toLowerCase() === context.config.factoryAppLogin) throw new Error("Migration requires a trusted human's manual default-branch request");
  const repository = await api.repository();
  if (String(repository.id) !== context.repositoryId || repository.full_name?.toLowerCase() !== env.GITHUB_REPOSITORY?.toLowerCase()
    || repository.default_branch !== context.defaultBranch) throw new Error("Migration repository identity or default branch changed");
  const run = await verifyEntry({ api, env, context });
  if (run.event !== "workflow_dispatch" || run.actor?.type !== "User" || run.triggering_actor?.type !== "User"
    || run.actor.login !== env.GITHUB_ACTOR || run.triggering_actor.login !== env.GITHUB_TRIGGERING_ACTOR
    || env.GITHUB_REF !== `refs/heads/${context.defaultBranch}` || context.sha !== env.GITHUB_SHA
    || await api.branchSha(context.defaultBranch) !== context.sha || !sha(env.FACTORY_TOOLING_SHA)
    || env.FACTORY_TOOLING_REPOSITORY !== "ntodd/github-actions") throw new Error("Migration run, actor, current default branch or shared tooling is not verified");
  return { actor: run.actor.login.toLowerCase(), run: { id: String(run.id), attempt: run.run_attempt }, toolingSha: env.FACTORY_TOOLING_SHA };
}

async function issueAdmission(api, number, config, source) {
  const [issue, editors, events, comments] = await Promise.all([api.issue(number), api.editors(number, "issue"), api.events(number), api.comments(number)]);
  if (issue?.number !== number || !Array.isArray(events) || !Array.isArray(comments)) throw new Error(`Issue #${number} admission identity or history is incomplete`);
  const candidates = source ? [source] : [
    ...events.filter((e) => e.event === "labeled" && (e.label?.name ?? e.label) === "agent-ready").toReversed().map((e) => `label:${e.id}`),
    ...comments.toReversed().filter((c) => ["build", "restart"].includes(classifyText(c, "issue-comment", config, { target: number }).command?.action)).map((c) => `issue-comment:${c.id}`),
  ];
  for (const sourceId of candidates) {
    const authorization = authorizeIssue({ issue, editors, events, comments, config, evidence: { sourceId }, allowClosed: true });
    if (authorization.valid) return { ...authorization, issue };
  }
  throw new Error(`Issue #${number} has no valid original admission source; restore trusted authorship/edits or select its source explicitly`);
}

const inventoryRow = (row) => ({ number: row.number, state: row.state, title: row.title,
  author: row.user?.login?.toLowerCase(), revision: revisionOf(row), labels: (row.labels ?? []).map((l) => l.name ?? l).sort(),
  ...(row.head ? { head: row.head.sha, branch: row.head.ref, repository: row.head.repo?.full_name, base: row.base?.ref } : {}) });

export async function planMigration({ api, state, context, toolingSha, items = [] }) {
  validateLedger(state);
  if (!state.factoryApp || state.repositoryId !== context.repositoryId || !sha(toolingSha)) throw new Error("Migration requires verified factory state and immutable shared tooling");
  items = migrationItems(items);
  api = factoryReadApi(api, state.factoryApp.login);
  context = { ...context, config: withFactoryApp(context.config, state.factoryApp.login) };
  const [issues, pulls] = await Promise.all([api.openIssues(), api.openPulls()]);
  if (!Array.isArray(issues) || !Array.isArray(pulls) || issues.length > 10000 || pulls.length > 10000
    || [...issues, ...pulls].some((r) => !positive(r.number)) || new Set([...issues, ...pulls].map((r) => r.number)).size !== issues.length + pulls.length) throw new Error("Migration inventory is incomplete or exceeds its bound");
  const inventory = { issues: issues.map(inventoryRow).sort((a, b) => a.number - b.number),
    prs: pulls.map(inventoryRow).sort((a, b) => a.number - b.number) };
  const selected = [];
  for (const choice of items) {
    const key = keyOf(choice);
    if (state.items[key]) throw new Error(`${key} already has factory history; migration cannot replace it`);
    let accepted;
    if (choice.issue) accepted = await issueAdmission(api, choice.issue, context.config, choice.source);
    else {
      const found = await inspectOwnPr(api, choice.pr, { ...context, repo: context.repo }, { includeRequests: true });
      for (const fact of found.requests.toReversed()) {
        if (choice.source && fact.sourceId !== choice.source || !["resolve", "update"].includes(fact.command?.action)) continue;
        const auth = await inspectOwnPr(api, choice.pr, context, { commandId: fact.sourceId });
        if (auth.valid) { accepted = auth; break; }
      }
      if (!accepted) throw new Error(`PR #${choice.pr} needs its original trusted update/resolve command before migration`);
      if (accepted.pr?.number !== choice.pr) throw new Error(`PR #${choice.pr} admission identity changed`);
    }
    const prs = [], snapshots = [];
    for (const number of choice.issue ? choice.prs : [choice.pr]) {
      if (Object.values(state.items).some((i) => i.prs.some((p) => p.number === number))) throw new Error(`PR #${number} already belongs to factory work`);
      const pr = await api.pull(number);
      if (pr.number !== number || !["open", "closed"].includes(pr.state) || !sha(pr.head?.sha) || !sha(pr.base?.sha)
        || !validBranch(pr.head?.ref) || !validBranch(pr.base?.ref) || pr.head?.repo?.full_name?.toLowerCase() !== context.repo.toLowerCase()
        || pr.head.ref === "factory-state" || pr.head.ref === context.defaultBranch
        || choice.issue && pr.user?.login?.toLowerCase() !== state.factoryApp.login
        || pr.base.ref !== context.defaultBranch || pr.merged_at && !sha(pr.merge_commit_sha)) throw new Error(`PR #${number} is not verified same-repository legacy work into the current default branch; retarget unsupported work before import`);
      const closes = choice.issue ? await api.closingIssues(number, pr.head.sha) : [];
      if (!Array.isArray(closes) || closes.some((i) => i.number !== choice.issue || i.repository?.toLowerCase() !== context.repo.toLowerCase())) throw new Error(`PR #${number} would close work outside issue #${choice.issue}; correct its legacy references before migration`);
      prs.push({ number, required: true, state: pr.merged_at ? "merged" : pr.state, mergedSha: pr.merged_at ? pr.merge_commit_sha : null, acceptedClosure: false });
      snapshots.push({ number, head: pr.head.sha, branch: pr.head.ref, base: pr.base.ref, baseSha: pr.base.sha,
        contentRevision: revisionOf(pr), state: pr.merged_at ? "merged" : pr.state, mergedSha: pr.merged_at ? pr.merge_commit_sha : null });
    }
    const feedback = await readFeedback(api, { issue: choice.issue ?? null, prs: prs.map((p) => p.number) }, context.config);
    const proof = feedback.find((f) => f.sourceId === accepted.evidence.sourceId);
    // Producer labels are authenticated by admission, not trusted-human commands.
    if ((!proof && !(accepted.producer && accepted.evidence.kind === "label" && accepted.evidence.actor === "github-actions[bot]"))
      || proof && (proof.authority !== "instruction" || proof.revision !== accepted.evidence.revision)) throw new Error(`The original source for ${key} changed during migration planning`);
    const labels = (accepted.issue ?? accepted.pr).labels ?? [];
    const blocked = labels.some((l) => ["agent-blocked", "agent-conflict", "agent-working"].includes(l.name ?? l));
    const unsupported = snapshots.some((p) => p.base !== context.defaultBranch) || snapshots.filter((p) => p.state === "open").length > 1;
    const disposition = choice.disposition === "continue" && unsupported ? "question" : choice.disposition;
    const reason = choice.reason ?? (unsupported ? `Legacy PRs ${snapshots.map((p) => `#${p.number}`).join(", ")} need explicit stack/base handling before work resumes.`
      : disposition === "continue" ? "Existing PR membership was explicitly accepted for reconciliation. Migration started no worker or replacement build."
      : blocked ? "Legacy work was blocked or interrupted. Its label does not establish whether it needs a decision or a retry; clarify before continuing the recorded PRs."
        : choice.pr ? "Legacy maintenance is recorded. Request a fresh /agent update or /agent resolve if more work is needed."
          : "Legacy work is recorded without starting a replacement build. Confirm the next action on the existing work.");
    selected.push({ key, revision: accepted.revision, evidence: { ...accepted.evidence, ...(accepted.producer ? { producer: accepted.producer } : {}) },
      prs, snapshots, disposition, reason, legacyCommands: feedback.filter((f) => f.authority === "instruction" && f.command)
        .map((f) => ({ sourceId: f.sourceId, revision: f.revision, author: f.author, at: f.createdAt, action: f.command.action })),
      conversation: hash(feedback.map((f) => [f.sourceId, f.revision, f.authority, f.command?.action ?? null])), feedback });
  }
  const digest = hash({ repositoryId: state.repositoryId, configSha: context.sha, toolingSha, defaultBranch: context.defaultBranch,
    factoryApp: state.factoryApp, state: hash(state), inventory, selected: selected.map(({ feedback, ...row }) => row), items });
  const known = new Set(Object.values(state.items).flatMap((i) => i.prs.map((p) => p.number)));
  const proposed = new Set(selected.flatMap((i) => i.prs.map((p) => p.number)));
  return { schemaVersion: 1, repositoryId: state.repositoryId, configSha: context.sha, toolingSha, defaultBranch: context.defaultBranch, digest,
    selection: hash(items), stateDigest: hash(state), inventory, selected,
    historyPolicy: "Observed legacy commands are retained as history, not replayed as new requests. Legacy model cost and Crew minutes remain unmeasured.",
    unmapped: pulls.filter((p) => p.user?.login?.toLowerCase() === state.factoryApp.login && !known.has(p.number) && !proposed.has(p.number)).map((p) => p.number).sort((a, b) => a - b),
    applyRequest: items.length ? { kind: "migrate", apply: true, digest, items } : null };
}

export async function runMigration({ api, store, env, context, request, activeApp, now = () => new Date().toISOString(), assertRuntime = () => assertRuntimeIsolation(api) }) {
  validateMigrationRequest(request);
  const operator = await verifyMigrationEntry({ api, env, context }), items = migrationItems(request.items);
  const { state } = await store.load(), selection = hash(items);
  if (!state.factoryApp || state.repositoryId !== context.repositoryId) throw new Error("Initialize verified factory state before migration");
  if (request.apply) recordFactoryApp(state, activeApp);
  const imported = (s) => items.length && items.every((i) => s.items[keyOf(i)]?.migration?.plan === request.digest
    && s.items[keyOf(i)].migration.selection === selection);
  if (request.apply && imported(state)) return { status: "already-imported", digest: request.digest, items: items.map(keyOf) };
  const plan = await planMigration({ api, state, context, toolingSha: operator.toolingSha, items });
  if (!request.apply) return { status: "planned", ...plan, selected: plan.selected.map(({ feedback, ...row }) => row) };
  if (!items.length || request.digest !== plan.digest || JSON.stringify(plan.applyRequest).length > 4096) throw new Error("Migration plan changed or is not bounded; review a fresh plan before importing");
  await assertRuntime();
  // A changing config or source must not be accepted merely because it appeared
  // in an earlier report. Recompute immediately before the one ledger write.
  const latest = { ...await loadConfig(api), repo: context.repo };
  const fresh = await planMigration({ api, state, context: latest, toolingSha: operator.toolingSha, items });
  if (fresh.digest !== plan.digest) throw new Error("Migration facts changed before import; review a fresh plan");
  await assertRuntime();
  const at = now();
  await store.transact((current) => {
    if (imported(current)) return current;
    recordFactoryApp(current, activeApp);
    if (hash(current) !== plan.stateDigest || Object.values(current.operations).some((op) => !TERMINAL.has(op.phase))
      || Object.values(current.items).some((i) => Object.values(i.apiEffects ?? {}).some((e) => e.status === "pending"))) throw new Error("Factory history changed or has unfinished effects; settle it before migration");
    let next = current;
    for (const row of plan.selected) {
      next = admit(next, { ...row, evidence: row.evidence, prs: row.prs });
      next = ingestCommands(next, row.key, row.feedback);
      const item = next.items[row.key];
      // The reviewed cutover explicitly retains these source IDs as legacy
      // history. It never replays old work commands as new factory requests.
      for (const command of Object.values(item.commands)) { command.status = "superseded"; command.acknowledgement = "done"; command.legacyMigration = plan.digest; command.clarification = "Recorded as legacy history during explicit migration; post a fresh command for new work."; }
      item.migration = { actor: operator.actor, run: operator.run, toolingSha: operator.toolingSha, configSha: plan.configSha,
        plan: plan.digest, selection, at, disposition: row.disposition, conversation: row.conversation, prs: row.snapshots,
        admission: { sourceId: row.evidence.sourceId, revision: row.evidence.revision } };
      if (item.evidence.own) item.maintenanceComplete = true;
      if (row.disposition === "stop") next = evolve(next, row.key, { type: "stop", at });
      else if (row.disposition === "question") next = evolve(next, row.key, { type: "ask", reason: row.reason, at });
      next = evolve(next, row.key, { type: "set-status", status: { state: row.disposition === "stop" ? "agent-stopped" : row.disposition === "question" ? "agent-needs-you" : "agent-review",
        reason: row.reason, next: row.disposition === "stop" ? "work-command" : row.disposition === "question" ? "answer" : "none", wait: null } });
    }
    return validateLedger(next);
  });
  return { status: "imported", digest: plan.digest, items: items.map(keyOf), unmapped: plan.unmapped };
}
