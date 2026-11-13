// A bounded controller pass. Run only in a trusted clean Actions job holding
// factory-control. All API facts are reread; dispatch inputs are discovery hints.
import { randomUUID } from "node:crypto";
import { admit, evolve, validateLedger } from "./protocol.mjs";
import { inspectIssue, inspectOwnPr, classifyText, readFeedback } from "./admission.mjs";
import { threadTargets } from "./threads.mjs";
import { ingestCommands, revalidateCommands, applyControls, resolveRoute, requestRoute } from "./commands.mjs";
import { loadConfig, withFactoryApp, parseConfig } from "./config.mjs";
import { factoryReadApi } from "./identity.mjs";
import { observeItem, observeAuthorization, publishObservation } from "./observe.mjs";
import { decideRepository } from "./reconcile.mjs";
import { runProvenance } from "./actions.mjs";
import { failureContext } from "./failure-report.mjs";
import { mainRepairRole } from "./main-repair.mjs";
import { collectUsage } from "./accounting.mjs";
import { validateMigrationRequest } from "./migration.mjs";

export function parseRequest(value) {
  if (!value) return { kind: "reconcile" };
  if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid dispatch request");
  const request = JSON.parse(value);
  if (request?.kind === "migrate") return validateMigrationRequest(request);
  if (!request || !["reconcile", "worker", "inspect"].includes(request.kind) || Object.keys(request).some((k) => !["kind", "target", "item", "operation"].includes(k))
    || request.kind === "inspect" && Object.keys(request).length !== 1
    || request.target !== undefined && (!Number.isSafeInteger(request.target) || request.target < 1)
    || request.kind === "worker" && (!/^(issue|pr):[1-9]\d*$/.test(request.item) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(request.operation))) throw new Error("Invalid dispatch request");
  return request;
}

export async function discover({ api, store, context, target = null }) {
  const [issues, prs] = await Promise.all([api.openIssues(), api.openPulls()]);
  const candidates = new Map([...issues, ...prs].map((s) => [s.number, s]));
  if (target && !candidates.has(target)) {
    const issue = await api.issue(target);
    candidates.set(target, issue.pull_request ? await api.pull(target) : issue);
  }
  const errors = [];
  for (const [number, subject] of candidates) {
    try {
      const { state } = await store.load();
      if (Object.values(state.items).some((i) => i.key === `issue:${number}` || i.key === `pr:${number}` || i.prs.some((p) => p.number === number))) continue;
      const own = Boolean(subject.head || subject.pull_request);
      const author = subject.user?.login?.toLowerCase();
      if (!context.config.trustedUsers.includes(author) && (own || author !== "github-actions[bot]")) continue;
      let accepted;
      if (own) {
        const found = await inspectOwnPr(api, number, context, { includeRequests: true });
        for (const fact of found.requests) {
          if (!fact.command) continue;
          const auth = await inspectOwnPr(api, number, context, { commandId: fact.sourceId, allowRequest: true });
          if (auth.valid || auth.requestValid) { accepted = { key: `pr:${number}`, ...auth, requestOnly: auth.requestValid === true,
            prs: [{ number, required: true, state: "open", mergedSha: null, acceptedClosure: false }] }; break; }
        }
      } else {
        let auth = await inspectIssue(api, number, context.config);
        if (!auth.valid) for (const comment of auth.comments) {
          const fact = classifyText(comment, "issue-comment", context.config, { target: number });
          if (!fact.command) continue;
          auth = await inspectIssue(api, number, context.config, { commandId: fact.sourceId, allowRequest: true });
          if (auth.valid || auth.requestValid) break;
        }
        if (auth.valid || auth.requestValid) accepted = { key: `issue:${number}`, ...auth, requestOnly: auth.requestValid === true,
          evidence: { ...auth.evidence, producer: auth.producer ?? null } };
      }
      if (accepted) await store.transact((s) => admit(s, accepted));
    } catch (error) { errors.push({ target: number, reason: error.message }); }
  }
  return { errors };
}

export async function claimOperation({ api, store, repo, itemKey, operationId, run, context }) {
  const { state } = await store.load(), item = state.items[itemKey], op = state.operations[operationId];
  if (!item || item.activeOperation !== operationId || op?.phase !== "prepared") return { claimed: false };
  api = factoryReadApi(api, state.factoryApp?.login);
  context = { ...context, config: withFactoryApp(context.config, state.factoryApp?.login) };
  const actual = await api.run(run.id, run.attempt);
  const owner = runProvenance(actual, { ...op, owner: run }, state.repositoryId, context.defaultBranch);
  if (owner.status !== "in_progress") return { claimed: false };
  const provenance = { repositoryId: state.repositoryId, workflowPath: actual.path, headSha: actual.head_sha };
  const observation = await publishObservation(api, item, op, repo);
  if (context.sha !== op.worker.entrySha || op.base.ref !== context.defaultBranch || observation.open !== true
    || !observation.authorization.valid) return { claimed: false };
  const result = await store.transact((s) => evolve(s, itemKey, { type: "claim", operationId, run, provenance, observation }));
  const current = result.state.operations[operationId];
  return { claimed: current.owner?.id === run.id && current.owner.attempt === run.attempt,
    operation: current, config: context.config };
}

export async function runController({ api, write, store, actions, repo, toolingSha, run,
  target = null, publish, route, restart, continueIssue, surfaces = null, render = async () => {}, now = () => new Date().toISOString(),
  operationId = () => `op-${randomUUID()}`, observe = observeItem, discovery = true, dryRun = false, maxPasses = 4,
  assertRuntime = async () => {} }) {
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 8) throw new Error("Invalid controller pass bound");
  if (!dryRun) await assertRuntime();
  const { state: original } = await store.load();
  api = factoryReadApi(api, original.factoryApp?.login);
  const context = { ...await loadConfig(api), repo, failureReads: new Map() };
  if (original.repositoryId !== context.repositoryId || !/^[a-f0-9]{40}$/.test(toolingSha)) throw new Error("Controller repository/tooling identity mismatch");
  // Read-only reports discover into memory. They show initial requests and
  // prospective admissions without mutating the ledger or calling the router.
  let planned = structuredClone(original);
  const planningStore = { load: async () => ({ state: structuredClone(planned) }), transact: async (mutate) => {
    planned = validateLedger(await mutate(structuredClone(planned))); return { state: structuredClone(planned) };
  } };
  let discoveryErrors = [];
  if (discovery) {
    try { discoveryErrors = (await discover({ api, store: dryRun ? planningStore : store, context, target })).errors; }
    catch (error) { discoveryErrors = [{ reason: error.message }]; }
  }
  let rules;
  try { rules = await api.branchRules(context.defaultBranch); }
  catch { rules = null; } // A rules API outage cannot swallow a trusted stop.
  const snapshot = dryRun ? planned : (await store.load()).state;
  const observations = {};
  for (const key of Object.keys(snapshot.items)) {
    try { observations[key] = await observe({ api, actions, ledger: snapshot, key, context, rules, now }); }
    catch (error) {
      observations[key] = { authorization: null, feedback: [], prs: [], main: { ref: context.defaultBranch }, observationError: error.message };
      try {
        observations[key].feedback = await readFeedback(api, { issue: snapshot.items[key].evidence.own ? null : Number(key.split(":")[1]),
          prs: snapshot.items[key].prs.map((p) => p.number) }, context.config);
        observations[key].feedbackComplete = true;
      } catch { /* An incomplete conversation is never evidence of deletion. */ }
    }
  }
  let plans;
  const decide = (s) => {
    for (const [key, facts] of Object.entries(observations)) {
      if (!s.items[key]) continue;
      if (!s.items[key].requestOnly && facts.authorization?.valid === false && !facts.observationError) {
        s = evolve(s, key, { type: "revoke-admission", authorization: facts.authorization });
      }
      if (!facts.observationError || facts.feedbackComplete) s = revalidateCommands(ingestCommands(s, key, facts.feedback ?? []), key, facts.feedback ?? []);
      s = applyControls(s, key, { now: now() });
    }
    const result = decideRepository(s, observations, context.config, { now: now() });
    plans = result.plans;
    return result.state;
  };
  if (dryRun) { decide(structuredClone(snapshot)); return { dryRun: true, plans, ...(discoveryErrors.length ? { discoveryErrors } : {}),
    admissions: Object.values(snapshot.items).filter((i) => !original.items[i.key])
      .map((i) => ({ key: i.key, requestOnly: i.requestOnly === true, sourceId: i.evidence.sourceId })) }; }
  await store.transact(decide);
  const outcomes = [];
  outcomes.push(...discoveryErrors.map((error) => ({ action: "discover", status: "interrupted", ...error })));
  // Acknowledge commands before work; project repository status once after
  // immediate transitions so metadata refreshes cannot consume dispatch time.
  if (surfaces) {
    outcomes.push(...await surfaces.acknowledge());
  }
  const save = (key, event) => store.transact((s) => evolve(s, key, { at: now(), ...event }));
  for (const { key, action } of plans) {
    if (!action) continue;
    let { state } = await store.load(), item = state.items[key], op = state.operations[item.activeOperation];
    try {
      await assertRuntime();
      switch (action.type) {
        case "admit-request": {
          const command = item.commands[action.commandId], latest = { ...await loadConfig(api), repo };
          const evidence = command.routed ? { kind: "routed-command", action: command.action, sourceId: command.sourceId,
            revision: command.revision } : item.authorizationRevoked ? { sourceId: command.sourceId, revision: command.revision } : null;
          const number = Number(key.split(":")[1]);
          const auth = item.evidence.own
            ? await inspectOwnPr(api, number, latest, { commandId: command.sourceId, evidence, allowClosed: Boolean(item.authorizationRevoked) })
            : await inspectIssue(api, number, latest.config, { commandId: command.sourceId, evidence, allowClosed: Boolean(item.authorizationRevoked) });
          if (auth.valid) await save(key, { type: "admit-request", commandId: command.id, authorization: auth });
          else await save(key, { type: "ask", reason: auth.reason ?? "This request does not authorize work", consumeCommand: command.id,
            ...(item.authorizationRevoked ? { kind: "authorization" } : {}) });
          break;
        }
        case "reserve": {
          if (surfaces && action.commandIds.some((id) => item.commands[id]?.acknowledgement !== "done")) {
            outcomes.push({ key, action: action.type, status: "waiting", reason: "Recover the command acknowledgement before starting its worker" });
            continue;
          }
          // Fresh reads immediately before reservation. Publishing will check
          // them again; a head change never permits overwriting someone else.
          const latest = { ...await loadConfig(api), repo };
          const fresh = await observe({ api, actions, ledger: state, key, context: latest, rules, now, landingLimit: 0 });
          if (!fresh.authorization.valid || fresh.authorization.revision !== item.revision) break;
          const pr = action.pr ? fresh.prs.find((p) => p.number === action.pr && p.state === "open") : null;
          if (action.pr && !pr) break;
          if (pr && (pr.unsupported || pr.baseRef !== latest.defaultBranch)) break;
          if (fresh.main) fresh.main.repairWork = mainRepairRole(item, fresh);
          const id = operationId(), branch = pr?.branch ?? `factory/issue-${key.split(":")[1]}-${id}`;
          const base = { ref: pr?.baseRef ?? latest.defaultBranch, sha: pr?.baseSha ?? latest.sha };
          ({ state } = await save(key, { type: "reserve", id, mode: action.mode, revision: item.revision,
            target: { number: pr?.number ?? null, branch, head: pr?.headSha ?? null }, base,
            toolingSha, configSha: latest.sha, automatic: action.automatic, commandIds: action.commandIds,
            runner: latest.config.runner, model: latest.config.worker.model,
            failureContext: failureContext(fresh, pr?.number ?? null),
            threadTargets: item.evidence.own ? [] : threadTargets(pr?.feedback ?? [], pr?.number),
            feedbackInputs: action.feedbackInputs, limit: action.mode === "update" ? 30 : context.config.budget.automaticAttemptsPerItemPerDay }));
          op = state.operations[id];
          // Dispatch is itself reserved before sending. A timeout spends a
          // request, never allocates another operation or coding attempt.
          const dispatched = await save(key, { type: "dispatch-request", operationId: id });
          const delivery = await write.dispatch("factory.yml", latest.defaultBranch, { kind: "worker", item: key, operation: id });
          if (delivery?.id) await save(key, { type: "dispatch-accepted", operationId: id, request: 1, run: delivery,
            deadline: new Date(Date.parse(dispatched.state.operations[id].createdAt) + latest.config.timeouts.queuedMinutes * 60000).toISOString() });
          break;
        }
        case "dispatch": {
          const observation = await publishObservation(api, item, op, repo);
          if (!observation.authorization.valid) break;
          const dispatched = await save(key, { type: "dispatch-request", operationId: op.id });
          const request = dispatched.state.operations[op.id].dispatch.attempts.length;
          const delivery = await write.dispatch("factory.yml", context.defaultBranch, { kind: "worker", item: key, operation: op.id });
          if (delivery?.id) await save(key, { type: "dispatch-accepted", operationId: op.id, request, run: delivery,
            deadline: new Date(Date.parse(dispatched.state.operations[op.id].createdAt) + context.config.timeouts.queuedMinutes * 60000).toISOString() });
          break;
        }
        case "cancel-owner":
          await save(key, { type: "cancel-request", operationId: op.id });
          await write.cancelRun(op.owner.id);
          break;
        case "collect-result": {
          let result;
          try {
            result = await actions.download(op, context);
            const assigned = parseConfig((await api.fileAt(".github/factory.yml", op.configSha)).content);
            // This job never receives project secret values. Keep free-form
            // worker questions in the redacted artifact rather than the ledger.
            const secretNames = [...assigned.environment.workerSecrets, ...assigned.environment.setupSecrets];
            if (secretNames.length) {
              // A declared name is public config. Reconstruct this fixed
              // diagnostic; arbitrary suffixes and undeclared names stay out.
              const missing = secretNames.find((name) => result.proposal.reason === `Required project secret is missing from SETUP_SECRETS: ${name}`);
              result.proposal = { ...result.proposal, reason: missing ? `Required project secret is missing from SETUP_SECRETS: ${missing}`
                : `Worker outcome: ${["ready", "needs-you", "no-change", "failed"].includes(result.proposal.outcome) ? result.proposal.outcome : "invalid"}. Read the redacted result report from worker run ${op.owner.id}.` };
            }
            const feedback = result.proposal.replies?.length ? await readFeedback(api, { issue: null, prs: [op.target.number] }, (await loadConfig(api)).config) : [];
            await save(key, { type: "collect-result", operationId: op.id, artifact: result.artifact, proposal: result.proposal, feedback });
          } catch (error) {
            if (error.code !== "invalid-result") throw error;
            await save(key, { type: "recover-worker", operationId: op.id, resultAbsent: true, reason: "Worker result failed validation" });
          } finally { result?.dispose(); }
          break;
        }
        case "recover-worker": {
          // An observation timeout throws rather than becoming resultAbsent.
          const result = await actions.inspect(op, context);
          if (!result.inspected || result.available) break;
          await save(key, { type: "recover-worker", operationId: op.id, resultAbsent: true });
          break;
        }
        case "supersede":
          await save(key, { type: "supersede", operationId: op.id, observation: await publishObservation(api, item, op, repo) });
          break;
        case "result-unavailable": {
          const result = await actions.inspect(op, context);
          if (!result.inspected || result.available) break;
          await save(key, { type: "result-unavailable", operationId: op.id, confirmed: true });
          break;
        }
        case "publish": {
          if (!publish) throw new Error("The clean publisher adapter is required");
          const result = await publish({ key, operationId: op.id, context, run });
          if (result?.status === "waiting") {
            outcomes.push({ key, action: action.type, status: "waiting", reason: result.reason,
              ...(result.error ? { error: result.error.message } : {}) });
            continue;
          }
          break;
        }
        case "handover": {
          const pr = await api.pull(action.pr);
          if (pr.state !== "open" || pr.head.sha !== action.head) {
            outcomes.push({ key, action: action.type, status: "waiting", reason: "The PR state or head changed after planning; reobserve before handover" });
            continue;
          }
          const handed = !surfaces || (await surfaces.handover({ key, number: action.pr, head: pr.head.sha, context })).status === "applied";
          if (handed && pr.state === "open") await save(key, { type: "hand-over", number: pr.number, head: pr.head.sha });
          break;
        }
        case "ready-for-bots": {
          if (!surfaces) throw new Error("The ready-for-review adapter is required");
          const pr = await api.pull(action.pr);
          if (pr.state !== "open" || pr.head.sha !== action.head) {
            outcomes.push({ key, action: action.type, status: "waiting", reason: "The PR state or head changed after planning; reobserve before requesting review bots" });
            continue;
          }
          await surfaces.handover({ key, number: action.pr, head: pr.head.sha, context, readyOnly: true });
          break;
        }
        case "close-out": {
          if (item.evidence.own || !item.complete) break;
          if (surfaces) { await surfaces.closeOut({ key, context }); break; }
          const latest = { ...await loadConfig(api), repo };
          const fresh = await observeAuthorization(api, item, latest);
          if (fresh.subject.state === "open" && fresh.authorization.valid && fresh.authorization.revision === item.revision) {
            await write.closeIssue(Number(key.split(":")[1]));
          }
          break;
        }
        case "route": {
          if (!route) throw new Error("The mention router adapter is required");
          const latest = { ...await loadConfig(api), repo };
          // Routing a control request must not depend on CI/mergeability APIs
          // being available. Only the complete trusted conversation is needed;
          // coding will reobserve all facts after admission.
          const fresh = { ...observations[key], feedback: await readFeedback(api, {
            issue: item.evidence.own ? null : Number(key.split(":")[1]), prs: item.prs.map((p) => p.number),
          }, latest.config) };
          ({ state } = await store.transact((s) => revalidateCommands(s, key, fresh.feedback ?? [])));
          item = state.items[key];
          const command = item.commands[action.commandId];
          if (command?.status !== "queued" || command.action !== "route") break;
          if (!(fresh.feedback ?? []).some((f) => f.sourceId === command.sourceId && f.revision === command.revision
            && f.authority === "instruction" && f.command?.action === "route")) break;
          let result = { action: "clarify", effort: null };
          if ((command.routingAttempts?.length ?? 0) < 3) {
            const before = command.routingAttempts?.length ?? 0;
            const requested = await store.transact((s) => requestRoute(s, key, command.id, now(), { model: latest.config.router.model }));
            const current = requested.state.items[key], reserved = current.commands[command.id];
            try { result = await route(reserved, current, fresh, latest, { onUsage: (usage) => save(key, {
              type: "record-routing-usage", commandId: command.id, attempt: reserved.routingAttempts.length, usage }) }); }
            catch (error) {
              if (before < 2 || error.code === "missing-secret") throw error;
              // A failed third request becomes a visible question, never an
              // unbounded sequence of API calls on duplicate wake-ups.
            }
          }
          await store.transact((s) => resolveRoute(s, key, command.id, result.action, result.effort, { handle: latest.config.handle }));
          break;
        }
        case "ask": break; // The persisted question is rendered below.
        case "rerun-ci":
          if (!surfaces) throw new Error("The CI rerun adapter is required");
          await surfaces.rerunCi({ key, number: action.pr, head: action.head, testedSha: action.testedSha, runIds: action.runIds, context });
          break;
        case "recover-ci":
          if (!surfaces) throw new Error("The CI rerun adapter is required");
          await surfaces.recoverCi({ key, effectId: action.effectId });
          break;
        case "restart":
          if (!restart) throw new Error("The restart adapter is required");
          await restart({ key, context });
          break;
        case "continue-issue":
          if (!continueIssue) throw new Error("The issue continuation adapter is required");
          await continueIssue({ key, context });
          break;
        default: throw new Error(`Unknown controller action: ${action.type}`);
      }
      outcomes.push({ key, action: action.type, status: "processed" });
    } catch (error) {
      // Persisted intent remains for a later pass; do not claim an uncertain
      // remote operation failed, and do not let one item hide other work.
      outcomes.push({ key, action: action.type, status: error.code === "missing-secret" ? "configuration-error" : "interrupted", reason: error.message });
    }
  }
  outcomes.push(...await collectUsage({ actions, store, context, now }));
  const { state } = await store.load();
  validateLedger(state);
  // Finish immediate durable transitions in this job. CI and human waits yield
  // instead of relying on this controller's completion to wake itself forever.
  if (maxPasses > 1 && outcomes.some((o) => o.status === "processed" && !["ask", "dispatch"].includes(o.action))
    && JSON.stringify(state) !== JSON.stringify(snapshot)) {
    const next = await runController({ api, write, store, actions, repo, toolingSha, run, target, publish, route, restart, continueIssue, surfaces, render,
      now, operationId, observe, discovery: false, maxPasses: maxPasses - 1, assertRuntime });
    const failure = outcomes.find((o) => o.status === "configuration-error");
    if (failure) throw Object.assign(new Error(failure.reason), { code: "missing-secret" });
    return { plans: [...plans, ...next.plans], outcomes: [...outcomes, ...next.outcomes] };
  }
  if (surfaces) await surfaces.render(state, context, outcomes);
  await render(state, context, outcomes);
  // Finish independent controls/recovery and surface the error before failing
  // the Actions entry. Configuration failures must not become green passes.
  const failure = outcomes.find((o) => o.status === "configuration-error");
  if (failure) throw Object.assign(new Error(failure.reason), { code: "missing-secret" });
  return { plans, outcomes };
}
