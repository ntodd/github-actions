import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const readKinds = new Set(["status", "labels", "notification", "comment-create", "comment-edit", "reaction", "label-add", "label-remove", "ready", "review-request", "pr-close", "issue-close", "issue-reopen", "ci-rerun"]);
const readStages = new Set(["plan", "inspect", "guard"]);
export const preflightId = (kind, target, stage, runId) => hash(`${kind}:${target}:${stage}${runId ? `:${runId}` : ""}`);
const sameGuard = (a, b) => a?.generation === b?.generation && a?.revision === b?.revision;
const targetKnown = (item, target) => target === Number(item.key.split(":")[1]) || item.prs.some((p) => p.number === target);
const obsoleteRead = (item, read) => read.guard && (item.paused || !sameGuard(item, read.guard)
  || ["ready", "review-request", "pr-close", "ci-rerun"].includes(read.kind) && item.prs.some((p) => p.number === read.target && p.state !== "open"))
  || read.effect && item.apiEffects?.[read.effect]?.status === "superseded";
export class PreflightWait extends Error {
  constructor(read) { super(`Waiting before observing ${read.kind} on #${read.target} again (${read.nextAt})`); this.code = "preflight-wait"; }
}

// Only failed read/guard attempts create records. Healthy observations add no
// ledger writes. These records grant no authority and never represent a write.
export async function preflightRead({ store, key, item, kind, target, stage, guard, runId, effect, read, now = () => new Date().toISOString() }) {
  const at = now(), instant = Date.parse(at), id = preflightId(kind, target, stage, runId);
  if (!item || item.key !== key || !readKinds.has(kind) || !readStages.has(stage) || !targetKnown(item, target)
    || runId !== undefined && (kind !== "ci-rerun" || typeof runId !== "string" || !/^[1-9]\d*$/.test(runId))
    || guard !== undefined && (!guard || !Number.isSafeInteger(guard.generation) || guard.generation < 0 || !/^[a-f\d]{64}$/.test(guard.revision))
    || effect !== undefined && item.apiEffects?.[effect]?.definition.target !== target
    || !Number.isFinite(instant)) throw new Error("Invalid preflight observation identity");
  const previous = item.preflights?.[id];
  if (previous?.status === "failed" && sameGuard(previous.guard, guard) && instant < Date.parse(previous.nextAt)) throw new PreflightWait(previous);
  let value;
  try { value = await read(); }
  catch (error) {
    const code = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? `http:${error.status}`
      : error?.code === "runtime-conflict" ? "runtime-conflict" : "unavailable";
    await store.transact((s) => {
      const current = s.items[key], before = current.preflights?.[id], repeated = before?.status === "failed" && sameGuard(before.guard, guard);
      const failures = repeated ? Math.min(1000000, before.failures + 1) : 1;
      (current.preflights ??= {})[id] = { id, kind, target, stage, ...(effect ? { effect } : {}), ...(runId ? { runId } : {}), ...(guard ? { guard: { generation: guard.generation, revision: guard.revision } } : {}),
        incident: repeated ? before.incident : (before?.incident ?? 0) + 1, failures, status: "failed", code,
        firstAt: repeated ? before.firstAt : at, lastAt: at, nextAt: new Date(instant + Math.min(3600000, 60000 * 2 ** Math.min(6, failures - 1))).toISOString() };
      return s;
    });
    throw error;
  }
  if (previous?.status === "failed") await store.transact((s) => {
    const current = s.items[key].preflights?.[id];
    if (current?.status === "failed" && current.incident === previous.incident) {
      current.status = "observed"; current.failures = 0; current.resolvedAt = at; current.nextAt = null;
    }
    return s;
  });
  return value;
}

export function validPreflights(item) {
  if (item.preflights === undefined) return true;
  return item.preflights && typeof item.preflights === "object" && !Array.isArray(item.preflights)
    && Object.entries(item.preflights).every(([id, r]) => r && r.id === id && readKinds.has(r.kind) && readStages.has(r.stage)
      && Number.isSafeInteger(r.target) && r.target > 0 && targetKnown(item, r.target) && id === preflightId(r.kind, r.target, r.stage, r.runId)
      && (r.runId === undefined || r.kind === "ci-rerun" && typeof r.runId === "string" && /^[1-9]\d*$/.test(r.runId))
      && (r.effect === undefined || item.apiEffects?.[r.effect]?.definition.target === r.target
        && (r.kind === "notification" || item.apiEffects[r.effect].definition.kind === r.kind))
      && Number.isSafeInteger(r.incident) && r.incident > 0 && Number.isSafeInteger(r.failures) && r.failures >= 0 && r.failures <= 1000000
      && ["failed", "observed", "superseded"].includes(r.status) && /^(http:[45]\d\d|runtime-conflict|unavailable)$/.test(r.code)
      && Number.isFinite(Date.parse(r.firstAt)) && Number.isFinite(Date.parse(r.lastAt))
      && (r.guard === undefined || r.guard && Number.isSafeInteger(r.guard.generation) && r.guard.generation >= 0 && /^[a-f\d]{64}$/.test(r.guard.revision))
      && (r.status === "failed" ? r.failures > 0 && Number.isFinite(Date.parse(r.nextAt))
        : r.nextAt === null && Number.isFinite(Date.parse(r.resolvedAt))));
}

// Public request identities for status and stop acknowledgements. A pending
// record is uncertainty, never evidence that a remote write did not happen.
export function pendingWrites(ledger, key) {
  const item = ledger.items[key], op = ledger.operations[item.activeOperation];
  return [
    ...(op?.effects ?? []).filter((e) => e.status === "pending").map((e) => ({
      source: "publish", operation: op.id, effect: e.id, request: e.requests.at(-1).id,
      type: e.type, target: op.target.number ?? e.branch ?? e.head, at: e.requests.at(-1).at,
    })),
    ...Object.values(item.apiEffects ?? {}).filter((e) => e.status === "pending").map((e) => ({
      source: "api", effect: e.id, request: e.requests.at(-1).id, type: e.definition.kind,
      target: e.definition.target, at: e.requests.at(-1).at,
    })),
  ];
}

export function pendingText(writes) {
  if (!writes.length) return "";
  return `\n\nRequests with unknown outcomes may still finish:\n${writes.map((w) =>
    `- ${w.type} on ${typeof w.target === "number" ? `#${w.target}` : `\`${String(w.target).replaceAll("`", "\\`")}\``}: \`${w.request}\``).join("\n")}`;
}

export const apiAlertId = (key, effect, sequence) => hash(`${key}:${effect}:${sequence}`);
export const recoveryNotice = (effect) => effect.slot.startsWith("attention:") || effect.slot.startsWith("attention-resolved:")
  || effect.definition.payload.marker?.startsWith("<!-- factory:attention=") || effect.slot.startsWith("question:") || effect.slot.startsWith("question-review:");

export function apiRecoveryProblems(item, at, timeoutMinutes) {
  const instant = Date.parse(at), problems = [];
  for (const effect of Object.values(item.apiEffects ?? {})) {
    // A failed notification about a failure cannot spawn another notification.
    if (recoveryNotice(effect)) continue;
    if (!["pending", "rejected"].includes(effect.status) || !effect.requests.length) continue;
    const lastReceipt = effect.requests.findLastIndex((r) => r.receipt), unresolved = effect.requests.slice(lastReceipt + 1);
    const first = unresolved[0] ?? effect.requests.at(-1), existing = Object.values(item.apiAlerts ?? {}).find((a) => a.effect === effect.id && a.status === "active");
    if (existing?.status !== "active" && unresolved.length < 3 && instant < Date.parse(first.at) + timeoutMinutes * 60_000) continue;
    problems.push({ effect: effect.id, request: effect.requests.at(-1).id, kind: effect.definition.kind, target: effect.definition.target,
      reason: effect.status === "pending" ? `${effect.definition.kind} on #${effect.definition.target} has an unknown outcome. The recorded request is inspected; a nonrepeatable write is not resent.`
        : `${effect.definition.kind} on #${effect.definition.target} remains rejected${effect.rejection ? ` (${effect.rejection})` : ""}. Inspect permissions and the recorded requests.` });
  }
  return problems;
}

export function syncApiAlerts(item, at, timeoutMinutes) {
  const problems = apiRecoveryProblems(item, at, timeoutMinutes);
  for (const read of Object.values(item.preflights ?? {})) {
    if (read.status === "failed" && obsoleteRead(item, read)) { read.status = "superseded"; read.nextAt = null; read.resolvedAt = at; }
    if (read.kind === "notification" || read.status !== "failed" || read.failures < 3 && Date.parse(at) < Date.parse(read.firstAt) + timeoutMinutes * 60000) continue;
    problems.push({ source: "preflight", preflight: read.id, incident: read.incident, read: `${read.id}/${read.incident}/${read.failures}`,
      kind: read.kind, target: read.target, reason: `${read.kind} on #${read.target} cannot establish its ${read.stage} preconditions (${read.code}). No request is submitted on the strength of that failed observation; check API access and runtime preconditions.` });
  }
  const identity = (a) => a.source === "preflight" ? `preflight:${a.preflight}/${a.incident}` : a.effect;
  const active = new Set(problems.map(identity));
  if (!problems.length && !Object.values(item.apiAlerts ?? {}).some((a) => a.status === "active")) return;
  item.apiAlerts ??= {};
  for (const problem of problems) {
    const old = Object.values(item.apiAlerts).find((a) => identity(a) === identity(problem) && a.status === "active");
    if (old?.status === "active") Object.assign(old, problem);
    else {
      const sequence = item.apiAlertSequence = (item.apiAlertSequence ?? 0) + 1;
      const id = apiAlertId(item.key, identity(problem), sequence);
      item.apiAlerts[id] = { ...problem, id, sequence, at, status: "active" };
    }
  }
  for (const alert of Object.values(item.apiAlerts)) if (alert.status === "active" && !active.has(identity(alert))) {
    alert.status = "resolved"; alert.resolvedAt = at;
    alert.resolution = alert.source === "preflight" ? item.preflights[alert.preflight].status === "observed"
      && item.preflights[alert.preflight].incident === alert.incident ? "observed" : "superseded" : item.apiEffects[alert.effect].status;
  }
}

export function validApiAlerts(item) {
  if (item.apiAlerts === undefined) return item.apiAlertSequence === undefined;
  return item.apiAlerts && typeof item.apiAlerts === "object" && !Array.isArray(item.apiAlerts)
    && Number.isSafeInteger(item.apiAlertSequence) && item.apiAlertSequence > 0
    && new Set(Object.values(item.apiAlerts).filter((a) => a?.status === "active").map((a) => a.source === "preflight" ? `${a.preflight}/${a.incident}` : a.effect)).size === Object.values(item.apiAlerts).filter((a) => a?.status === "active").length
    && Object.entries(item.apiAlerts).every(([id, alert]) => {
      const effect = item.apiEffects?.[alert?.effect], read = item.preflights?.[alert?.preflight], preflight = alert?.source === "preflight";
      return alert && (alert.source === undefined || preflight) && alert.id === id && ["active", "resolved"].includes(alert.status)
        && Number.isSafeInteger(alert.sequence) && alert.sequence > 0 && alert.sequence <= item.apiAlertSequence
        && (preflight ? read && Number.isSafeInteger(alert.incident) && alert.incident > 0 && alert.incident <= read.incident
          && alert.id === apiAlertId(item.key, `preflight:${read.id}/${alert.incident}`, alert.sequence) && alert.kind === read.kind && alert.target === read.target
          && typeof alert.read === "string" && new RegExp(`^${read.id}/${alert.incident}/[1-9]\\d*$`).test(alert.read)
          : effect && alert.id === apiAlertId(item.key, alert.effect, alert.sequence) && alert.kind === effect.definition.kind && alert.target === effect.definition.target
            && effect.requests.some((r) => r.id === alert.request)) && Number.isFinite(Date.parse(alert.at))
        && typeof alert.reason === "string" && alert.reason.length <= 2000
        && (alert.status !== "resolved" || Number.isFinite(Date.parse(alert.resolvedAt)) && (preflight ? ["observed", "superseded"] : ["applied", "superseded"]).includes(alert.resolution));
    });
}
