import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");

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

export function apiRecoveryProblems(item, at, timeoutMinutes) {
  const instant = Date.parse(at), problems = [];
  for (const effect of Object.values(item.apiEffects ?? {})) {
    // A failed notification about a failure cannot spawn another notification.
    if (effect.slot.startsWith("attention:") || effect.slot.startsWith("attention-resolved:")
      || effect.definition.payload.marker?.startsWith("<!-- factory:attention=")
      || effect.slot.startsWith("question:") || effect.slot.startsWith("question-review:")) continue;
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
  const problems = apiRecoveryProblems(item, at, timeoutMinutes), active = new Set(problems.map((p) => p.effect));
  if (!problems.length && !Object.values(item.apiAlerts ?? {}).some((a) => a.status === "active")) return;
  item.apiAlerts ??= {};
  for (const problem of problems) {
    const old = Object.values(item.apiAlerts).find((a) => a.effect === problem.effect && a.status === "active");
    if (old?.status === "active") Object.assign(old, problem);
    else {
      const sequence = item.apiAlertSequence = (item.apiAlertSequence ?? 0) + 1;
      const id = apiAlertId(item.key, problem.effect, sequence);
      item.apiAlerts[id] = { ...problem, id, sequence, at, status: "active" };
    }
  }
  for (const alert of Object.values(item.apiAlerts)) if (alert.status === "active" && !active.has(alert.effect)) {
    alert.status = "resolved"; alert.resolvedAt = at; alert.resolution = item.apiEffects[alert.effect].status;
  }
}

export function validApiAlerts(item) {
  if (item.apiAlerts === undefined) return item.apiAlertSequence === undefined;
  return item.apiAlerts && typeof item.apiAlerts === "object" && !Array.isArray(item.apiAlerts)
    && Number.isSafeInteger(item.apiAlertSequence) && item.apiAlertSequence > 0
    && new Set(Object.values(item.apiAlerts).filter((a) => a?.status === "active").map((a) => a.effect)).size === Object.values(item.apiAlerts).filter((a) => a?.status === "active").length
    && Object.entries(item.apiAlerts).every(([id, alert]) => {
      const effect = item.apiEffects?.[alert?.effect];
      return alert && effect && alert.id === id && ["active", "resolved"].includes(alert.status)
        && Number.isSafeInteger(alert.sequence) && alert.sequence > 0 && alert.sequence <= item.apiAlertSequence
        && alert.id === apiAlertId(item.key, alert.effect, alert.sequence) && alert.kind === effect.definition.kind && alert.target === effect.definition.target
        && effect.requests.some((r) => r.id === alert.request) && Number.isFinite(Date.parse(alert.at))
        && typeof alert.reason === "string" && alert.reason.length <= 2000
        && (alert.status !== "resolved" || Number.isFinite(Date.parse(alert.resolvedAt)) && ["applied", "superseded"].includes(alert.resolution));
    });
}
