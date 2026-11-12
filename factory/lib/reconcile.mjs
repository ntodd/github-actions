// The decision table, independent of GitHub I/O. Facts are normalized fresh API
// observations. The runner must commit `events` before executing `action`, and
// revalidate authority/preconditions again before dispatching or publishing.
import { evolve, TERMINAL } from "./protocol.mjs";
import { queuedCommands, WORK_ACTIONS, routeNextAt } from "./commands.mjs";
import { answerText, closureAnswer, issueClosureAnswer, issueClosureChoice } from "./answers.mjs";
import { failureKeys } from "./failure-report.mjs";
import { repairRegistration, repairCandidates, mainRepairRole } from "./main-repair.mjs";
const minute = 60_000;
const identity = (a, b) => a?.id === b?.id && a?.attempt === b?.attempt;
const bad = (phase) => ["queued", "in_progress"].includes(phase);

export function decideItem(ledger, key, facts, config, { now = new Date().toISOString(), integration = null } = {}) {
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) throw new Error("A controller timestamp is required");
  let state = ledger;
  const events = [];
  let item = state.items[key];
  if (!item) throw new Error(`Unknown item ${key}`);
  const finish = (action, label, reason, wait = null) => {
    const status = { state: label, reason, next: wait?.kind ?? action?.type ?? "none", wait };
    if (JSON.stringify(item.status) !== JSON.stringify(status)) observe({ type: "set-status", status });
    return { events, action, status };
  };
  const wait = (label, reason, kind, target, deadline = null) => {
    if (!["work-command", "answer"].includes(kind)) {
      deadline ??= item.status?.wait?.kind === kind && JSON.stringify(item.status.wait.target) === JSON.stringify(target)
        ? item.status.wait.deadline : null;
      deadline ??= new Date(instant + config.timeouts.ciMinutes * minute).toISOString();
      if (instant >= Date.parse(deadline)) return ask(`${reason}; the wait deadline was exceeded`);
    }
    return finish(null, label, reason, { kind, target, deadline });
  };
  const ask = (reason, label = "agent-needs-you", extra = {}) => {
    if (!item.question || item.question.reason !== reason || extra.consumeCommand) observe({ type: "ask", reason, ...extra });
    return finish({ type: "ask", reason, questionId: item.question.id }, label, reason);
  };
  const observe = (event) => { event = { at: now, ...event }; events.push(event); state = evolve(state, key, event); item = state.items[key]; };
  const issueQuestion = (prefix = "") => `${prefix}The issue was closed before all required work landed.\n\n1. Reopen the issue and continue the existing work: /agent answer continue.\n2. Keep the issue closed and stop work: /agent stop (or /agent answer stop).`;
  const mainQuestion = (reason, pr = null) => ask(reason, "agent-needs-you", { kind: "main-failure",
    dependency: { baseSha: facts.main.sha, pr: pr?.number ?? null, headSha: pr?.headSha ?? null,
      keys: failureKeys(pr?.checks ?? facts.main.checks).slice(0, 800), repairIssue: pr?.repairIssue ?? facts.main.repairIssue ?? null },
    ...(command?.action === "answer" ? { consumeCommand: command.id } : {}) });
  const repairState = (number) => {
    const repair = state.items[`issue:${number}`];
    return repair?.paused ? " (paused)" : repair?.question ? " (needs your answer)" : "";
  };
  observe({ type: "sync-api-alerts", timeoutMinutes: config.timeouts.publishMinutes ?? 15 });

  // These observations are bookkeeping, including while stopped. Do not keep
  // returning the first merged PR and thereby hide unfinished upper levels.
  for (const recorded of item.prs) {
    const current = facts.prs?.find((p) => p.number === recorded.number);
    if (current && (current.state !== recorded.state || (current.state === "merged" && current.mergedSha !== recorded.mergedSha))) {
      observe({ type: "pr-observed", number: current.number, state: current.state, mergedSha: current.mergedSha });
    }
  }
  const workIsFinal = () => {
    const required = item.prs.filter((p) => p.required);
    return required.length > 0 && required.every((p) => p.state === "merged" || p.state === "closed" && p.acceptedClosure);
  };
  let allFinal = workIsFinal();
  if (!allFinal && facts.authorization?.valid === true && facts.authorization.revision && facts.authorization.revision !== item.revision) {
    observe({ type: "revise", revision: facts.authorization.revision });
  }
  let op = state.operations[item.activeOperation];
  const open = (facts.prs ?? []).filter((p) => item.prs.some((r) => r.number === p.number && r.required) && p.state === "open");
  const nextCommand = () => queuedCommands(item).find((c) => WORK_ACTIONS.has(c.action) || c.action === "route" || c.action === "clarify");
  let command = nextCommand();
  const previousQuestion = item.question;
  // Interpret control mentions even while a worker owns the item, the item is
  // paused, or a question is outstanding. No coding/publish decision may skip
  // an earlier unread request that might mean stop.
  const mention = queuedCommands(item).find((c) => c.action === "route");
  if (mention && (!facts.observationError || facts.feedbackComplete) && (facts.feedback ?? []).some((f) => f.sourceId === mention.sourceId
    && f.revision === mention.revision && f.authority === "instruction" && f.command?.action === "route")) {
    const nextAt = routeNextAt(mention);
    if ((mention.routingAttempts?.length ?? 0) < 3 && nextAt && instant < Date.parse(nextAt)) {
      return finish(null, "agent-waiting", "Waiting before retrying mention routing", { kind: "routing", target: mention.id, deadline: nextAt });
    }
    return finish({ type: "route", commandId: mention.id }, item.paused ? "agent-stopped" : "agent-ready", "Interpret the trusted mention using the fixed action menu");
  }
  if (item.requestOnly) {
    const eligible = queuedCommands(item).find((c) => (item.evidence.own ? ["update", "resolve"] : ["build", "restart"]).includes(c.action));
    if (eligible) return finish({ type: "admit-request", commandId: eligible.id }, "agent-ready", "Revalidate the selected work request before admission");
    if (command && command.action !== "route") return ask(command.action === "clarify" ? command.clarification || command.text || "Specify the action with /agent <action>."
      : item.evidence.own ? "This PR is not enrolled. Request /agent update or /agent resolve to authorize maintenance."
        : "This issue has no admitted work. Request /agent build or add agent-ready to start.", "agent-needs-you", { consumeCommand: command.id });
    if (item.paused) return wait("agent-stopped", "No work is admitted and automatic work is paused", "work-command", key);
    if (item.question) return wait("agent-needs-you", item.question.reason, "answer", key);
    return wait("agent-waiting", "The request is recorded; coding has not been authorized", "work-command", key);
  }
  const target = op && (facts.prs ?? []).find((p) => p.number === op.target.number);
  const issueStop = queuedCommands(item).find((c) => issueClosureChoice(c, item) === "stop");
  if (issueStop) {
    observe({ type: "answer-issue-closure", commandId: issueStop.id, decision: "stop" });
    command = nextCommand();
  }
  if (command && WORK_ACTIONS.has(command.action) && command.id !== item.restart?.commandId
    && command.id !== item.continuation?.commandId && (item.paused || item.question)) {
    // A queued answer cannot make an in-flight publish known. Preserve that
    // question while receipts are recovered, rather than recreating it on
    // every pass for the same still-unconsumed answer.
    const keepQuestion = op?.phase === "publishing" && item.question?.kind === "publish-outcome"
      || command.action === "answer" && ["pr-closure", "issue-closure", "main-failure"].includes(item.question?.kind);
    observe({ type: "resume", ...(keepQuestion ? {} : { answerSource: command.sourceId }) });
  }

  // A remote effect can complete after stop or loss of authority. The publisher
  // reconciles that effect; its protocol forbids any newly unauthorized write.
  if (op?.phase === "publishing") {
    if (!op.publishStartedAt) { observe({ type: "publication-observed", operationId: op.id }); op = state.operations[item.activeOperation]; }
    if (item.question?.kind === "publish-outcome" && item.question.recovery.operation === op.id
      && op.effects.some((e) => e.id === item.question.recovery.effect && ["applied", "rejected"].includes(e.status))) observe({ type: "resolve-publish-question", operationId: op.id });
    const pending = op.effects.find((e) => e.status === "pending"), incomplete = op.effects.find((e) => e.status !== "applied");
    const since = pending?.requests.at(-1)?.at ?? incomplete?.requests.at(-1)?.at ?? op.publishStartedAt;
    const deadline = since ? new Date(Date.parse(since) + (config.timeouts.publishMinutes ?? 15) * minute).toISOString() : null;
    if (!item.question && pending && deadline && instant >= Date.parse(deadline)) observe({ type: "ask", kind: "publish-outcome",
      recovery: { operation: op.id, effect: pending.id, request: pending.requests.at(-1).id },
      reason: `The outcome of ${op.id}/${pending.id} is still unknown after its publish deadline. Inspect the recorded request; it will not be resent or replaced while uncertain. Recovery continues to read its outcome.` });
    if (!item.question && incomplete && !pending && (incomplete.requests.length >= 3 || deadline && instant >= Date.parse(deadline))) observe({ type: "ask",
      reason: `Publication ${op.id}/${incomplete.id} could not finish ${incomplete.requests.length >= 3 ? "within its request budget" : "before its deadline"}.${incomplete.lastRejection ? ` The last request was rejected (${incomplete.lastRejection.status}).` : ""}${op.publishError?.effect === incomplete.id ? ` ${op.publishError.reason}` : ""} Inspect validation, permissions and the recorded receipts, then request work again.` });
    return finish({ type: "publish", operationId: op.id }, item.paused ? "agent-stopped" : item.question ? "agent-needs-you" : "agent-working",
      item.question?.reason ?? "Reconcile the publish operation and any unresolved requests", pending && deadline ? { kind: "publish-outcome", target: pending.requests.at(-1).id, deadline } : null);
  }
  if (op?.owner && facts.owner && identity(op.owner, facts.owner) && (op.owner.status !== facts.owner.status || op.owner.conclusion !== (facts.owner.conclusion ?? null))) {
    observe({ type: "owner-observed", operationId: op.id, run: facts.owner, status: facts.owner.status, conclusion: facts.owner.conclusion ?? null, startedAt: facts.owner.startedAt });
    op = state.operations[item.activeOperation];
  }
  if (item.continuation?.phase === "requested") {
    const c = item.continuation, effect = Object.values(item.apiEffects ?? {}).find((e) => e.slot === c.slot);
    const obsoleteOwner = op?.owner && bad(op.owner.status) && (item.paused || op.generation !== item.generation || op.revision !== item.revision
      || target && (target.state !== "open" || target.headSha !== op.target.head));
    if (obsoleteOwner) {
      const attempts = op.cancel?.attempts.length ?? 0;
      if (attempts < 3 && (!op.cancel?.nextAt || instant >= Date.parse(op.cancel.nextAt))) return finish({ type: "cancel-owner", operationId: op.id, run: op.owner },
        "agent-waiting", "Cancel the obsolete worker while the issue-reopen request is recovered");
      if (attempts >= 3 && !item.question) observe({ type: "ask", reason: "Worker cancellation attempts were exhausted; confirm its terminal status. Recovery of the sent issue-reopen request continues." });
    }
    const deadline = new Date(Date.parse(c.createdAt) + (config.timeouts.publishMinutes ?? 15) * minute).toISOString();
    if (!item.paused && !item.question && effect?.status !== "pending" && effect?.status !== "applied"
      && (instant >= Date.parse(deadline) || effect?.status === "rejected" && effect.requests.length >= 3)) {
      observe({ type: "ask", reason: issueQuestion("The continue request could not finish within its deadline or request budget. Inspect its recorded effects before trying again. "),
        ...(facts.issueState === "closed" ? { kind: "issue-closure" } : {}) });
    }
    return finish({ type: "continue-issue", commandId: c.commandId }, item.paused ? "agent-stopped" : item.question ? "agent-needs-you" : "agent-waiting",
      item.question?.reason ?? "Recover the issue-reopen request before continuing existing work", { kind: "issue-reopen", target: c.commandId, deadline });
  }
  const stale = op && !TERMINAL.has(op.phase) && (op.generation !== item.generation || op.revision !== item.revision
    || (target && (target.state !== "open" || target.headSha !== op.target.head))
    || (op.phase === "prepared" && facts.main?.sha && op.base.sha !== facts.main.sha));
  const cancel = (reason) => {
    const count = op.cancel?.attempts.length ?? 0;
    if (count >= 3) return ask(`${reason}; cancellation attempts were exhausted`);
    if (op.cancel?.nextAt && instant < Date.parse(op.cancel.nextAt)) return wait("agent-waiting", reason, "owner-terminal", op.owner, op.cancel.nextAt);
    return finish({ type: "cancel-owner", operationId: op.id, run: op.owner }, "agent-waiting", reason);
  };
  if (stale && op.owner && bad(op.owner.status)) return cancel("The operation was superseded; confirm its owner has stopped");
  if (stale && (!op.owner || op.owner.status === "completed")) return finish({ type: "supersede", operationId: op.id }, "agent-waiting", "Discard a result based on obsolete intent or head");
  if (item.restart && !["done", "superseded"].includes(item.restart.phase)) {
    const r = item.restart, origin = item.commands[r.commandId];
    const current = !item.paused && !item.question && r.generation === item.generation && r.revision === item.revision && origin.status === "queued";
    if (r.phase === "ready" && current) return finish({ type: "reserve", mode: "build", pr: null, automatic: false,
      commandIds: [origin.id], feedbackInputs: [] }, "agent-ready", "All old PRs are accounted for; admit the replacement build");
    if (!item.paused && !item.question && instant >= Date.parse(r.createdAt) + config.timeouts.ciMinutes * minute) observe({ type: "ask", reason: "Restart did not reach known PR outcomes before its deadline; investigate the recorded requests before retrying" });
    return finish({ type: "restart", commandId: r.commandId }, item.paused ? "agent-stopped" : item.question ? "agent-needs-you" : "agent-working",
      item.question?.reason ?? "Recover restart effects before admitting replacement work");
  }
  const closed = item.prs.find((p) => p.required && p.state === "closed" && !p.acceptedClosure);
  const closureQuestion = (number, prefix = "") => `${prefix}Required PR #${number} closed without merging.\n\n1. Accept its closure: /agent answer accept-closure #${number}.\n2. Replace the work: /agent restart (retires all recorded PRs and builds again).\n\nYou can also reopen the PR and request work on it.`;
  if (command?.action === "answer" && (item.question?.kind === "pr-closure" || /^accept-closure\b/i.test(command.text.trim()))
    && (!op || TERMINAL.has(op.phase))) {
    if (facts.observationError || !facts.authorization) return wait("agent-waiting", "Reobserve the issue and PR before accepting a closure", "observation", key);
    if (facts.authorization.valid !== true) return ask(facts.authorization.reason ?? "Revalidate authorization before accepting a PR closure");
    const number = closureAnswer(command, item.question, item.revision);
    const recorded = item.prs.find((p) => p.number === number && p.required && p.state === "closed" && !p.acceptedClosure);
    const current = (facts.prs ?? []).find((p) => p.number === number);
    if (recorded && current?.state === "closed") {
      observe({ type: "accept-closure", number, commandId: command.id, authorization: facts.authorization });
      allFinal = workIsFinal();
      command = nextCommand();
    } else if (closed) return ask(closureQuestion(closed.number, "That answer does not identify the current closure and issue revision. "), "agent-needs-you",
      { kind: "pr-closure", number: closed.number, consumeCommand: command.id });
    else return ask("There is no closed required PR to accept. Request work on an open PR, or use /agent restart for replacement work.", "agent-needs-you", { consumeCommand: command.id });
  }
  if (allFinal) {
    if (!item.evidence.own && facts.authorization?.valid !== true) return facts.authorization?.valid === false
      ? ask(facts.authorization.reason ?? "Revalidate authorization before closing the issue")
      : wait("agent-waiting", "Authorization could not be observed before issue completion", "authorization", key);
    if (command?.action === "restart") {
      if (item.evidence.own) return ask("Your own PR cannot be restarted", "agent-needs-you", { consumeCommand: command.id });
      if (facts.authorization.revision !== item.revision) observe({ type: "revise", revision: facts.authorization.revision });
      return finish({ type: "restart", commandId: command.id }, "agent-working", "Retire the recorded work before admitting a replacement build");
    }
    if (!item.evidence.own && (item.revisionPending || facts.authorization.revision !== item.revision)) {
      const text = command && answerText(command).toLowerCase();
      const accepts = command?.action === "answer" && (text === "accept-completion" || text === "1"
        && previousQuestion?.kind === "completion-revision" && Date.parse(command.at) >= Date.parse(previousQuestion.at));
      if (accepts) observe({ type: "accept-completion", commandId: command.id, questionKind: previousQuestion?.kind, authorization: facts.authorization });
      else return ask("The issue changed after its recorded PRs finished.\n\n1. Accept those PRs as covering the revised issue: /agent answer accept-completion.\n2. Request replacement work with /agent restart.", "agent-needs-you", { kind: "completion-revision", ...(command ? { consumeCommand: command.id } : {}) });
    }
    if (command?.action === "answer" && previousQuestion?.kind === "issue-closure") observe({ type: "complete-issue-answer", commandId: command.id });
    if (!item.complete) observe({ type: "close-out" });
    return finish({ type: "close-out" }, "agent-complete", "All required work has an accepted final outcome");
  }
  if (item.question?.kind === "main-failure") {
    const d = item.question.dependency, pr = facts.prs?.find((p) => p.number === d.pr);
    const candidates = d.pr ? pr?.repairIssues : facts.main?.repairIssues;
    let outcome = null;
    if (facts.main?.checks?.state === "success" && facts.main.checks.headSha === facts.main.sha) outcome = "main-green";
    else if (facts.main?.sha && facts.main.sha !== d.baseSha) outcome = "base-moved";
    else if (pr && (pr.state !== "open" || pr.headSha !== d.headSha)) outcome = "pr-changed";
    else if (candidates?.length && candidates[0].issue !== d.repairIssue) outcome = "repair-admitted";
    if (outcome) {
      const repair = candidates?.[0];
      observe({ type: "resolve-main-question", outcome, main: facts.main, headSha: pr?.headSha,
        ...(repair ? { repairKey: `issue:${repair.issue}`, repairBase: repair.baseSha, repairAuthorization: repair.authorization } : {}),
        ...(command?.action === "answer" ? { consumeCommand: command.id } : {}) });
      command = nextCommand();
    } else if (command?.action === "answer") return mainQuestion(`The dependency on default-branch commit ${d.baseSha} has not changed. Admit a repair issue for this base, or provide the missing diagnostic evidence before requesting work.`, pr);
  }
  if (command?.action === "answer" && item.question?.kind === "issue-closure") {
    if (facts.observationError || !facts.authorization) return wait("agent-waiting", "Reobserve the issue before continuing its work", "observation", key);
    if (facts.authorization.valid !== true) return ask(facts.authorization.reason ?? "Revalidate authorization before reopening the issue");
    if (issueClosureAnswer(command, item.question, item.revision) !== "continue") return ask(issueQuestion("That answer does not identify a current choice and issue revision. "),
      "agent-needs-you", { kind: "issue-closure", consumeCommand: command.id });
    observe({ type: "answer-issue-closure", commandId: command.id, decision: "continue", authorization: facts.authorization });
    return finish({ type: "continue-issue", commandId: command.id }, "agent-waiting", "Reopen the issue before continuing its existing PRs");
  }
  if (item.paused) return wait("agent-stopped", "Automatic work is paused", "work-command", key);
  if (item.question) return wait(item.status?.state === "agent-failed" ? "agent-failed" : "agent-needs-you", item.question.reason, "answer", key);
  if (facts.observationError) return wait("agent-waiting", "GitHub facts could not be read completely", "observation", key);
  if (facts.authorization?.valid === false) return ask(facts.authorization.reason ?? "Current work authorization is no longer valid");
  if (!facts.authorization || facts.authorization.valid !== true) return wait("agent-waiting", "Authorization could not be observed", "authorization", key);
  if (facts.issueState === "closed") return item.evidence.own
    ? ask("This PR is closed. Reopen it before requesting maintenance.", "agent-needs-you", command ? { consumeCommand: command.id } : {})
    : ask(issueQuestion(), "agent-needs-you", { kind: "issue-closure", ...(command ? { consumeCommand: command.id } : {}) });

  if (op && !TERMINAL.has(op.phase)) {
    if (op.phase === "prepared") {
      if ((op.dispatch?.attempts.length ?? 0) >= 3) return ask("Dispatch attempts were exhausted; no worker has claimed the operation", "agent-failed");
      if (op.dispatch?.nextAt && instant < Date.parse(op.dispatch.nextAt)) return wait("agent-ready", "Waiting before retrying the same dispatch", "dispatch", op.id, op.dispatch.nextAt);
      return finish({ type: "dispatch", operationId: op.id }, "agent-ready", "Dispatch the reserved operation; duplicate deliveries cannot claim it twice");
    }
    if (op.phase === "claimed") {
      if (!facts.owner || !identity(op.owner, facts.owner)) return wait("agent-waiting", "Cannot establish the recorded owner's current status", "owner-status", op.owner);
      if (bad(op.owner.status)) {
        const since = op.owner.status === "queued" ? op.createdAt : (op.owner.startedAt ?? op.createdAt);
        const limit = op.owner.status === "queued" ? config.timeouts.queuedMinutes : config.timeouts.workerMinutes;
        const deadline = new Date(Date.parse(since) + limit * minute).toISOString();
        if (instant >= Date.parse(deadline)) return cancel("The worker deadline expired; request cancellation before any replacement");
        return wait("agent-working", op.owner.status === "queued" ? "Crew has not started the claimed worker" : "The claimed worker is running", "owner-terminal", op.owner, deadline);
      }
      if (op.owner.status === "completed") {
        if (facts.result?.available) return finish({ type: "collect-result", operationId: op.id }, "agent-working", "Validate the terminal owner's result artifact");
        if (facts.result?.inspected) return finish({ type: "recover-worker", operationId: op.id }, "agent-working", "The worker is terminal and no usable result exists");
        return wait("agent-waiting", "The terminal run's result has not been inspected", "result-inspection", op.id);
      }
    }
    if (op.phase === "result-ready") return finish({ type: facts.result?.inspected && facts.result.available === false || facts.result?.expired ? "result-unavailable" : "publish", operationId: op.id }, "agent-working", "Process the accepted result");
  }

  if (command?.action === "route") return finish({ type: "route", commandId: command.id }, "agent-ready", "Interpret the trusted mention using the fixed action menu");
  if (command?.action === "clarify") return ask(command.clarification || command.text || "Specify the action you want the agent to take");
  if (command && command.target !== Number(key.split(":")[1]) && item.prs.some((p) => p.number === command.target && !p.required)) {
    return ask(`PR #${command.target} was retired; post this request on the issue or an active PR`, "agent-needs-you", { consumeCommand: command.id });
  }
  const unaccounted = item.prs.find((p) => p.required && p.state === "closed" && !p.acceptedClosure);
  if (unaccounted && command?.action !== "restart") return ask(closureQuestion(unaccounted.number), "agent-needs-you", { kind: "pr-closure", number: unaccounted.number });
  if (open.length > 1 || facts.unsupportedStack) return ask("This work has several dependent PRs; stack maintenance is not enabled yet");

  const reserve = (mode, pr = null, request = null, feedback = []) => {
    if (mode === "update" && integration && (integration.item !== key || integration.pr !== pr?.number)) {
      return wait("agent-waiting", `Waiting for integration of PR #${integration.pr}`, "integration", integration.pr, integration.deadline);
    }
    if (!request) {
      const day = new Date(now).toISOString().slice(0, 10);
      const kind = mode === "update" ? "api" : "coding";
      const count = item.attempts.filter((a) => a.automatic && (a.kind ?? "coding") === kind && new Date(a.at).toISOString().startsWith(day)).length;
      if (count >= (kind === "api" ? 30 : config.budget.automaticAttemptsPerItemPerDay)) return ask("The daily automatic attempt budget was exhausted", "agent-failed");
      const history = Object.values(state.operations).filter((o) => o.item === key).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const last = history.at(-1);
      let repeated = 0;
      for (const previous of history.toReversed()) {
        if (previous.phase !== "failed" || !previous.failure || previous.failure !== last?.failure
          || previous.target.head !== last.target.head || previous.base.sha !== last.base.sha || previous.revision !== item.revision) break;
        repeated++;
      }
      if (repeated >= config.budget.repeatedFailureLimit) return ask("The same failure repeated without progress", "agent-failed");
      const responses = Object.values(state.operations).filter((o) => o.item === key && o.mode === "respond");
      const rounds = item.respondBaseline === undefined ? responses.filter((o) => Date.parse(o.createdAt) >= Date.parse(item.handoverAt ?? "1970-01-01T00:00:00Z")).length
        : responses.length - item.respondBaseline;
      if (mode === "respond" && rounds >= config.maxRounds) return ask("The response-round limit was reached", "agent-failed");
    }
    return finish({ type: "reserve", mode, pr: pr?.number ?? null, automatic: !request, commandIds: request ? [request.id] : [], feedbackInputs: feedback.map((f) => ({ sourceId: f.sourceId, revision: f.revision })) }, "agent-ready", `Start ${mode} on the existing work item`);
  };
  const explicitPr = open.find((p) => p.number === command?.target) ?? open[0];
  if (command) {
    if (item.evidence.own && ["build", "restart", "respond"].includes(command.action)) return ask("Your own PR supports explicitly requested update/resolve maintenance; it cannot be restarted or enrolled in the issue workflow");
    if (command.action === "restart") return finish({ type: "restart", commandId: command.id }, "agent-working", "Close the recorded PRs before admitting replacement work");
    if (command.action === "retry" || command.action === "answer") return reserve(op?.mode ?? (open.length ? "respond" : "build"), explicitPr, command);
    const mode = command.action === "build" && open.length ? "respond" : command.action;
    if (["respond", "resolve", "update"].includes(mode) && !explicitPr) return ask("This action needs an existing open PR");
    return reserve(mode, explicitPr, command);
  }
  if (item.evidence.own && item.maintenanceComplete) return wait("agent-review", "The requested maintenance is finished; ongoing work is not authorized", "work-command", key);
  if (!item.evidence.own && item.revisionPending && open.length) return reserve("respond", open[0]);
  if (!open.length && !item.evidence.own && facts.main?.checks && !facts.main.repairWork) {
    if (facts.main.checks.state === "pending") return wait("agent-waiting", "Wait for current default-branch CI before building on it", "main-ci", facts.main.sha);
    if (facts.main.checks.state === "failure") {
      if (!facts.main.repairIssue) return mainQuestion(`The default branch fails at ${facts.main.sha}. Admit its repair issue first. A human repair issue can end with <!-- factory:repair-base=${facts.main.sha} -->; registered main-red producers use that SHA as their source key.`);
      const target = `${facts.main.sha}:${facts.main.repairIssue}`, due = item.status?.wait?.kind === "main-green" && item.status.wait.target === target
        ? item.status.wait.deadline : new Date(instant + config.timeouts.ciMinutes * minute).toISOString();
      if (instant >= Date.parse(due)) return mainQuestion(`Main repair #${facts.main.repairIssue} has not made current default-branch CI green before its deadline.`);
      return wait("agent-waiting", `Waiting on main repair #${facts.main.repairIssue}${repairState(facts.main.repairIssue)} before starting ordinary issue work`, "main-green", target, due);
    }
  }
  if (op?.phase === "failed") return reserve(op.mode === "update" && op.failure === "update-conflict" ? "resolve" : op.mode, open[0]);
  for (const pr of open) {
    const checks = pr.checks;
    if (!["MERGEABLE", "CONFLICTING"].includes(pr.mergeable)) return wait("agent-waiting", "GitHub has not determined mergeability", "mergeability", pr.number);
    const shared = checks?.state === "failure" && checks.headSha === pr.headSha && checks.failed?.length
      && facts.main?.sha === pr.baseSha && checks.failed.every((f) => f.sharedMain === true && f.baseSha === pr.baseSha && f.signature);
    if (shared && !facts.main?.repairWork) {
      const repair = pr.repairIssue ?? facts.main?.repairIssue;
      if (!repair && facts.main?.checks) return mainQuestion(`PR #${pr.number} has only failures confirmed on ${pr.baseSha}, but no admitted repair issue covers them. Admit the repair instead of copying its fix into this PR. A human issue can end with <!-- factory:repair-base=${pr.baseSha} -->.`, pr);
      const target = facts.main?.checks ? `${facts.main.sha}:${repair}` : repair ?? pr.baseSha;
      const due = item.status?.wait?.kind === "main-green" && item.status.wait.target === target
        ? item.status.wait.deadline : new Date(instant + config.timeouts.ciMinutes * minute).toISOString();
      if (instant >= Date.parse(due) && facts.main?.checks) return mainQuestion(`Main repair #${repair} has not made current default-branch CI green before its deadline.`, pr);
      return wait("agent-waiting", repair ? `Waiting on main repair #${repair}${repairState(repair)}` : "Main has the same confirmed failure; a repair issue is needed", "main-green", target, due);
    }
    if (pr.mergeable === "CONFLICTING") return reserve("resolve", pr);
    const rerun = (pr.apiReruns ?? []).find((r) => r.effectStatus !== "applied" || r.attempt > r.requestedAttempt && r.status !== "completed");
    if (rerun) {
      const due = new Date(Date.parse(rerun.createdAt) + config.timeouts.ciMinutes * minute).toISOString();
      if (instant >= Date.parse(due)) return ask("The CI rerun did not reach a known terminal outcome before its deadline");
      if (rerun.effectStatus !== "applied") return finish({ type: "recover-ci", effectId: rerun.effectId }, "agent-waiting", "Recover the reserved CI rerun without sending a duplicate request", { kind: "ci-rerun", target: rerun.effectId, deadline: due });
      return wait("agent-waiting", "The admitted CI rerun is queued or running", "ci-rerun", rerun.effectId, due);
    }
    if (!checks || checks.headSha !== pr.headSha || !["success", "failure"].includes(checks.state)) {
      const target = `${pr.number}:${pr.headSha}`;
      const due = pr.ciDeadline ?? (item.status?.wait?.kind === "ci" && item.status.wait.target === target ? item.status.wait.deadline : null)
        ?? new Date(instant + config.timeouts.ciMinutes * minute).toISOString();
      if (instant >= Date.parse(due)) return ask("CI did not report a current-head result before its deadline");
      return wait("agent-waiting", "Waiting for checks on the current PR head", "ci", target, due);
    }
    if (checks.state === "failure") {
      if (!facts.main?.repairWork && facts.main?.checks?.state === "failure" && checks.failed?.some((f) => f.attribution === "unknown")) {
        return mainQuestion(`PR #${pr.number} and the default branch both fail, but complete diagnostic evidence does not establish which failures are shared. ${checks.failed.find((f) => f.attribution === "unknown")?.diagnosticReason ?? "Inspect their failing test or compiler diagnostics."}`, pr);
      }
      const transient = checks.failed?.filter((f) => !f.sharedMain);
      if (transient?.length && transient.every((f) => f.transient && f.runId) && (pr.reruns ?? 0) < 1) {
        return finish({ type: "rerun-ci", pr: pr.number, head: pr.headSha, testedSha: checks.testedSha ?? pr.headSha,
          runIds: [...new Set(transient.map((f) => f.runId))] }, "agent-waiting", "Rerun the identified transient CI failure once");
      }
      return reserve("respond", pr);
    }
    if (!item.evidence.own && (pr.feedback ?? []).some((f) => f.trustedAuthor && f.edited && f.authority === "data" && f.requiresResponse && f.sourceId.startsWith("review:"))) {
      return ask("The changes-requested review was edited; provide the instructions in a new unedited comment mentioning the agent");
    }
    const feedback = (item.evidence.own ? [] : pr.feedback ?? []).filter((f) => ["instruction", "signal"].includes(f.authority) && f.requiresResponse
      && item.feedback?.[f.sourceId] !== f.revision);
    if (feedback.length) return reserve("respond", pr, null, feedback);
    if (!item.evidence.own && pr.signals?.pending?.length) {
      if (pr.draft && pr.signals.pending.some((s) => s.startsWith("review:"))) return finish({ type: "ready-for-bots", pr: pr.number }, "agent-waiting", "CI passed; mark the PR ready so its configured review bots can run");
      const due = pr.signalDeadline ?? (item.status?.wait?.kind === "signals" && item.status.wait.target === pr.number ? item.status.wait.deadline : null)
        ?? new Date(instant + config.timeouts.reviewMinutes * minute).toISOString();
      if (instant >= Date.parse(due)) return ask("A blocking review/check signal exceeded its wait deadline");
      return wait("agent-waiting", "Waiting for blocking review/check signals", "signals", pr.number, due);
    }
    if (pr.autoMerge && pr.behind) {
      if (integration && integration.item !== key) return wait("agent-waiting", "Another PR is being integrated first", "integration", integration.item);
      return reserve("update", pr);
    }
    return finish(item.handover?.pr === pr.number && item.handover?.head === pr.headSha ? null : { type: "handover", pr: pr.number }, "agent-review", pr.approvalRequired ? "Checks passed; approval covering the latest push is required" : "Checks passed; waiting for your review and merge decision");
  }
  if (item.evidence.own) return wait("agent-review", "Only explicitly requested maintenance is authorized", "work-command", key);
  return reserve("build");
}

// One pass plans all active items in stable priority/age order and reserves the
// integration selection in the same ledger transaction. Controller actions are
// returned to the I/O runner, which must reobserve before any external write.
export function decideRepository(ledger, observations, config, { now = new Date().toISOString() } = {}) {
  let state = structuredClone(ledger);
  observations = structuredClone(observations);
  for (const [key, facts] of Object.entries(observations)) {
    const item = state.items[key];
    if (!item || item.requestOnly || item.evidence.own || item.complete) continue;
    const registration = repairRegistration(item, facts);
    const required = item.prs.filter((p) => p.required), final = required.length && required.every((p) => {
      const actual = facts.prs?.find((pr) => pr.number === p.number);
      return actual?.state === "merged" || actual?.state === "closed" && p.acceptedClosure;
    });
    if (registration && !final) {
      if (registration.revision !== item.revision) state = evolve(state, key, { type: "revise", revision: registration.revision });
      state = evolve(state, key, { type: "register-main-repair", registration, authorization: facts.authorization, at: now });
    }
  }
  for (const [key, facts] of Object.entries(observations)) if (facts.main?.checks) {
    const mainKeys = facts.main.checks.failed?.every((f) => f.completeEvidence) ? failureKeys(facts.main.checks) : [];
    const candidates = repairCandidates(state, observations, mainKeys, key, facts.main.sha);
    const enrich = (rows) => rows.map((r) => ({ ...r, baseSha: observations[`issue:${r.issue}`].repairSpec.baseSha,
      authorization: observations[`issue:${r.issue}`].authorization }));
    facts.main.repairIssues = enrich(candidates); facts.main.repairIssue = candidates[0]?.issue ?? null;
    facts.main.repairWork = mainRepairRole(state.items[key], facts);
    for (const pr of facts.prs ?? []) {
      const shared = pr.checks?.failed?.filter((f) => f.sharedMain) ?? [];
      pr.repairIssues = enrich(repairCandidates(state, observations, failureKeys({ failed: shared }), key, facts.main.sha));
      pr.repairIssue = pr.repairIssues[0]?.issue ?? null;
    }
  }
  const plans = [];
  const selection = state.integration;
  if (selection) {
    const selected = state.items[selection.item];
    const pr = observations[selection.item]?.prs?.find((p) => p.number === selection.pr);
    if (selected.paused || selected.question || (pr && pr.state !== "open") || Date.parse(now) >= Date.parse(selection.deadline)) {
      state = evolve(state, selection.item, { type: "release-integration" });
    }
  }
  const keys = Object.keys(state.items).sort((a, b) => {
    const priority = (key) => observations[key]?.main?.repairWork || state.items[key].evidence.producer?.source === "main-red" ? 0 : 1;
    return priority(a) - priority(b) || Number(a.split(":")[1]) - Number(b.split(":")[1]) || a.localeCompare(b);
  });
  for (const key of keys) {
    const facts = observations[key];
    if (!facts) continue;
    const plan = decideItem(state, key, facts, config, { now, integration: state.integration });
    for (const event of plan.events) state = evolve(state, key, event);
    if (plan.action?.type === "reserve" && plan.action.mode === "update") {
      state = evolve(state, key, { type: "select-integration", number: plan.action.pr, at: now,
        deadline: new Date(Date.parse(now) + config.timeouts.ciMinutes * minute).toISOString() });
    }
    const selected = state.integration?.item === key;
    const selectedPr = facts.prs?.find((p) => p.number === state.integration?.pr);
    if (selected && (plan.action?.type === "ask" || selectedPr?.approvalRequired || selectedPr?.autoMerge === false
      || (plan.action?.type === "reserve" && ["respond", "resolve"].includes(plan.action.mode)))) {
      state = evolve(state, key, { type: "release-integration" });
    }
    plans.push({ key, ...plan });
  }
  return { state, plans };
}
