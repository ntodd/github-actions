// Trusted controller transitions. These functions never perform GitHub writes;
// commit the returned ledger before executing an effect. Observations must come
// from the controller's API adapter, never from event payloads or worker claims.
import { createHash } from "node:crypto";
import { attachmentManifest, referencedAttachments, attachmentDescriptor } from "./attachments.mjs";
import { validEffect, validReceipt, pullRequestText, expectedEffectHead } from "./effects.mjs";
import { validApiJournal } from "./api-journal.mjs";
import { nodeId, replyProposal, threadRevision, threadEffectId } from "./threads.mjs";
import { syncApiAlerts, validApiAlerts } from "./recovery.mjs";
import { answerText, closureAnswer, issueClosureChoice } from "./answers.mjs";
import { validFactoryApp } from "./identity.mjs";
import { compareRequests } from "./ordering.mjs";
import { validMainRepair } from "./main-repair.mjs";
import { diagnosticHash, validFailureContext } from "./failure-report.mjs";
import { validRunner, validOperationUsage, validRouterUsage, validExecution, workerUsage } from "./usage.mjs";

export const SCHEMA = 1;
export const TERMINAL = new Set(["done", "failed", "superseded"]);
const PHASES = new Set(["prepared", "claimed", "result-ready", "publishing", ...TERMINAL]);
const MODES = new Set(["build", "respond", "resolve", "update"]);
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const KEY = /^(issue|pr):[1-9]\d*$/;
const own = (o, k) => Object.hasOwn(o, k);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.name = "ProtocolError"; this.code = code; }
}
function requireThat(condition, code, message) {
  if (!condition) throw new ProtocolError(code, message);
}
function time(value) {
  requireThat(typeof value === "string" && Number.isFinite(Date.parse(value)), "invalid", "A valid controller timestamp is required");
  return value;
}
function runIdentity(value) {
  requireThat(object(value) && typeof value.id === "string" && /^[1-9]\d*$/.test(value.id) && Number.isSafeInteger(value.attempt) && value.attempt > 0,
    "invalid", "A run ID and positive run attempt are required");
  return { id: value.id, attempt: value.attempt };
}
const sameRun = (a, b) => a?.id === b?.id && a?.attempt === b?.attempt;
export function validBranch(ref) {
  return typeof ref === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
    && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/")
    && ref.split("/").every((p) => !p.startsWith(".") && !p.endsWith(".") && !p.endsWith(".lock"));
}
export const revisionOf = ({ title, body }) => createHash("sha256").update(JSON.stringify([title, body ?? ""])).digest("hex");

export function emptyLedger(repositoryId) {
  requireThat(/^[1-9]\d*$/.test(repositoryId), "invalid", "A stable numeric repository ID is required");
  return { schemaVersion: SCHEMA, repositoryId, integration: null, items: {}, operations: {} };
}

export function recordFactoryApp(ledger, app) {
  validateLedger(ledger);
  requireThat(validFactoryApp(app), "invalid", "Factory identity needs a verified App ID and bot login");
  requireThat(!ledger.factoryApp || ledger.factoryApp.id === app.id && ledger.factoryApp.login === app.login,
    "invalid", "The factory App changed; migrate its identity explicitly before enabling work");
  return validateLedger({ ...ledger, factoryApp: structuredClone(app) });
}

// Admission evidence identifies its API source. It is not independently proof
// of authority; the gate must revalidate that source before claim and publish.
export function admit(ledger, { key, revision, evidence, prs = [], requestOnly = false }) {
  validateLedger(ledger);
  requireThat(KEY.test(key) && /^[0-9a-f]{64}$/.test(revision), "invalid", "Invalid item key or issue revision");
  requireThat(object(evidence) && typeof evidence.sourceId === "string" && evidence.sourceId.length > 0,
    "invalid", "Admission needs the original authorization source");
  requireThat(typeof requestOnly === "boolean" && (requestOnly ? evidence.kind === "request" : evidence.kind !== "request"),
    "invalid", "A pending mention cannot authorize work");
  if (own(ledger.items, key)) return ledger;
  const next = structuredClone(ledger);
  next.items[key] = { key, revision, evidence: structuredClone(evidence), generation: 0, paused: false, complete: false,
    question: null, revisionPending: false, activeOperation: null, attempts: [], commands: {}, prs: structuredClone(prs),
    ...(requestOnly ? { requestOnly: true } : {}) };
  validateLedger(next);
  return next;
}

export function validateLedger(s) {
  requireThat(object(s) && s.schemaVersion === SCHEMA, "corrupt", "Unsupported or missing factory state schema");
  requireThat(/^[1-9]\d*$/.test(s.repositoryId) && object(s.items) && object(s.operations), "corrupt", "Malformed repository state");
  requireThat(s.factoryApp === undefined || validFactoryApp(s.factoryApp), "corrupt", "Malformed factory App identity");
  if (s.integration != null) requireThat(object(s.integration) && Object.hasOwn(s.items, s.integration.item) && !s.items[s.integration.item].requestOnly
    && Number.isSafeInteger(s.integration.pr) && s.integration.pr > 0
    && Number.isFinite(Date.parse(s.integration.selectedAt)) && Number.isFinite(Date.parse(s.integration.deadline)),
    "corrupt", "Malformed integration selection");
  const prs = new Set();
  for (const [key, item] of Object.entries(s.items)) {
    requireThat(KEY.test(key) && object(item) && item.key === key && integer(item.generation)
      && typeof item.paused === "boolean" && typeof item.complete === "boolean"
      && /^[0-9a-f]{64}$/.test(item.revision) && object(item.evidence)
      && typeof item.evidence.sourceId === "string" && item.evidence.sourceId.length > 0
      && Array.isArray(item.attempts) && object(item.commands) && Array.isArray(item.prs), "corrupt", `Malformed item ${key}`);
    requireThat(item.requestOnly === undefined || typeof item.requestOnly === "boolean", "corrupt", `Malformed admission state for ${key}`);
    requireThat(!item.requestOnly || item.evidence.kind === "request" && !item.activeOperation && !item.attempts.length && !item.restart && !item.continuation && !item.complete
      && !Object.values(s.operations).some((op) => op.item === key), "corrupt", `An unadmitted request owns work: ${key}`);
    if (["request", "routed-command"].includes(item.evidence.kind)) requireThat(/^(issue-comment|review-comment):[1-9]\d*$/.test(item.evidence.sourceId)
      && /^[a-f\d]{64}$/.test(item.evidence.revision) && typeof item.evidence.actor === "string"
      && (item.evidence.kind === "request" ? item.requestOnly === true
        : (item.evidence.own ? ["update", "resolve"] : ["build", "restart"]).includes(item.evidence.action)),
      "corrupt", `Malformed mention evidence for ${key}`);
    for (const [id, command] of Object.entries(item.commands)) {
      requireThat(/^[a-f\d]{64}$/.test(id) && command?.id === id
        && /^(issue-comment|review-comment|label):[1-9]\d*$/.test(command.sourceId)
        && /^[a-f\d]{64}$/.test(command.revision) && typeof command.author === "string"
        && ["route", "answer", "respond", "resolve", "update", "build", "restart", "retry", "stop", "effort", "status", "clarify"].includes(command.action)
        && ["queued", "reserved", "applied", "incorporated", "superseded"].includes(command.status)
        && ["pending", "done"].includes(command.acknowledgement) && Number.isFinite(Date.parse(command.at)),
        "corrupt", `Malformed command for ${key}`);
      requireThat(command.routed === undefined || typeof command.routed === "boolean", "corrupt", `Malformed routing decision for ${key}`);
      requireThat(command.routedHandle === undefined || command.routed === true && command.action === "answer"
        && typeof command.routedHandle === "string" && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/.test(command.routedHandle),
        "corrupt", `Malformed routed answer handle for ${key}`);
      requireThat(command.issueClosureDecision === undefined || command.action === "answer" && ["stop", "continue"].includes(command.issueClosureDecision),
        "corrupt", `Malformed issue closure decision for ${key}`);
      requireThat(command.issueClosureOutcome === undefined || command.issueClosureDecision === "continue"
        && ["done", "superseded"].includes(command.issueClosureOutcome), "corrupt", `Malformed issue continuation outcome for ${key}`);
      requireThat(command.issueClosureReason === undefined || command.issueClosureOutcome === "superseded"
        && typeof command.issueClosureReason === "string" && command.issueClosureReason.length <= 2000,
        "corrupt", `Malformed issue continuation reason for ${key}`);
      requireThat(command.mainAnswer === undefined || typeof command.mainAnswer === "string" && command.mainAnswer.length <= 2000,
        "corrupt", `Malformed main dependency answer for ${key}`);
      requireThat(command.controlHandled === undefined || command.controlHandled === true && (["stop", "restart"].includes(command.action) || command.issueClosureDecision),
        "corrupt", `Malformed command ordering barrier for ${key}`);
      requireThat(command.routingAttempts === undefined || Array.isArray(command.routingAttempts) && command.routingAttempts.length <= 3
        && command.routingAttempts.every((at, i, rows) => Number.isFinite(Date.parse(at)) && (!i || Date.parse(at) >= Date.parse(rows[i - 1]))),
        "corrupt", `Malformed routing attempts for ${key}`);
      requireThat(command.routingUsage === undefined || Array.isArray(command.routingUsage)
        && command.routingUsage.length === command.routingAttempts?.length && command.routingUsage.every(validRouterUsage),
        "corrupt", `Malformed routing usage for ${key}`);
    }
    requireThat(validApiJournal(item), "corrupt", `Malformed controller API journal for ${key}`);
    requireThat(validApiAlerts(item), "corrupt", `Malformed API recovery alerts for ${key}`);
    requireThat(validMainRepair(item), "corrupt", `Malformed main repair evidence for ${key}`);
    requireThat(item.revisionPending === undefined || typeof item.revisionPending === "boolean", "corrupt", `Malformed revision state for ${key}`);
    requireThat(item.question === null || (object(item.question) && typeof item.question.reason === "string"
      && item.question.reason.length > 0 && item.question.reason.length <= 16000
      && (item.question.id === undefined || /^[a-f\d]{64}$/.test(item.question.id))
      && (item.question.kind == null || ["completion-revision", "publish-outcome", "pr-closure", "issue-closure", "main-failure"].includes(item.question.kind))
      && (item.question.at == null || Number.isFinite(Date.parse(item.question.at)))), "corrupt", `Malformed question for ${key}`);
    if (item.question?.kind === "publish-outcome") {
      const recovery = item.question.recovery, op = s.operations[recovery?.operation], effect = op?.effects.find((e) => e.id === recovery.effect);
      requireThat(object(recovery) && op?.item === key && effect?.requests.some((r) => r.id === recovery.request),
        "corrupt", `Recovery question lost its request identity for ${key}`);
    }
    if (item.question?.kind === "pr-closure") requireThat(item.prs.some((p) => p.number === item.question.number)
      && /^[a-f\d]{64}$/.test(item.question.revision) && Number.isFinite(Date.parse(item.question.at)),
      "corrupt", `Closure question lost its PR or issue revision for ${key}`);
    if (item.question?.kind === "issue-closure") requireThat(!item.evidence.own && /^[a-f\d]{64}$/.test(item.question.revision)
      && Number.isFinite(Date.parse(item.question.at)), "corrupt", `Issue closure question lost its revision for ${key}`);
    if (item.question?.kind === "main-failure") {
      const d = item.question.dependency;
      requireThat(object(d) && SHA.test(d.baseSha) && Array.isArray(d.keys) && d.keys.length <= 800 && d.keys.every((k) => /^[a-f0-9]{64}$/.test(k))
        && (d.repairIssue == null || Number.isSafeInteger(d.repairIssue) && d.repairIssue > 0)
        && (d.pr === null && d.headSha === null || item.prs.some((p) => p.number === d.pr) && SHA.test(d.headSha)),
        "corrupt", `Main failure question lost its commits for ${key}`);
    }
    requireThat(item.questionSequence === undefined || integer(item.questionSequence), "corrupt", `Malformed question sequence for ${key}`);
    requireThat(item.respondBaseline === undefined || integer(item.respondBaseline)
      && item.respondBaseline <= Object.values(s.operations).filter((op) => op?.item === key && op.mode === "respond").length,
      "corrupt", `Malformed response baseline for ${key}`);
    if (item.continuation !== undefined) {
      const c = item.continuation, effect = Object.values(item.apiEffects ?? {}).find((e) => e.slot === c?.slot);
      requireThat(object(c) && !item.evidence.own && item.commands[c.commandId]?.issueClosureDecision === "continue"
        && item.commands[c.commandId].controlHandled === true && integer(c.generation) && c.generation <= item.generation
        && /^[a-f\d]{64}$/.test(c.revision) && Number.isFinite(Date.parse(c.createdAt))
        && ["requested", "done", "superseded"].includes(c.phase) && c.slot === `continue:${key}:${c.commandId}`,
        "corrupt", `Malformed issue continuation for ${key}`);
      requireThat(!effect || effect.definition.kind === "issue-reopen" && effect.definition.target === Number(key.split(":")[1])
        && effect.definition.guard?.commandId === c.commandId && effect.definition.guard.generation === c.generation
        && effect.definition.guard.revision === c.revision, "corrupt", `Continuation request targets another decision for ${key}`);
      requireThat(c.phase !== "done" || effect?.status === "applied" && Number.isFinite(Date.parse(c.finishedAt)),
        "corrupt", `Continuation lacks a known reopen outcome for ${key}`);
      requireThat(c.phase !== "superseded" || effect?.status !== "pending" && typeof c.reason === "string" && c.reason.length <= 2000,
        "corrupt", `Continuation lost an uncertain request for ${key}`);
    }
    if (item.restart != null) {
      const r = item.restart;
      requireThat(object(r) && item.commands[r.commandId]?.action === "restart" && integer(r.generation)
        && r.generation <= item.generation && /^[a-f\d]{64}$/.test(r.revision)
        && ["requested", "closing", "ready", "done", "superseded"].includes(r.phase)
        && Number.isFinite(Date.parse(r.createdAt)) && Array.isArray(r.targets) && Array.isArray(r.retire)
        && new Set(r.targets.map((p) => p.number)).size === r.targets.length
        && r.targets.every((p) => item.prs.some((recorded) => recorded.number === p.number) && SHA.test(p.head)
          && typeof p.slot === "string" && p.slot.length <= 1024)
        && r.retire.every((number) => item.prs.some((p) => p.number === number))
        && (r.reopenSlot === null || typeof r.reopenSlot === "string" && r.reopenSlot.length <= 1024), "corrupt", `Malformed restart for ${key}`);
      const effectAt = (slot) => Object.values(item.apiEffects ?? {}).find((e) => e.slot === slot);
      for (const target of r.targets) {
        const e = effectAt(target.slot);
        requireThat(!e || e.definition.kind === "pr-close" && e.definition.target === target.number && e.definition.payload.head === target.head
          && e.definition.guard?.commandId === r.commandId && e.definition.guard.generation === r.generation && e.definition.guard.revision === r.revision,
          "corrupt", `Restart close receipt targets another request: ${key}`);
      }
      const reopened = r.reopenSlot && effectAt(r.reopenSlot);
      requireThat(!reopened || reopened.definition.kind === "issue-reopen" && reopened.definition.target === Number(key.split(":")[1])
        && reopened.definition.guard?.commandId === r.commandId && reopened.definition.guard.generation === r.generation
        && reopened.definition.guard.revision === r.revision, "corrupt", `Restart reopen receipt targets another request: ${key}`);
      requireThat(!["ready", "done"].includes(r.phase) || r.retire.every((number) => item.prs.find((p) => p.number === number).required === false),
        "corrupt", `Restart retired work is still required: ${key}`);
      requireThat(r.phase !== "done" || s.operations[r.operationId]?.item === key && s.operations[r.operationId].mode === "build"
        && s.operations[r.operationId].inputs.includes(r.commandId), "corrupt", `Restart replacement operation is missing: ${key}`);
    }
    requireThat(item.activeOperation === null || (ID.test(item.activeOperation) && own(s.operations, item.activeOperation)
      && s.operations[item.activeOperation].item === key), "corrupt", `Missing active operation for ${key}`);
    const active = Object.values(s.operations).filter((op) => op.item === key && !TERMINAL.has(op.phase));
    requireThat(active.length <= 1 && active.every((op) => op.id === item.activeOperation), "corrupt", `Multiple owners for ${key}`);
    requireThat(item.attempts.every((a) => object(a) && ID.test(a.operation) && own(s.operations, a.operation)
      && s.operations[a.operation].item === key && typeof a.automatic === "boolean"
      && (a.kind === undefined || a.kind === (s.operations[a.operation].mode === "update" ? "api" : "coding")) && Number.isFinite(Date.parse(a.at))), "corrupt", `Malformed budget for ${key}`);
    requireThat(new Set(item.attempts.map((a) => a.operation)).size === item.attempts.length, "corrupt", `Duplicate budget reservations for ${key}`);
    requireThat(new Set(item.prs.map((p) => p.number)).size === item.prs.length && item.prs.every((p) => object(p)
      && Number.isSafeInteger(p.number) && p.number > 0 && typeof p.required === "boolean"
      && ["open", "merged", "closed"].includes(p.state) && typeof p.acceptedClosure === "boolean"
      && (p.state !== "merged" || SHA.test(p.mergedSha))), "corrupt", `Malformed PR membership for ${key}`);
    for (const pr of item.prs) {
      requireThat(!prs.has(pr.number), "corrupt", `PR #${pr.number} belongs to more than one item`);
      prs.add(pr.number);
    }
    for (const pr of item.prs) if (pr.dispositions !== undefined) requireThat(Array.isArray(pr.dispositions)
      && pr.dispositions.every((d) => object(d) && item.commands[d.commandId]?.sourceId === d.sourceId
        && item.commands[d.commandId].revision === d.commandRevision && item.commands[d.commandId].status === "applied"
        && /^[a-f\d]{64}$/.test(d.issueRevision) && Number.isFinite(Date.parse(d.at))),
      "corrupt", `Closure disposition lost its trusted answer for ${key}`);
    if (item.complete) requireThat(item.prs.some((p) => p.required) && item.prs.filter((p) => p.required)
      .every((p) => p.state === "merged" || (p.state === "closed" && p.acceptedClosure)), "corrupt", `Incomplete work marked complete: ${key}`);
  }
  for (const [id, op] of Object.entries(s.operations)) {
    requireThat(ID.test(id) && object(op) && op.id === id && own(s.items, op.item) && PHASES.has(op.phase)
      && MODES.has(op.mode) && integer(op.generation) && Array.isArray(op.effects)
      && SHA.test(op.base?.sha) && validBranch(op.base?.ref) && SHA.test(op.toolingSha) && SHA.test(op.configSha)
      && validBranch(op.target?.branch) && op.target.branch !== op.base.ref && op.target.branch !== "factory-state"
      && (op.target.head === null || SHA.test(op.target.head))
      && (op.target.number === null || (Number.isSafeInteger(op.target.number) && op.target.number > 0
        && s.items[op.item].prs.some((p) => p.number === op.target.number)))
      && /^[0-9a-f]{64}$/.test(op.revision) && object(op.worker)
      && op.worker.workflowPath === ".github/workflows/factory.yml" && SHA.test(op.worker.entrySha), "corrupt", `Malformed operation ${id}`);
    requireThat(op.phase !== "claimed" || op.owner !== null, "corrupt", `Missing owner for ${id}`);
    if (op.abandonedPrepared !== undefined) requireThat(object(op.abandonedPrepared) && op.phase === "superseded" && op.owner === null
      && op.result === null && op.effects.length === 0 && op.dispatch?.attempts.length >= 3
      && ["answer", "respond", "resolve", "update", "build", "restart", "retry"].includes(s.items[op.item].commands[op.abandonedPrepared.commandId]?.action)
      && Number.isFinite(Date.parse(op.abandonedPrepared.at)), "corrupt", `Invalid prepared abandonment for ${id}`);
    requireThat((op.worker.runner === undefined || validRunner(op.worker.runner))
      && (op.worker.model === undefined || typeof op.worker.model === "string" && op.worker.model.length > 0 && op.worker.model.length <= 256)
      && validOperationUsage(op.usage, op), "corrupt", `Malformed usage for ${id}`);
    requireThat(op.publishStartedAt === undefined || Number.isFinite(Date.parse(op.publishStartedAt)), "corrupt", `Invalid publication start for ${id}`);
    requireThat(op.publishError === undefined || object(op.publishError) && op.effects.some((e) => e.id === op.publishError.effect)
      && typeof op.publishError.reason === "string" && op.publishError.reason.length > 0 && op.publishError.reason.length <= 2000
      && Number.isFinite(Date.parse(op.publishError.at)), "corrupt", `Invalid publication error for ${id}`);
    requireThat(validFailureContext(op.failureContext, op), "corrupt", `Failure evidence does not match operation ${id}`);
    requireThat(!["result-ready", "publishing", "done"].includes(op.phase) || (op.result !== null && op.owner?.status === "completed"), "corrupt", `Missing terminal result for ${id}`);
    requireThat(op.generation <= s.items[op.item].generation
      && s.items[op.item].attempts.filter((a) => a.operation === id).length === 1,
      "corrupt", `Missing budget reservation or future generation for ${id}`);
    requireThat(Array.isArray(op.feedbackInputs ?? []) && (op.feedbackInputs ?? []).every((f) =>
      /^(issue-comment|review-comment|review|check|status):[1-9]\d*$/.test(f.sourceId) && /^[a-f\d]{64}$/.test(f.revision)),
      "corrupt", `Invalid feedback inputs for ${id}`);
    requireThat(Array.isArray(op.incorporatedFeedback ?? []) && (op.incorporatedFeedback ?? []).every((f) =>
      /^(issue-comment|review-comment|review|check|status):[1-9]\d*$/.test(f.sourceId) && /^[a-f\d]{64}$/.test(f.revision)), "corrupt", `Invalid incorporated feedback for ${id}`);
    requireThat(Array.isArray(op.threadTargets ?? []) && new Set((op.threadTargets ?? []).map((t) => t.id)).size === (op.threadTargets ?? []).length
      && (op.threadTargets ?? []).every((t) => nodeId(t.id) && /^[a-f\d]{64}$/.test(t.revision) && Array.isArray(t.anchors) && t.anchors.length
        && t.anchors.every((a) => /^review-comment:[1-9]\d*$/.test(a.sourceId) && /^[a-f\d]{64}$/.test(a.revision))), "corrupt", `Invalid thread targets for ${id}`);
    requireThat(!(s.items[op.item].evidence.own && op.effects.some((e) => ["attachment", "thread-reply", "thread-resolve"].includes(e.type))),
      "corrupt", `Own-PR maintenance cannot change review threads: ${id}`);
    requireThat(Array.isArray(op.inputs ?? []) && (op.inputs ?? []).every((id) => s.items[op.item].commands[id]?.operation === op.id),
      "corrupt", `Missing operation input for ${id}`);
    if (op.owner !== null) {
      runIdentity(op.owner);
      requireThat(["queued", "in_progress", "completed"].includes(op.owner.status), "corrupt", `Invalid owner status for ${id}`);
    }
    requireThat(new Set(op.effects.map((e) => e.id)).size === op.effects.length, "corrupt", `Duplicate effects for ${id}`);
    for (const effect of op.effects) {
      requireThat(validEffect(effect, op) && (effect.type !== "attachment" || effect.repositoryId === s.repositoryId)
        && ["prepared", "pending", "applied", "rejected"].includes(effect.status)
        && Array.isArray(effect.requests) && effect.requests.every((r, n) => r.id === `${id}/${effect.id}/${n + 1}`
          && integer(r.generation) && object(r.publisher) && typeof r.publisher.id === "string"
          && /^[1-9]\d*$/.test(r.publisher.id) && Number.isSafeInteger(r.publisher.attempt)
          && r.publisher.attempt > 0 && Number.isFinite(Date.parse(r.at)))
        && (effect.status === "prepared" || effect.requests.length > 0)
        && (effect.status !== "prepared" || effect.requests.length === 0)
        && (effect.status !== "applied" || validReceipt(effect, effect.receipt)), "corrupt", `Malformed publish effect ${id}`);
      requireThat(effect.status !== "pending" || op.phase === "publishing", "corrupt", `Unresolved write lost ownership: ${id}`);
      if (effect.lastRejection !== undefined) requireThat(object(effect.lastRejection)
        && (effect.lastRejection.kind === "git-rejection" || effect.lastRejection.kind === "http-rejection"
          && [400, 401, 403, 404, 409, 410, 413, 415, 422].includes(effect.lastRejection.status))
        && effect.requests.some((r) => r.id === effect.lastRejection.requestId) && Number.isFinite(Date.parse(effect.lastRejection.at)),
        "corrupt", `Invalid publish rejection receipt for ${id}`);
    }
    requireThat(!TERMINAL.has(op.phase) || op.effects.every((e) => e.status !== "pending"), "corrupt", `Terminal operation has an uncertain write: ${id}`);
    if (op.result !== null) requireThat(op.result.operationId === id && sameRun(op.result.run, op.owner), "corrupt", `Result owner mismatch: ${id}`);
  }
  return s;
}

export function evolve(ledger, key, event) {
  event = structuredClone(event);
  validateLedger(ledger);
  requireThat(own(ledger.items, key), "missing", `Unknown work item ${key}`);
  const s = structuredClone(ledger);
  const item = s.items[key];
  const current = () => {
    const op = s.operations[item.activeOperation];
    requireThat(op && op.id === event.operationId, "stale", "The operation is not this item's active operation");
    return op;
  };
  const finish = () => validateLedger(s);
  const isCurrent = (op, observation, { base = false, head = op.target.head } = {}) => !item.paused && !item.complete && !item.question && item.continuation?.phase !== "requested"
    && op.generation === item.generation && op.revision === item.revision
    && observation.authorization?.valid === true && observation.authorization.revision === item.revision
    && observation.head === head && observation.open === true
    && (!base || observation.baseSha === op.base.sha);

  switch (event.type) {
    case "record-routing-usage": {
      const command = item.commands[event.commandId], n = event.attempt - 1;
      requireThat(command && Number.isSafeInteger(n) && n >= 0 && n < command.routingAttempts?.length
        && validRouterUsage(event.usage), "invalid", "Usage needs its reserved routing request");
      const previous = command.routingUsage?.[n];
      requireThat(!previous || event.usage.model === previous.model, "invalid", "Routing usage model changed");
      if (previous?.status !== "unknown" && previous !== undefined) {
        requireThat(JSON.stringify(previous) === JSON.stringify(event.usage), "stale", "Measured routing usage cannot be replaced");
        return ledger;
      }
      command.routingUsage ??= command.routingAttempts.map(() => ({ source: "responses-api", status: "unknown", model: "unknown", tokens: null, responseId: null }));
      command.routingUsage[n] = event.usage;
      break;
    }
    case "usage-inspection":
    case "record-execution":
    case "record-model-usage": {
      // History remains chargeable after stop/restart/completion. Recording a
      // measurement grants no work or publication authority to the old run.
      const op = s.operations[event.operationId];
      requireThat(op?.item === key && op.owner && sameRun(op.owner, event.run), "stale", "Usage belongs to another operation owner");
      op.usage ??= {};
      if (event.type === "usage-inspection") {
        const at = time(event.at), attempts = (op.usage.collection?.attempts ?? 0) + 1;
        requireThat(!op.usage.collection || Date.parse(at) >= Date.parse(op.usage.collection.nextAt), "waiting", "Usage inspection is not due");
        op.usage.collection = { attempts, at, nextAt: new Date(Date.parse(at) + Math.min(1440, 5 * 2 ** Math.min(attempts - 1, 9)) * 60000).toISOString(),
          reason: "Uncollected measurements remain unknown" };
      } else if (event.type === "record-execution") {
        requireThat(validExecution(event.usage, op), "invalid", "Execution measurement is invalid");
        requireThat(!op.usage.execution || JSON.stringify(op.usage.execution) === JSON.stringify(event.usage), "stale", "Measured execution cannot be replaced");
        op.usage.execution = event.usage;
      } else {
        const a = event.artifact;
        requireThat(op.mode !== "update" && object(a) && !a.expired && a.repositoryId === s.repositoryId && sameRun(op.owner, a.run)
          && a.workflowPath === op.worker.workflowPath && a.headSha === op.worker.entrySha && typeof a.id === "string" && /^[1-9]\d*$/.test(a.id)
          && /^sha256:[0-9a-f]{64}$/.test(a.digest) && (op.owner.status === "completed" || op.usage.execution),
          "provenance", "Usage artifact does not match its recorded owner");
        const model = workerUsage(event.metrics, op.worker.model ?? "unknown");
        requireThat(!op.usage.model || JSON.stringify(op.usage.model) === JSON.stringify(model), "stale", "Measured model usage cannot be replaced");
        op.usage.model = model;
        op.usage.modelArtifact = { id: a.id, digest: a.digest };
      }
      break;
    }
    case "sync-api-alerts":
      requireThat(Number.isSafeInteger(event.timeoutMinutes) && event.timeoutMinutes >= 1 && event.timeoutMinutes <= 1440,
        "invalid", "API recovery alerts need a bounded deadline");
      syncApiAlerts(item, time(event.at), event.timeoutMinutes);
      break;
    case "publication-observed": {
      const op = current();
      requireThat(op.phase === "publishing", "phase", "Only a publishing operation needs a recovery start time");
      op.publishStartedAt ??= time(event.at);
      break;
    }
    case "publish-blocked": {
      const op = current();
      requireThat(op.phase === "publishing" && op.effects.some((e) => e.id === event.effectId && ["prepared", "rejected"].includes(e.status))
        && typeof event.reason === "string" && event.reason.length > 0 && event.reason.length <= 2000,
        "invalid", "A publish validation error needs an unsubmitted effect and a bounded reason");
      if (op.publishError?.effect === event.effectId && op.publishError.reason === event.reason) return ledger;
      op.publishError = { effect: event.effectId, reason: event.reason, at: time(event.at) };
      break;
    }
    case "admit-request": {
      const command = item.commands[event.commandId], auth = event.authorization;
      requireThat(item.requestOnly && command?.status === "queued"
        && (item.evidence.own ? ["update", "resolve"] : ["build", "restart"]).includes(command.action),
        "invalid", "A pending request needs an authorized work action");
      requireThat(auth?.valid === true && /^[a-f\d]{64}$/.test(auth.revision) && auth.evidence?.sourceId === command.sourceId
        && auth.evidence.revision === command.revision && auth.evidence.actor === command.author
        && Boolean(auth.evidence.own) === Boolean(item.evidence.own), "invalid", "Admission must match a fresh trusted source");
      requireThat(command.routed ? auth.evidence.kind === "routed-command" && auth.evidence.action === command.action
        : ["command", "label"].includes(auth.evidence.kind), "invalid", "The source does not authorize this action");
      item.evidence = { ...auth.evidence, ...(!item.evidence.own ? { producer: auth.producer ?? null } : {}) };
      item.revision = auth.revision; item.requestOnly = false; item.question = null;
      break;
    }
    case "reserve": {
      const at = time(event.at);
      requireThat(ID.test(event.id) && MODES.has(event.mode), "invalid", "Invalid operation ID or mode");
      // Re-delivery of a command or a lost transaction response cannot charge
      // the budget twice, including when that operation is already terminal.
      if (own(s.operations, event.id)) {
        requireThat(s.operations[event.id].item === key, "invalid", "Operation ID belongs to another item");
        return ledger;
      }
      const previous = s.operations[item.activeOperation];
      requireThat(!previous || TERMINAL.has(previous.phase), "busy", "The previous operation is not resolved");
      requireThat(!item.requestOnly && !item.paused && !item.complete && !item.question && item.continuation?.phase !== "requested",
        "waiting", "The item is not admitted, is paused, complete or waiting for an answer or issue reopening");
      const automatic = event.automatic !== false;
      const day = new Date(at).toISOString().slice(0, 10);
      const kind = event.mode === "update" ? "api" : "coding";
      const spent = item.attempts.filter((a) => a.automatic && (a.kind ?? "coding") === kind && new Date(a.at).toISOString().startsWith(day)).length;
      const limit = event.limit ?? (kind === "api" ? 30 : 3);
      requireThat(Number.isSafeInteger(limit) && limit >= 0, "invalid", "Invalid attempt limit");
      requireThat(!automatic || spent < limit, "budget", "Automatic attempt budget exhausted");
      requireThat(event.revision === item.revision, "stale", "Issue revision changed before reservation");
      const inputs = event.commandIds ?? [];
      requireThat(Array.isArray(inputs) && new Set(inputs).size === inputs.length && inputs.every((id) =>
        item.commands[id]?.status === "queued" && ["answer", "respond", "resolve", "update", "build", "restart", "retry"].includes(item.commands[id].action)),
        "invalid", "Operation inputs must be pending authorized work requests");
      requireThat(automatic || inputs.length > 0, "invalid", "An explicit attempt needs its authorizing command");
      s.operations[event.id] = { id: event.id, item: key, phase: "prepared", generation: item.generation,
        revision: item.revision, mode: event.mode, target: event.target, base: event.base,
        toolingSha: event.toolingSha, configSha: event.configSha, createdAt: at,
        worker: { workflowPath: ".github/workflows/factory.yml", entrySha: event.configSha,
          runner: event.mode === "update" ? "ubuntu-24.04" : event.runner ?? "crew-l", model: event.model ?? "unknown" },
        owner: null, result: null, effects: [], failure: null, inputs, feedbackInputs: event.feedbackInputs ?? [] };
      s.operations[event.id].threadTargets = event.threadTargets ?? [];
      if (event.failureContext !== undefined) s.operations[event.id].failureContext = event.failureContext;
      item.activeOperation = event.id;
      if (item.evidence.own) item.maintenanceComplete = false;
      item.attempts.push({ operation: event.id, automatic, kind, at });
      for (const id of inputs) { item.commands[id].status = "reserved"; item.commands[id].operation = event.id; }
      if (item.restart?.phase === "ready" && event.mode === "build" && inputs.includes(item.restart.commandId)) {
        item.restart.phase = "done"; item.restart.operationId = event.id;
      }
      break;
    }
    case "begin-restart": {
      const command = item.commands[event.commandId];
      requireThat(!item.requestOnly && !item.evidence.own && command?.status === "queued" && command.action === "restart", "invalid", "Restart needs an explicit queued request on an admitted issue");
      if (item.restart?.commandId === command.id) return ledger;
      requireThat(!item.restart || ["done", "superseded"].includes(item.restart.phase), "busy", "The previous restart must be recovered first");
      item.generation++; item.paused = false; item.question = null; item.complete = false;
      item.restart = { commandId: command.id, generation: item.generation, revision: item.revision,
        phase: "requested", createdAt: time(event.at), targets: [], retire: [], reopenSlot: null };
      break;
    }
    case "plan-restart": {
      const r = item.restart, op = s.operations[item.activeOperation];
      requireThat(r?.commandId === event.commandId && r.phase === "requested" && (!op || TERMINAL.has(op.phase)), "busy", "Recover the worker and publication before planning restart effects");
      requireThat(item.continuation?.phase !== "requested", "busy", "Recover the issue continuation before restarting");
      requireThat(!item.paused && r.generation === item.generation && r.revision === item.revision
        && item.commands[r.commandId].status === "queued", "stale", "Restart intent changed");
      requireThat(Array.isArray(event.targets) && Array.isArray(event.retire)
        && event.retire.length === item.prs.length && item.prs.every((p) => event.retire.includes(p.number)), "invalid", "Restart must account for every recorded PR");
      r.targets = event.targets; r.retire = event.retire; r.reopenSlot = event.reopenSlot ?? null; r.phase = "closing";
      break;
    }
    case "finish-restart": {
      const r = item.restart;
      requireThat(r?.commandId === event.commandId && r.phase === "closing" && !item.paused
        && r.generation === item.generation && r.revision === item.revision && item.commands[r.commandId].status === "queued", "stale", "Restart is no longer current");
      const applied = (slot) => Object.values(item.apiEffects ?? {}).some((e) => e.slot === slot && e.status === "applied");
      requireThat(r.targets.every((p) => applied(p.slot)) && (!r.reopenSlot || applied(r.reopenSlot))
        && r.retire.every((number) => item.prs.find((p) => p.number === number)?.state !== "open"), "pending", "All restart effects and final PR states must be known");
      for (const pr of item.prs.filter((p) => r.retire.includes(p.number))) {
        pr.required = false;
        if (pr.state === "closed") pr.acceptedClosure = true;
        pr.dispositionSource = item.commands[r.commandId].sourceId;
      }
      item.complete = false; item.question = null; item.revisionPending = true; item.handover = null;
      item.respondBaseline = Object.values(s.operations).filter((op) => op.item === key && op.mode === "respond").length;
      r.phase = "ready";
      break;
    }
    case "abandon-restart": {
      const r = item.restart;
      requireThat(r?.commandId === event.commandId && !["done", "superseded"].includes(r.phase), "invalid", "No unfinished restart");
      requireThat(!Object.values(item.apiEffects ?? {}).some((e) => e.definition.guard?.commandId === r.commandId
        && ["pr-close", "issue-reopen"].includes(e.definition.kind) && e.status === "pending"), "pending", "Recover uncertain restart effects before replacement work");
      r.phase = "superseded"; r.failure = String(event.reason ?? "Restart intent changed").slice(0, 16000);
      if (item.commands[r.commandId].status === "queued") item.commands[r.commandId].status = "superseded";
      break;
    }
    case "claim": {
      const op = current();
      const run = runIdentity(event.run);
      requireThat(event.provenance?.repositoryId === s.repositoryId && event.provenance?.workflowPath === op.worker.workflowPath
        && event.provenance?.headSha === op.worker.entrySha, "provenance", "Worker entry is not the recorded default-branch workflow");
      if (op.phase === "claimed" && sameRun(op.owner, run)) return ledger;
      requireThat(op.phase === "prepared" && op.owner === null, "claimed", "Operation already has an owner");
      requireThat(isCurrent(op, event.observation), "stale", "Work is no longer authorized or current");
      op.owner = { ...run, status: "queued", conclusion: null };
      op.phase = "claimed";
      break;
    }
    case "dispatch-request":
    case "cancel-request": {
      const op = current();
      const dispatch = event.type === "dispatch-request";
      requireThat(dispatch ? op.phase === "prepared" : (op.phase === "claimed" && op.owner?.status !== "completed"),
        "phase", "The operation is not eligible for this API request");
      const name = dispatch ? "dispatch" : "cancel";
      const record = op[name] ??= { attempts: [], nextAt: null };
      const at = time(event.at);
      requireThat(record.attempts.length < 3, "budget", "API request budget exhausted");
      requireThat(!record.nextAt || Date.parse(at) >= Date.parse(record.nextAt), "waiting", "API request backoff is not over");
      record.attempts.push({ at });
      record.nextAt = new Date(Date.parse(at) + (dispatch ? 5 : 1) * 60000).toISOString();
      break;
    }
    case "owner-observed": {
      const op = current();
      requireThat(sameRun(op.owner, event.run), "stale", "Run observation is not for the recorded owner");
      requireThat(["queued", "in_progress", "completed"].includes(event.status), "invalid", "Unknown run status");
      if (op.owner.status === "completed") {
        requireThat(event.status === "completed" && event.conclusion === op.owner.conclusion, "stale", "Terminal run cannot become active again");
        return ledger;
      }
      requireThat(!(op.owner.status === "in_progress" && event.status === "queued"), "stale", "Outdated queued observation");
      op.owner.status = event.status;
      if (event.status === "in_progress" && !op.owner.startedAt) op.owner.startedAt = time(event.startedAt ?? event.at);
      op.owner.conclusion = event.status === "completed" ? event.conclusion : null;
      break;
    }
    case "hand-over":
      requireThat(item.prs.some((p) => p.number === event.number && p.state === "open") && SHA.test(event.head),
        "invalid", "Handover needs an open recorded PR and current head");
      item.handoverAt = time(event.at);
      item.handover = { pr: event.number, head: event.head, at: item.handoverAt };
      item.respondBaseline = Object.values(s.operations).filter((op) => op.item === key && op.mode === "respond").length;
      if (item.evidence.own) item.maintenanceComplete = true;
      break;
    case "select-integration": {
      requireThat(!s.integration || (s.integration.item === key && s.integration.pr === event.number), "busy", "Another PR is selected for integration");
      requireThat(item.prs.some((p) => p.number === event.number && p.state === "open"), "invalid", "Integration target is not an open recorded PR");
      s.integration ??= { item: key, pr: event.number, selectedAt: time(event.at), deadline: time(event.deadline) };
      break;
    }
    case "release-integration":
      requireThat(s.integration?.item === key, "invalid", "This item does not own the integration selection");
      s.integration = null;
      break;
    case "set-status": {
      const status = event.status;
      requireThat(status && typeof status.state === "string" && /^agent-[a-z-]+$/.test(status.state)
        && typeof status.reason === "string" && status.reason.length <= 16000 && typeof status.next === "string", "invalid", "Invalid status projection");
      item.status = status;
      break;
    }
    case "ask": {
      requireThat(typeof event.reason === "string" && event.reason.length > 0 && event.reason.length <= 16000, "invalid", "A concrete question is required");
      item.questionSequence = (item.questionSequence ?? 0) + 1;
      requireThat(event.kind === undefined || ["completion-revision", "publish-outcome", "pr-closure", "issue-closure", "main-failure"].includes(event.kind), "invalid", "Unknown question kind");
      if (event.kind === "publish-outcome") {
        const op = s.operations[event.recovery?.operation], effect = op?.effects.find((e) => e.id === event.recovery.effect);
        requireThat(op?.item === key && op.id === item.activeOperation && op.phase === "publishing" && effect?.status === "pending"
          && effect.requests.at(-1)?.id === event.recovery.request, "invalid", "Recovery must identify the exact uncertain publish request");
      }
      if (event.kind === "pr-closure") requireThat(!item.evidence.own && item.prs.some((p) => p.number === event.number
        && p.required && p.state === "closed" && !p.acceptedClosure), "invalid", "A closure question needs unaccounted required work");
      if (event.kind === "issue-closure") requireThat(!item.requestOnly && !item.evidence.own, "invalid", "Only an admitted issue can have an issue closure question");
      item.question = { id: createHash("sha256").update(`${key}:${item.generation}:${item.questionSequence}:${event.reason}`).digest("hex"),
        reason: event.reason, kind: event.kind ?? null, at: event.at ? time(event.at) : null,
        ...(event.kind === "publish-outcome" ? { recovery: event.recovery } : {}),
        ...(event.kind === "pr-closure" ? { number: event.number, revision: item.revision } : {}),
        ...(event.kind === "issue-closure" ? { revision: item.revision } : {}),
        ...(event.kind === "main-failure" ? { dependency: event.dependency } : {}) };
      if (event.consumeCommand) {
        requireThat(item.commands[event.consumeCommand]?.status === "queued", "invalid", "Only a queued request can require clarification");
        item.commands[event.consumeCommand].status = "applied";
        item.commands[event.consumeCommand].clarification = event.reason;
      }
      for (const command of Object.values(item.commands)) if (command.action === "clarify" && command.status === "queued") command.status = "applied";
      break;
    }
    case "register-main-repair": {
      const r = event.registration;
      requireThat(r?.revision === item.revision && r.sourceId === item.evidence.sourceId && !item.evidence.own && !item.requestOnly && !item.complete
        && Array.isArray(r.keys) && r.keys.length > 0 && r.keys.length <= 800
        && event.authorization?.valid === true && event.authorization.revision === item.revision,
        "invalid", "Main repair registration needs current admitted issue authority");
      const old = item.mainRepair, same = old?.baseSha === r.baseSha && old.revision === r.revision && old.sourceId === r.sourceId;
      const keys = same ? [...new Set([...old.keys, ...r.keys])].sort() : r.keys;
      const next = { ...r, keys, digest: diagnosticHash([r.baseSha, keys]), at: same ? old.at : time(event.at) };
      requireThat(validMainRepair({ ...item, mainRepair: next }), "invalid", "Invalid main repair diagnostic evidence");
      item.mainRepair = next;
      break;
    }
    case "resolve-main-question": {
      const q = item.question, main = event.main, pr = item.prs.find((p) => p.number === q?.dependency?.pr);
      const repair = event.repairKey && s.items[event.repairKey];
      requireThat(q?.kind === "main-failure" && (event.outcome === "main-green" && main?.checks?.state === "success"
        && SHA.test(main.sha) && main.checks.headSha === main.sha
        || event.outcome === "base-moved" && SHA.test(main?.sha) && main.sha !== q.dependency.baseSha
        || event.outcome === "pr-changed" && pr && (pr.state !== "open" || SHA.test(event.headSha) && event.headSha !== q.dependency.headSha)
        || event.outcome === "repair-admitted" && repair && event.repairAuthorization?.valid === true
          && event.repairAuthorization.revision === repair.revision && event.repairKey !== key && !repair.complete && !repair.evidence.own && !repair.requestOnly
          && (event.repairBase === q.dependency.baseSha || repair.mainRepair?.revision === repair.revision
            && q.dependency.keys.length > 0 && q.dependency.keys.every((k) => repair.mainRepair.keys.includes(k)))),
        "pending", "Only a known change to this main dependency can settle its question");
      item.lastQuestion = { ...q, resolution: event.outcome, resolvedAt: time(event.at) }; item.question = null;
      if (event.consumeCommand) {
        const command = item.commands[event.consumeCommand];
        requireThat(command?.status === "queued" && command.action === "answer", "invalid", "Only the pending dependency answer can be consumed");
        command.status = "applied"; command.mainAnswer = "The dependency was rechecked; continuing from its current CI and repair state.";
      }
      break;
    }
    case "answer-issue-closure": {
      const command = item.commands[event.commandId], op = s.operations[item.activeOperation];
      const decision = issueClosureChoice(command, item);
      requireThat(!item.requestOnly && !item.evidence.own && command?.status === "queued" && decision && decision === event.decision,
        "invalid", "The issue closure answer must identify its current question and revision");
      if (decision === "continue") {
        requireThat(!item.complete && (!item.continuation || item.continuation.phase !== "requested") && op?.phase !== "publishing",
          "busy", "Recover earlier publication and continuation before reopening the issue");
        requireThat(event.authorization?.valid === true && event.authorization.revision === item.revision,
          "invalid", "Continuing needs fresh authorization for the current issue revision");
        item.continuation = { commandId: command.id, generation: item.generation, revision: item.revision,
          createdAt: time(event.at), slot: `continue:${key}:${command.id}`, phase: "requested" };
        item.paused = false;
      } else {
        if (!item.paused) item.generation++;
        item.paused = true; command.status = "applied";
      }
      command.issueClosureDecision = decision; command.controlHandled = true;
      for (const older of Object.values(item.commands)) if (older.status === "queued" && older.id !== command.id
        && ["route", "answer", "respond", "resolve", "update", "build", "restart", "retry"].includes(older.action)
        && compareRequests(older, command) < 0) older.status = "superseded";
      item.lastQuestion = { ...(item.question ?? item.lastQuestion), resolution: decision, resolvedAt: time(event.at) };
      item.question = null;
      break;
    }
    case "finish-continuation": {
      const c = item.continuation, effect = Object.values(item.apiEffects ?? {}).find((e) => e.slot === c?.slot);
      requireThat(c?.commandId === event.commandId && c.phase === "requested" && effect?.status === "applied" && event.issueOpen === true,
        "pending", "Observe the reopened issue and its receipt before continuing work");
      c.phase = "done"; c.finishedAt = time(event.at);
      item.commands[c.commandId].issueClosureOutcome = "done";
      if (item.commands[c.commandId].status === "queued") item.commands[c.commandId].status = "applied";
      break;
    }
    case "abandon-continuation": {
      const c = item.continuation, effect = Object.values(item.apiEffects ?? {}).find((e) => e.slot === c?.slot);
      requireThat(c?.commandId === event.commandId && c.phase === "requested", "invalid", "No unfinished issue continuation");
      requireThat(effect?.status !== "pending", "pending", "Recover the unknown reopen request before replacing its continuation");
      requireThat(typeof event.reason === "string" && event.reason.length > 0 && event.reason.length <= 2000, "invalid", "A continuation failure needs a concrete reason");
      c.phase = "superseded"; c.reason = event.reason;
      item.commands[c.commandId].issueClosureOutcome = "superseded";
      item.commands[c.commandId].issueClosureReason = event.reason;
      if (item.commands[c.commandId].status === "queued") item.commands[c.commandId].status = "applied";
      break;
    }
    case "complete-issue-answer": {
      const command = item.commands[event.commandId];
      requireThat(command?.status === "queued" && command.action === "answer"
        && item.prs.some((p) => p.required) && item.prs.filter((p) => p.required).every((p) => p.state === "merged" || p.state === "closed" && p.acceptedClosure),
        "incomplete", "The closure answer is obsolete only after all required work is accounted for");
      command.status = "applied";
      command.clarification = "All recorded work has finished; no issue reopening is needed. Use /agent restart for replacement work.";
      break;
    }
    case "resolve-publish-question": {
      const question = item.question, op = current();
      const effect = op.effects.find((e) => e.id === question?.recovery?.effect);
      requireThat(question?.kind === "publish-outcome" && question.recovery.operation === op.id
        && effect?.requests.some((r) => r.id === question.recovery.request) && ["applied", "rejected"].includes(effect.status),
        "pending", "Only a verified outcome can resolve an uncertain publish question");
      item.lastQuestion = { ...question, resolvedAt: time(event.at), resolution: "publish-outcome-observed" };
      item.question = null;
      break;
    }
    case "accept-completion": {
      const command = item.commands[event.commandId];
      const text = command ? answerText(command).toLowerCase() : "";
      requireThat(command?.status === "queued" && command.action === "answer" && ["accept-completion", "1"].includes(text),
        "invalid", "Completion acceptance needs an explicit pending answer");
      requireThat(text !== "1" || event.questionKind === "completion-revision", "invalid", "A numbered answer needs the completion question");
      requireThat(event.authorization?.valid === true && /^[a-f\d]{64}$/.test(event.authorization.revision)
        && item.prs.some((p) => p.required) && item.prs.filter((p) => p.required).every((p) => p.state === "merged" || p.state === "closed" && p.acceptedClosure),
        "invalid", "Only fully accounted work and a fresh accepted revision can complete");
      item.completionAcceptance = { sourceId: command.sourceId, revision: event.authorization.revision, at: time(event.at) };
      item.revision = event.authorization.revision; item.revisionPending = false; item.generation++; item.question = null;
      command.status = "applied";
      break;
    }
    case "stop":
    case "revise": {
      if (event.type === "stop" && item.paused) return ledger;
      if (event.type === "revise") {
        requireThat(/^[0-9a-f]{64}$/.test(event.revision), "invalid", "Invalid revised issue fingerprint");
        if (item.revision === event.revision) return ledger;
        item.revision = event.revision;
        item.revisionPending = true;
      } else item.paused = true;
      item.generation++;
      break;
    }
    case "resume":
      item.paused = false;
      if (event.answerSource) {
        if (item.question?.kind === "publish-outcome") {
          const recovery = item.question.recovery, effect = s.operations[recovery.operation]?.effects.find((e) => e.id === recovery.effect);
          if (effect?.status === "pending") break;
        }
        if (item.question) item.lastQuestion = structuredClone(item.question);
        item.question = null;
      }
      break;
    case "collect-result": {
      const op = current();
      const p = event.proposal, a = event.artifact;
      requireThat(op.phase === "claimed" && op.owner?.status === "completed", "busy", "Worker must be terminal before result acceptance");
      requireThat(object(a) && !a.expired && a.repositoryId === s.repositoryId && sameRun(op.owner, a.run)
        && a.workflowPath === op.worker.workflowPath && a.headSha === op.worker.entrySha
        && typeof a.id === "string" && /^[1-9]\d*$/.test(a.id)
        && /^sha256:[0-9a-f]{64}$/.test(a.digest), "provenance", "Artifact provenance does not match the recorded owner");
      requireThat(p?.schemaVersion === SCHEMA && p.operationId === op.id && sameRun(p.run, op.owner)
        && ["ready", "needs-you", "no-change", "failed"].includes(p.outcome)
        && Array.isArray(p.effects) && p.effects.length <= 1, "invalid-result", "Invalid worker proposal");
      requireThat(p.outcome === "ready" || p.effects.length === 0, "invalid-result", "Only a ready proposal can request a code push");
      requireThat(p.outcome !== "needs-you" || typeof p.reason === "string" && p.reason.trim().length > 0,
        "invalid-result", "A needs-you result requires a concrete question");
      op.effects = p.effects.map((e) => {
        requireThat(e.id === "push" && e.type === "push" && e.branch === op.target.branch
          && e.expectedHead === op.target.head && SHA.test(e.commit) && e.baseSha === op.base.sha,
        "invalid-result", "Proposal pushes outside the recorded branch or base");
        return { id: e.id, type: e.type, branch: e.branch, expectedHead: e.expectedHead,
          commit: e.commit, baseSha: e.baseSha, status: "prepared", requests: [], receipt: null };
      });
      let attachments;
      try {
        const manifest = attachmentManifest(p.attachments);
        const body = op.mode === "build" && p.outcome === "ready" && op.effects.length ? p.pullRequest?.body : "";
        attachments = referencedAttachments([body, ...(Array.isArray(p.replies) ? p.replies.map((r) => r?.body) : [])].filter(Boolean).join("\n"), manifest);
      } catch { throw new ProtocolError("invalid-result", "Screenshot references need a bounded, verified attachment manifest"); }
      requireThat(!attachments.length || !item.evidence.own && ["ready", "no-change"].includes(p.outcome), "invalid-result", "Screenshot publication exceeds the assigned work");
      let dependency = op.effects[0]?.id ?? null;
      for (const attachment of attachments) {
        const id = `attachment-${attachment.digest.slice(7)}`;
        op.effects.push({ id, type: "attachment", ...attachmentDescriptor(attachment), repositoryId: s.repositoryId,
          commit: op.effects[0]?.commit ?? op.target.head, dependsOn: dependency, status: "prepared", requests: [], receipt: null });
        dependency = id;
      }
      if (op.mode === "build" && op.target.number === null && p.outcome === "ready" && op.effects.length) {
        let prose;
        try { prose = pullRequestText(p.pullRequest); }
        catch { throw new ProtocolError("invalid-result", "Invalid pull request prose"); }
        op.effects.push({ id: "pull-request", type: "pull-request", head: op.target.branch, base: op.base.ref,
          commit: op.effects[0].commit, dependsOn: dependency, ...prose, status: "prepared", requests: [], receipt: null });
      }
      const replies = p.replies ?? [];
      requireThat(Array.isArray(replies) && replies.length <= 50 && (!replies.length || !item.evidence.own
        && ["respond", "resolve"].includes(op.mode) && ["ready", "no-change"].includes(p.outcome)), "invalid-result", "Thread replies exceed the assigned operation");
      const threadSources = new Set((op.threadTargets ?? []).flatMap((t) => t.anchors.map((a) => a.sourceId)));
      const seen = new Set(), allFeedback = new Map((op.feedbackInputs ?? []).map((f) => [f.sourceId, f]));
      const accepted = new Map((op.feedbackInputs ?? []).filter((f) => !threadSources.has(f.sourceId)).map((f) => [f.sourceId, f]));
      for (const proposed of replies) {
        let reply;
        try { reply = replyProposal(proposed); } catch { throw new ProtocolError("invalid-result", "Invalid thread reply"); }
        const target = op.threadTargets?.find((t) => t.id === reply.thread);
        const facts = (event.feedback ?? []).filter((f) => f.target === op.target.number && f.thread === reply.thread);
        requireThat(target && !seen.has(reply.thread) && reply.revision === threadRevision(facts)
          && target.anchors.every((a) => facts.some((f) => f.sourceId === a.sourceId && ["instruction", "signal"].includes(f.authority))),
          "invalid-result", "Reply targets an unassigned or changed review thread");
        seen.add(reply.thread);
        target.revision = reply.revision;
        for (const anchor of target.anchors) {
          anchor.revision = facts.find((f) => f.sourceId === anchor.sourceId).revision;
          if (allFeedback.has(anchor.sourceId)) allFeedback.set(anchor.sourceId, { sourceId: anchor.sourceId, revision: anchor.revision });
        }
        for (const fact of facts.filter((f) => ["instruction", "signal"].includes(f.authority) && f.requiresResponse && !f.command)) {
          accepted.set(fact.sourceId, { sourceId: fact.sourceId, revision: fact.revision });
          allFeedback.set(fact.sourceId, { sourceId: fact.sourceId, revision: fact.revision });
        }
        const push = op.effects.find((e) => e.type === "push"), commit = push?.commit ?? op.target.head;
        const id = threadEffectId("reply", reply.thread);
        op.effects.push({ id, type: "thread-reply", thread: reply.thread, revision: reply.revision, number: op.target.number,
          body: reply.body, commit, dependsOn: dependency, status: "prepared", requests: [], receipt: null });
        if (reply.resolve) op.effects.push({ id: threadEffectId("resolve", reply.thread), type: "thread-resolve", thread: reply.thread,
          revision: reply.revision, number: op.target.number, commit, dependsOn: id, status: "prepared", requests: [], receipt: null });
      }
      op.feedbackInputs = [...allFeedback.values()];
      op.incorporatedFeedback = [...accepted.values()];
      op.result = { operationId: op.id, run: runIdentity(p.run), outcome: p.outcome,
        reason: String(p.reason ?? "").slice(0, 16000), artifact: { id: a.id, digest: a.digest } };
      if (op.mode !== "update") {
        (op.usage ??= {}).model = workerUsage(p.metrics, op.worker.model ?? "unknown");
        op.usage.modelArtifact = { id: a.id, digest: a.digest };
      }
      op.phase = "result-ready";
      break;
    }
    case "recover-worker": {
      const op = current();
      requireThat(op.phase === "claimed" && op.owner?.status === "completed", "busy", "Do not retry a queued or unobserved owner");
      requireThat(event.resultAbsent === true, "unknown", "A result must be inspected before retrying");
      op.phase = "failed";
      op.failure = event.reason ?? "Worker ended without a usable result";
      for (const id of op.inputs ?? []) item.commands[id].status = "applied";
      break;
    }
    case "authorize-publish": {
      const op = current();
      requireThat(op.phase === "result-ready" && op.result, "phase", "No accepted result to publish");
      if (!isCurrent(op, event.observation, { base: true })) {
        op.phase = "superseded";
        op.failure = "Authorization, revision, head or base changed";
      } else { op.phase = "publishing"; op.publishStartedAt = time(event.at); }
      break;
    }
    case "request-effect": {
      const op = current();
      requireThat(op.phase === "publishing", "phase", "Operation is not publishing");
      const effect = op.effects.find((e) => e.id === event.effectId);
      requireThat(effect, "invalid", "Unknown effect");
      // A pending request may be in flight. Do not resend it after a timeout.
      if (["pending", "applied"].includes(effect.status)) return ledger;
      const prerequisite = effect.dependsOn ? op.effects.find((e) => e.id === effect.dependsOn) : null;
      requireThat(!effect.dependsOn || prerequisite?.status === "applied", "pending", "An effect cannot precede its prerequisite");
      requireThat(isCurrent(op, event.observation, { head: expectedEffectHead(op, effect) })
        && (!["thread-reply", "thread-resolve"].includes(effect.type) || event.observation.threadRevisions?.[effect.thread] === effect.revision),
        "stale", "New write is no longer authorized or current");
      const limit = event.limit ?? 3;
      requireThat(Number.isSafeInteger(limit) && limit > 0, "invalid", "Invalid publish request limit");
      requireThat(effect.requests.length < limit, "budget", "Publish request budget exhausted");
      effect.requests.push({ id: `${op.id}/${effect.id}/${effect.requests.length + 1}`,
        generation: item.generation, at: time(event.at), publisher: runIdentity(event.publisher) });
      effect.status = "pending";
      break;
    }
    case "effect-observed": {
      const op = current();
      const effect = op.effects.find((e) => e.id === event.effectId);
      requireThat(effect && effect.requests.at(-1)?.id === event.requestId, "stale", "Effect observation is for a different request");
      if (event.outcome === "unknown") return ledger;
      if (effect.status === "applied") {
        requireThat(event.outcome === "applied" && validReceipt(effect, event.evidence), "stale", "Applied effects cannot be retracted by an old observation");
        return ledger;
      }
      requireThat(effect.status === "pending", "phase", "No outstanding request to observe");
      if (event.outcome === "applied") {
        requireThat(validReceipt(effect, event.evidence), "unknown", "Need evidence of the exact published commit");
        effect.status = "applied";
        effect.receipt = { ...event.evidence, at: time(event.at), requestId: event.requestId };
        if (effect.type === "pull-request") {
          const number = event.evidence.number;
          const other = Object.values(s.items).find((candidate) => candidate.key !== key && candidate.prs.some((p) => p.number === number));
          requireThat(!other, "invalid", "The published PR already belongs to another work item");
          if (!item.prs.some((p) => p.number === number)) item.prs.push({ number, required: true, state: event.evidence.state,
            acceptedClosure: false, mergedSha: event.evidence.state === "merged" ? event.evidence.mergedSha : null });
        }
      } else {
        requireThat(event.outcome === "rejected" && (event.evidence?.kind === "git-rejection" || event.evidence?.kind === "http-rejection"
          && [400, 401, 403, 404, 409, 410, 413, 415, 422].includes(event.evidence.status)), "unknown", "A timeout or unchanged head does not establish rejection");
        effect.status = "rejected";
        effect.lastRejection = { kind: event.evidence.kind, ...(event.evidence.status === undefined ? {} : { status: event.evidence.status }), requestId: event.requestId, at: time(event.at) };
      }
      break;
    }
    case "recover-publish": {
      const op = current();
      requireThat(op.phase === "publishing" && op.effects.every((e) => ["prepared", "rejected"].includes(e.status)),
        "pending", "A pending or applied write must be reconciled before retry");
      op.phase = "result-ready";
      break;
    }
    case "abandon-publish": {
      const op = current(), effect = op.effects.find((e) => e.id === event.effectId);
      requireThat(op.phase === "publishing" && effect && ["prepared", "rejected"].includes(effect.status)
        && op.effects.every((e) => e.status !== "pending"), "pending", "An unresolved request must be recovered before abandoning publication");
      const head = expectedEffectHead(op, effect);
      requireThat(!isCurrent(op, event.observation, { head }) || ["thread-reply", "thread-resolve"].includes(effect.type)
        && event.observation.threadRevisions?.[effect.thread] !== effect.revision, "invalid", "Current publication cannot be abandoned as stale");
      op.phase = "superseded"; op.failure = "Publication intent changed; applied effects remain recorded";
      for (const id of op.inputs ?? []) if (item.commands[id].status === "reserved") item.commands[id].status = "superseded";
      break;
    }
    case "result-unavailable": {
      const op = current();
      requireThat(op.phase === "result-ready" && event.confirmed === true, "unknown", "Result absence must be established");
      op.phase = "failed";
      op.failure = "Accepted result artifact is unavailable";
      break;
    }
    case "finish-publish": {
      const op = current();
      requireThat(op.phase === "publishing" && op.effects.every((e) => e.status === "applied"), "pending", "Publish effects are not all resolved");
      op.phase = op.result.outcome === "failed" ? "failed" : "done";
      for (const id of op.inputs ?? []) item.commands[id].status = op.result.outcome === "failed" ? "applied" : "incorporated";
      if (["ready", "no-change"].includes(op.result.outcome) && op.generation === item.generation && op.revision === item.revision) {
        item.feedback ??= {};
        for (const fact of op.incorporatedFeedback ?? op.feedbackInputs ?? []) item.feedback[fact.sourceId] = fact.revision;
      }
      if (["ready", "no-change"].includes(op.result.outcome) && op.mode !== "update" && op.revision === item.revision && op.generation === item.generation) item.revisionPending = false;
      if (op.result.outcome === "failed") op.failure = op.result.reason || "The worker reported failure";
      if (op.result.outcome === "needs-you") item.question = {
        id: createHash("sha256").update(`${key}:${item.generation}:${op.id}:${op.result.reason}`).digest("hex"), operation: op.id, reason: op.result.reason, at: time(event.at) };
      break;
    }
    case "abandon-prepared": {
      const op = current(), command = item.commands[event.commandId];
      requireThat(op.phase === "prepared" && op.owner === null && op.result === null && op.effects.length === 0,
        "busy", "Only a verified unclaimed prepared operation can be abandoned");
      requireThat(op.dispatch?.attempts.length >= 3 && command?.status === "queued"
        && ["answer", "respond", "resolve", "update", "build", "restart", "retry"].includes(command.action),
        "invalid", "Exhausted dispatch requires an explicit queued work request");
      op.phase = "superseded";
      op.abandonedPrepared = { commandId: command.id, at: time(event.at) };
      break;
    }
    case "supersede": {
      const op = current();
      requireThat(op.effects.every((e) => e.status !== "pending"), "pending", "An in-flight request must be reconciled before replacement");
      requireThat(!op.owner || op.owner.status === "completed", "busy", "The owner must be terminal before replacement");
      requireThat(op.generation !== item.generation || op.revision !== item.revision || (object(event.observation)
        && ((own(event.observation, "head") && event.observation.head !== op.target.head)
          || (own(event.observation, "baseSha") && event.observation.baseSha !== op.base.sha)
          || event.observation.open === false)), "invalid", "Operation has no observed superseding change");
      op.phase = "superseded";
      break;
    }
    case "pr-observed": {
      const pr = item.prs.find((p) => p.number === event.number);
      requireThat(pr && ["open", "merged", "closed"].includes(event.state), "invalid", "Unknown PR or state");
      requireThat(pr.state !== "merged" || (event.state === "merged" && event.mergedSha === pr.mergedSha), "stale", "A merged PR's landed commit cannot change");
      if (event.state === "merged") requireThat(SHA.test(event.mergedSha), "invalid", "Need the commit that actually landed");
      if (event.state === "open" && pr.state === "closed") {
        // A waiver covers one closure, not every later closure of this PR.
        pr.acceptedClosure = false;
        delete pr.dispositionSource;
      }
      pr.state = event.state;
      if (pr.required && (pr.state === "open" || pr.state === "closed" && !pr.acceptedClosure)) item.complete = false;
      if (event.state !== "open" && s.integration?.item === key && s.integration.pr === event.number) s.integration = null;
      pr.mergedSha = event.state === "merged" ? event.mergedSha : null;
      break;
    }
    case "accept-closure": {
      const pr = item.prs.find((p) => p.number === event.number);
      const command = item.commands[event.commandId], op = s.operations[item.activeOperation];
      requireThat(!item.requestOnly && !item.evidence.own && !item.paused && (!op || TERMINAL.has(op.phase)),
        "busy", "Recover existing work before accepting a closure");
      requireThat(command?.status === "queued" && closureAnswer(command, item.question, item.revision) === event.number
        && pr?.required && pr.state === "closed" && !pr.acceptedClosure,
        "invalid", "Closure acceptance needs a pending answer identifying a closed required PR");
      requireThat(event.authorization?.valid === true && event.authorization.revision === item.revision,
        "invalid", "Closure acceptance needs fresh authorization for the current issue revision");
      pr.acceptedClosure = true;
      pr.dispositionSource = command.sourceId;
      (pr.dispositions ??= []).push({ commandId: command.id, sourceId: command.sourceId, commandRevision: command.revision,
        issueRevision: item.revision, at: time(event.at) });
      command.status = "applied";
      if (item.question?.kind === "pr-closure" && item.question.number === pr.number) {
        item.lastQuestion = { ...item.question, resolution: "closure-accepted", resolvedAt: event.at };
        item.question = null;
      }
      break;
    }
    case "close-out":
      requireThat(!item.revisionPending && item.prs.some((p) => p.required) && item.prs.filter((p) => p.required)
        .every((p) => p.state === "merged" || (p.state === "closed" && p.acceptedClosure)), "incomplete", "Required work is not all accounted for");
      item.complete = true;
      item.question = null;
      break;
    default: throw new ProtocolError("invalid", `Unknown controller transition ${event.type}`);
  }
  return finish();
}
