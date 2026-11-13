import { createHash } from "node:crypto";
import { ACTIONS } from "./admission.mjs";
import { evolve, validateLedger } from "./protocol.mjs";
import { compareRequests } from "./ordering.mjs";
import { issueClosureChoice } from "./answers.mjs";
export const WORK_ACTIONS = new Set(["answer", "respond", "resolve", "update", "build", "restart", "retry"]);
const keyOf = (fact) => createHash("sha256").update(`${fact.sourceId}\0${fact.revision}`).digest("hex");

// Record every new source/revision before applying any command. The caller
// supplies readFeedback's API-derived facts, not the triggering event payload.
export function ingestCommands(ledger, itemKey, facts) {
  validateLedger(ledger);
  const next = structuredClone(ledger), item = next.items[itemKey];
  if (!item) throw new Error("Cannot ingest commands for an unknown item");
  for (const fact of facts) {
    if (fact.authority !== "instruction" || !fact.command) continue;
    const label = fact.sourceId?.startsWith("label:");
    // A historical admission label is not another request, and renaming a
    // previously observed label cannot turn that same event into new work.
    if (label && (Object.values(item.commands).some((c) => c.sourceId === fact.sourceId)
      || fact.sourceId === item.evidence.sourceId)) continue;
    if (label && fact.command.action === "build") {
      const originalLabel = /^label:([1-9]\d*)$/.exec(item.evidence.sourceId);
      if (originalLabel ? BigInt(fact.sourceId.split(":")[1]) <= BigInt(originalLabel[1])
        : !item.evidence.at || Date.parse(fact.createdAt) < Date.parse(item.evidence.at)) continue;
    }
    const id = keyOf(fact);
    if (Object.hasOwn(item.commands, id)) continue;
    if (!/^(issue-comment|review-comment|label):[1-9]\d*$/.test(fact.sourceId) || !/^[a-f\d]{64}$/.test(fact.revision)
      || !Number.isFinite(Date.parse(fact.createdAt)) || !(ACTIONS.has(fact.command.action) || fact.command.action === "route")) throw new Error("Invalid API-derived command");
    item.commands[id] = { id, sourceId: fact.sourceId, revision: fact.revision, author: fact.author,
      action: label && fact.command.action === "build" && item.question && !item.authorizationRevoked ? "answer" : fact.command.action,
      text: fact.command.text ?? "", effort: fact.command.effort ?? null,
      at: fact.createdAt, target: fact.target ?? null, thread: fact.thread ?? null, status: "queued", acknowledgement: "pending" };
  }
  return validateLedger(next);
}

export const routeNextAt = (command) => command.routingAttempts?.length
  ? new Date(Date.parse(command.routingAttempts.at(-1)) + 30_000 * 2 ** (command.routingAttempts.length - 1)).toISOString() : null;

export function requestRoute(ledger, itemKey, commandId, at, { model = "unknown" } = {}) {
  const next = structuredClone(ledger), command = next.items[itemKey]?.commands[commandId];
  if (command?.action !== "route" || command.status !== "queued" || !Number.isFinite(Date.parse(at))
    || (command.routingAttempts?.length ?? 0) >= 3 || routeNextAt(command) && Date.parse(at) < Date.parse(routeNextAt(command))) {
    throw new Error("Mention routing request is not due or its budget is exhausted");
  }
  (command.routingAttempts ??= []).push(at);
  command.routingUsage ??= command.routingAttempts.slice(0, -1).map(() => ({ source: "responses-api", status: "unknown", model: "unknown", tokens: null, responseId: null }));
  command.routingUsage.push({ source: "decisions-api", status: "unknown", model, tokens: null, responseId: null });
  return validateLedger(next);
}

export function resolveRoute(ledger, itemKey, commandId, action, effort = null, { handle } = {}) {
  if (!ACTIONS.has(action) || (action === "effort" ? !["low", "medium", "high", "xhigh", "max"].includes(effort) : effort !== null)) throw new Error("Router selected an action outside its menu");
  const next = structuredClone(ledger), command = next.items[itemKey]?.commands[commandId];
  if (command?.action !== "route" || command.status !== "queued") throw new Error("The routing request is no longer pending");
  command.action = action;
  command.effort = effort;
  command.routed = true;
  if (action === "answer" && handle !== undefined) {
    if (typeof handle !== "string" || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(handle)) throw new Error("The routed answer needs its trusted mention handle");
    command.routedHandle = handle.toLowerCase();
  }
  if (action === "clarify") command.clarification = "I could not confidently route this mention. Post /agent <action> with your instructions; exact commands do not need the router.";
  return validateLedger(next);
}

export const queuedCommands = (item) => Object.values(item.commands).filter((c) => c.status === "queued")
  .sort(compareRequests);

// A routed control is authoritative only while its exact trusted source is
// still present. It must fence work even if the controller crashes between
// recording the menu selection and applying the generation/pause transition.
export function pendingControls(item, facts, inputs = []) {
  return facts.filter((fact) => {
    if (!fact.command || fact.authority !== "instruction") return false;
    const known = Object.values(item.commands).find((c) => c.sourceId === fact.sourceId && c.revision === fact.revision);
    const interpreted = fact.command.action === "route" && known?.routed && known.status !== "superseded" ? known : fact.command;
    const answer = issueClosureChoice({ ...interpreted, at: fact.createdAt }, item);
    const action = answer === "stop" || known?.issueClosureDecision === "stop" ? "stop"
      : interpreted.action;
    if (["stop", "restart"].includes(action) && Object.values(item.commands).some((c) => (c.operation || c.controlHandled && c.issueClosureDecision)
      && WORK_ACTIONS.has(c.action) && compareRequests({ ...fact, action }, c) < 0)) return false;
    if (action === "stop") return !known || known.status === "queued";
    return action === "restart" && (!known || !inputs.includes(known.id) && !["applied", "incorporated", "superseded"].includes(known.status));
  });
}

// Call only with a complete, successful API conversation read. A failed read is
// not evidence of deletion. Past completed intent remains history; an active
// operation must lose permission when one of its authorizing sources changes.
export function revalidateCommands(ledger, itemKey, facts) {
  let next = structuredClone(ledger);
  const item = next.items[itemKey], active = next.operations[item.activeOperation];
  const valid = (command) => facts.some((f) => f.sourceId === command.sourceId && f.revision === command.revision
    && f.authority === "instruction" && f.command);
  let invalidActive = false;
  for (const command of Object.values(item.commands)) {
    const authorizes = active && !["done", "failed", "superseded"].includes(active.phase) && active.inputs?.includes(command.id);
    if ((command.status === "queued" || authorizes) && !valid(command)) {
      command.status = "superseded";
      invalidActive ||= Boolean(authorizes);
    }
  }
  if (invalidActive && active.generation === item.generation) {
    item.generation++;
    if (!item.paused) next = evolve(next, itemKey, { type: "ask", reason: "An authorizing command changed or disappeared; post a new command to continue" });
  }
  const current = next.items[itemKey];
  if (current.restart && !["done", "superseded"].includes(current.restart.phase)
    && !valid(current.commands[current.restart.commandId]) && current.restart.generation === current.generation) {
    current.generation++;
    if (!current.paused) next = evolve(next, itemKey, { type: "ask", reason: "The restart command changed or disappeared; post a new command to continue" });
  }
  const continuation = next.items[itemKey].continuation;
  if (continuation?.phase === "requested" && !valid(next.items[itemKey].commands[continuation.commandId])
    && continuation.generation === next.items[itemKey].generation) {
    next.items[itemKey].generation++;
    if (!next.items[itemKey].paused) next = evolve(next, itemKey, { type: "ask", reason: "The continue command changed or disappeared; recover its request before posting a new command" });
  }
  return validateLedger(next);
}

export function applyControls(ledger, itemKey, { now } = {}) {
  let next = structuredClone(ledger);
  const initial = next.items[itemKey];
  // A complete later read can reveal requests older than a stop that was
  // already applied. They remain accounted for, but cannot resume the item.
  const barriers = Object.values(initial.commands).filter((c) => c.controlHandled
    || c.action === "stop" && c.status === "applied" || c.id === initial.restart?.commandId);
  for (const command of queuedCommands(initial)) {
    if ((WORK_ACTIONS.has(command.action) || command.action === "route") && barriers.some((b) => compareRequests(command, b) < 0)) command.status = "superseded";
  }
  for (const original of queuedCommands(next.items[itemKey])) {
    const item = next.items[itemKey], command = item.commands[original.id];
    if (command.status !== "queued") continue;
    const newerHonoredWork = () => Object.values(item.commands).some((c) => WORK_ACTIONS.has(c.action)
      && (next.operations[c.operation]?.inputs?.includes(c.id) || c.controlHandled && c.issueClosureDecision)
      && compareRequests(command, c) < 0);
    if (["stop", "restart"].includes(command.action) && newerHonoredWork()) {
      command.status = "superseded"; command.controlHandled = true;
      for (const older of queuedCommands(item)) if ((WORK_ACTIONS.has(older.action) || older.action === "route")
        && compareRequests(older, command) < 0) older.status = "superseded";
      continue;
    }
    if (command.action === "stop") {
      next = evolve(next, itemKey, { type: "stop" });
      const current = next.items[itemKey];
      for (const before of queuedCommands(current)) {
        if (before.id === command.id) break;
        if (WORK_ACTIONS.has(before.action) || before.action === "route") current.commands[before.id].status = "superseded";
      }
      current.commands[command.id].status = "applied";
      current.commands[command.id].controlHandled = true;
    } else if (command.action === "status") command.status = "applied";
    else if (command.action === "effort") { item.effort = command.effort; command.status = "applied"; }
    else if (command.action === "restart" && !item.requestOnly && !item.authorizationRevoked && !item.evidence.own
      && (!item.restart || ["done", "superseded"].includes(item.restart.phase)) && item.restart?.commandId !== command.id) {
      next = evolve(next, itemKey, { type: "begin-restart", commandId: command.id, at: now ?? command.at });
      const current = next.items[itemKey];
      current.commands[command.id].controlHandled = true;
      for (const before of queuedCommands(current)) {
        if (before.id === command.id) break;
        if (WORK_ACTIONS.has(before.action) || before.action === "route") current.commands[before.id].status = "superseded";
      }
    }
    // Work and route requests remain pending until the controller can honor
    // them. Asking for status or effort never clears a pause or question.
  }
  return validateLedger(next);
}

export function resumeForCommand(ledger, itemKey, commandId) {
  const command = ledger.items[itemKey]?.commands[commandId];
  if (command?.status !== "queued" || !WORK_ACTIONS.has(command.action)) throw new Error("No pending work request to resume");
  return evolve(ledger, itemKey, { type: "resume", answerSource: command.sourceId });
}
