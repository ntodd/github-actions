// The controller's GitHub API effects. They are separate from code publication:
// a broken status surface cannot roll back a push or authorize another worker.
import { createHash } from "node:crypto";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const hash = (v) => createHash("sha256").update(v).digest("hex");
export const apiEffectId = (slot) => hash(slot);
export const factoryLabels = new Set(["agent-ready", "agent-working", "agent-review", "agent-waiting", "agent-needs-you", "agent-failed", "agent-stopped", "agent-covered", "agent-complete", "agent-blocked", "agent-done", "agent-conflict"]);
export const repeatableEffect = (kind) => ["comment-edit", "label-add", "label-remove", "reaction"].includes(kind);
const stateWrite = (kind) => ["pr-close", "issue-close", "issue-reopen"].includes(kind);
const stateProof = (r, state) => r.state === state && (r.proof === undefined || ["response", "observation"].includes(r.proof)
  || r.proof === "timeline" && typeof r.eventId === "string" && /^[1-9]\d*$/.test(r.eventId) && Number.isFinite(Date.parse(r.eventAt)));
const bounded = (v, max) => typeof v === "string" && v.length <= max;
const marker = (v) => bounded(v, 256) && /^<!-- factory:[a-z-]+=[a-zA-Z0-9:/-]+ -->$/.test(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every((k) => allowed.includes(k));
export function validApiDefinition(d, item) {
  if (!keys(d, ["kind", "target", "payload", "guard"]) || !positive(d.target) || !object(d.payload)) return false;
  const subject = Number(item.key.split(":")[1]), pr = item.prs.find((p) => p.number === d.target);
  if (d.target !== subject && !pr) return false;
  if (d.guard !== undefined && (!keys(d.guard, ["generation", "revision", "commandId"])
    || !Number.isSafeInteger(d.guard.generation) || d.guard.generation < 0 || !/^[a-f0-9]{64}$/.test(d.guard.revision)
    || d.guard.commandId !== undefined && !item.commands[d.guard.commandId])) return false;
  const p = d.payload;
  switch (d.kind) {
    case "comment-create": return keys(p, ["body", "marker"]) && bounded(p.body, 60000) && marker(p.marker) && p.body.includes(p.marker);
    case "comment-edit": return keys(p, ["id", "body", "marker"]) && positive(p.id) && bounded(p.body, 60000) && marker(p.marker) && p.body.includes(p.marker);
    case "reaction": return keys(p, ["id", "sourceKind", "content"]) && positive(p.id)
      && ["issue-comment", "review-comment"].includes(p.sourceKind) && p.content === "eyes";
    case "label-add":
    case "label-remove": return keys(p, ["label"]) && factoryLabels.has(p.label);
    case "ready": return !item.evidence.own && pr && keys(p, ["head", "nodeId"]) && sha(p.head) && bounded(p.nodeId, 256) && p.nodeId.length > 0;
    case "review-request": return !item.evidence.own && pr && keys(p, ["head", "reviewers"]) && sha(p.head) && Array.isArray(p.reviewers)
      && p.reviewers.length > 0 && p.reviewers.length <= 10 && new Set(p.reviewers).size === p.reviewers.length
      && p.reviewers.every((r) => /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(r));
    case "pr-close": return !item.evidence.own && pr && keys(p, ["head"]) && sha(p.head) && Boolean(d.guard?.commandId);
    case "issue-close": return !item.evidence.own && d.target === subject && keys(p, ["revision"]) && /^[a-f\d]{64}$/.test(p.revision) && Boolean(d.guard);
    case "issue-reopen": return !item.evidence.own && d.target === subject && keys(p, []) && Boolean(d.guard?.commandId);
    case "ci-rerun": return pr && keys(p, ["head", "testedSha", "runHead", "runId", "attempt"]) && sha(p.head) && sha(p.testedSha)
      && [p.head, p.testedSha].includes(p.runHead)
      && /^[1-9]\d*$/.test(p.runId) && positive(p.attempt) && Boolean(d.guard);
    default: return false;
  }
}
export function validApiReceipt(d, r) {
  if (!object(r) || r.kind !== d.kind || r.target !== d.target) return false;
  switch (d.kind) {
    case "comment-create":
    case "comment-edit": return positive(r.id) && (d.kind !== "comment-edit" || r.id === d.payload.id);
    case "reaction": return positive(r.id);
    case "label-add":
    case "label-remove": return r.label === d.payload.label;
    case "ready": return r.head === d.payload.head && r.draft === false;
    case "review-request": return r.head === d.payload.head && Array.isArray(r.reviewers) && d.payload.reviewers.every((u) => r.reviewers.includes(u));
    case "pr-close":
    case "issue-close": return stateProof(r, "closed");
    case "issue-reopen": return stateProof(r, "open");
    case "ci-rerun": return r.runId === d.payload.runId && positive(r.attempt) && r.attempt > d.payload.attempt;
    default: return false;
  }
}
export function validApiJournal(item) {
  if (item.apiEffects === undefined) return true;
  return object(item.apiEffects) && Object.entries(item.apiEffects).every(([id, e]) => /^[a-f\d]{64}$/.test(id)
    && object(e) && e.id === id && bounded(e.slot, 1024) && apiEffectId(e.slot) === id && validApiDefinition(e.definition, item)
    && ["prepared", "pending", "applied", "rejected", "superseded"].includes(e.status)
    && Array.isArray(e.requests) && e.requests.length <= 10000 && e.requests.every((r, n) => object(r)
      && r.id === `${id}/${n + 1}` && Number.isFinite(Date.parse(r.at))
      && (r.stateCursor === undefined || stateWrite(e.definition.kind) && typeof r.stateCursor === "string" && /^(0|[1-9]\d*)$/.test(r.stateCursor))
      && /^[1-9]\d*$/.test(r.publisher?.id) && positive(r.publisher?.attempt))
    && Number.isFinite(Date.parse(e.createdAt)) && (!e.nextAt || Number.isFinite(Date.parse(e.nextAt)))
    && (e.status !== "prepared" || e.requests.length === 0)
    && (e.status !== "pending" || e.requests.length > 0)
    && (e.status !== "applied" || validApiReceipt(e.definition, e.receipt))
    && (e.receipt?.proof !== "timeline" || validApiReceipt(e.definition, e.receipt) && e.requests.at(-1)?.stateCursor !== undefined
      && BigInt(e.receipt.eventId) > BigInt(e.requests.at(-1).stateCursor)));
}

// Must hold factory-control. The caller supplies a trusted, fresh guard and an
// adapter that returns receipts for these exact definitions. Unknown creates,
// closes and reruns are never resent on the strength of an absent API result.
export async function runApiEffect({ store, key, slot, definition, run, writer, guard = async () => true,
  now = () => new Date().toISOString(), recoverOnly = false }) {
  if (typeof slot !== "string" || !slot || slot.length > 1024) throw new Error("Invalid API effect slot");
  const id = apiEffectId(slot);
  const record = (s) => s.items[key]?.apiEffects?.[id];
  await store.transact((s) => {
    const item = s.items[key];
    if (!item || !validApiDefinition(definition, item)) throw new Error("API effect exceeds its recorded work item");
    item.apiEffects ??= {};
    if (item.apiEffects[id]) {
      if (JSON.stringify(item.apiEffects[id].definition) !== JSON.stringify(definition)) throw new Error("An API effect identity cannot be reused for a different request");
    } else item.apiEffects[id] = { id, slot, definition: structuredClone(definition), createdAt: now(), status: "prepared", requests: [], receipt: null };
    return s;
  });
  let { state } = await store.load(), effect = record(state);
  if (effect.status === "superseded" || effect.status === "applied" && !repeatableEffect(definition.kind)) return effect;
  const anotherStateWrite = (s) => stateWrite(definition.kind) && Object.entries(s.items).some(([itemKey, item]) => Object.values(item.apiEffects ?? {}).some((e) =>
    (itemKey !== key || e.id !== id) && e.status === "pending" && e.definition.target === definition.target && stateWrite(e.definition.kind)));
  if (effect.status !== "pending" && anotherStateWrite(state)) return effect;
  const observe = async (receipt, requestId = null) => store.transact((s) => {
    const current = record(s);
    if (requestId && current.requests.at(-1)?.id !== requestId) throw new Error("API response belongs to another request");
    if (!validApiReceipt(current.definition, receipt)) throw new Error("API response does not establish the requested effect");
    current.status = "applied"; current.receipt = { ...receipt, at: now() };
    if (current.requests.length) current.requests.at(-1).receipt = current.receipt;
    return s;
  });
  const inspected = await writer.inspect(definition, effect);
  if (inspected?.outcome === "applied") return effect.status === "applied" ? effect : record((await observe(inspected.receipt)).state);
  if (recoverOnly) return effect;
  const pending = effect.status === "pending";
  if (pending && !repeatableEffect(definition.kind)) return effect;
  const spent = (e) => e.requests.filter((r) => new Date(r.at).toISOString().slice(0, 10) === new Date(now()).toISOString().slice(0, 10)).length;
  if (spent(effect) >= 3 || effect.nextAt && Date.parse(now()) < Date.parse(effect.nextAt)) return effect;
  const item = state.items[key], bound = definition.guard;
  if (bound && (item.paused || item.generation !== bound.generation || item.revision !== bound.revision)
    || !await guard(item, effect)) {
    if (!pending) await store.transact((s) => { record(s).status = "superseded"; return s; });
    return record((await store.load()).state);
  }
  let submitted;
  await store.transact((s) => {
    submitted = null;
    const current = record(s);
    if (current.status === "superseded" || current.status === "applied" && !repeatableEffect(definition.kind) || spent(current) >= 3
      || current.status === "pending" && !repeatableEffect(definition.kind) || anotherStateWrite(s)) return s;
    const request = { id: `${id}/${current.requests.length + 1}`, at: now(), publisher: { id: run.id, attempt: run.attempt },
      ...(stateWrite(definition.kind) && inspected?.stateCursor !== undefined ? { stateCursor: inspected.stateCursor } : {}) };
    current.requests.push(request); current.status = "pending"; current.receipt = null;
    current.nextAt = new Date(Date.parse(request.at) + 60000).toISOString();
    submitted = request.id;
    return s;
  });
  // A conflicting ledger transaction may have recomputed the mutator.
  ({ state } = await store.load()); effect = record(state);
  if (!submitted || effect.status !== "pending" || effect.requests.at(-1)?.id !== submitted
    || effect.requests.at(-1).publisher.id !== run.id || effect.requests.at(-1).publisher.attempt !== run.attempt) return effect;
  try {
    const result = await writer.apply(definition);
    if (result?.outcome === "applied") await observe(result.receipt, submitted);
    else if (result?.outcome === "rejected" && [400, 401, 403, 404, 409, 410, 422].includes(result.status)) {
      await store.transact((s) => {
        const current = record(s);
        if (current.status === "pending" && current.requests.at(-1)?.id === submitted) {
          current.status = "rejected"; current.rejection = result.status;
        }
        return s;
      });
    }
  } catch { /* Keep the request pending, including a lost receipt response. */ }
  return record((await store.load()).state);
}
