// Measurements are evidence, never authority or budget credits. Totals are
// derived from immutable operation/request identities rather than incremented.
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000;
const dollars = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000;
const stamp = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const id = (v) => typeof v === "string" && /^[1-9]\d*$/.test(v);
const phases = ["work", "review", "finalize"];
export const validRunner = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);

export function validWorkerUsage(v) {
  return object(v) && v.source === "worker-report" && typeof v.model === "string" && v.model.length > 0 && v.model.length <= 256
    && (v.cliVersion === null || typeof v.cliVersion === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,8}$/.test(v.cliVersion))
    && ["cumulative", "invocation", "phase", "unknown"].includes(v.costScope)
    && (v.reportedUsd === null || dollars(v.reportedUsd)) && (v.turns === null || count(v.turns)) && typeof v.complete === "boolean"
    && (!v.complete || v.reportedUsd !== null && v.turns !== null) && Array.isArray(v.phases) && v.phases.length <= 3
    && v.phases.every((p, n) => object(p) && p.phase === phases[n] && (p.reportedUsd === null || dollars(p.reportedUsd))
      && (p.turns === null || count(p.turns)) && typeof p.complete === "boolean"
      && (!p.complete || p.reportedUsd !== null && p.turns !== null))
    && (v.reportedUsd === null || Math.abs(v.reportedUsd - v.phases.reduce((sum, p) => sum + (p.reportedUsd ?? 0), 0)) < 1e-7)
    && (v.turns === null || v.turns === v.phases.reduce((sum, p) => sum + (p.turns ?? 0), 0))
    && (!v.complete || v.phases.every((p) => p.complete));
}

export function workerUsage(metrics, model) {
  const unknown = { source: "worker-report", model, cliVersion: null, costScope: "unknown", reportedUsd: null, turns: null, complete: false, phases: [] };
  if (metrics?.schemaVersion !== 1 || !Array.isArray(metrics.phases) || metrics.phases.length > 3) return unknown;
  const value = { source: "worker-report", model, reportedUsd: metrics.cost, turns: metrics.turns,
    cliVersion: metrics.cliVersion ?? null, costScope: metrics.costScope ?? "unknown",
    complete: metrics.complete, phases: metrics.phases.map((p) => ({ phase: p?.phase, reportedUsd: p?.cost,
      turns: p?.turns, complete: p?.complete })) };
  return validWorkerUsage(value) ? value : unknown;
}

// Claude >=2.1.277 restores cumulative session cost on resume. Keep its latest
// total, not the sum of resumed results. Missing/reset totals remain partial.
// https://code.claude.com/docs/en/agent-sdk/cost-tracking
export function claudeCostScope(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version ?? "");
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 277) ? "cumulative" : "invocation";
}

export function workerMeter({ scope = "cumulative" } = {}) {
  const rows = [];
  let sessionCost = 0, hasCost = false, allComplete = true;
  return {
    invocation({ phase, result, completed }) {
      let row = rows.find((p) => p.phase === phase);
      if (!row) { row = { phase, cost: null, turns: null, complete: true }; rows.push(row); }
      const total = result?.total_cost_usd, turns = result?.num_turns;
      const validCost = dollars(total) && (scope === "invocation" || scope === "cumulative" && total >= sessionCost);
      if (validCost) {
        row.cost = (row.cost ?? 0) + total - (scope === "cumulative" ? sessionCost : 0);
        sessionCost = total; hasCost = true;
      }
      if (count(turns)) row.turns = (row.turns ?? 0) + turns;
      row.complete &&= completed === true && validCost && count(turns);
      allComplete &&= row.complete;
    },
    phase(phase, result) {
      // An injected runner's explicit phase cost follows the runner contract.
      // Production measurements use invocation callbacks, including error exits.
      if (rows.some((p) => p.phase === phase)) return;
      const cost = dollars(result?.cost) ? result.cost : null, turns = count(result?.turns) ? result.turns : null;
      rows.push({ phase, cost, turns, complete: cost !== null && turns !== null });
      allComplete &&= cost !== null && turns !== null;
      if (cost !== null) hasCost = true;
    },
    snapshot() {
      return { schemaVersion: 1, cost: hasCost || !rows.length ? rows.reduce((s, p) => s + (p.cost ?? 0), 0) : null,
        costScope: scope ?? "unknown",
        turns: !rows.length || rows.some((p) => p.turns !== null) ? rows.reduce((s, p) => s + (p.turns ?? 0), 0) : null,
        complete: allComplete, phases: structuredClone(rows) };
    },
  };
}

export function validExecution(v, op) {
  if (!object(v) || v.source !== "actions-job" || v.run?.id !== op.owner?.id || v.run?.attempt !== op.owner?.attempt
    || !id(v.jobId) || v.runner !== op.worker.runner || !validRunner(v.runner) || typeof v.ran !== "boolean"
    || !count(v.durationMs)) return false;
  return v.ran ? stamp(v.startedAt) && stamp(v.completedAt) && Date.parse(v.completedAt) >= Date.parse(v.startedAt)
    && v.durationMs === Date.parse(v.completedAt) - Date.parse(v.startedAt)
    : v.startedAt === null && v.completedAt === null && v.durationMs === 0;
}

export function validRouterUsage(v) {
  if (!object(v) || !["responses-api", "decisions-api"].includes(v.source) || !["unknown", "not-requested", "reported"].includes(v.status)
    || typeof v.model !== "string" || !v.model.length || v.model.length > 256) return false;
  if (v.status !== "reported") return v.tokens === null && v.responseId === null;
  const t = v.tokens;
  return (v.source === "decisions-api" ? v.responseId === null : typeof v.responseId === "string" && /^resp_[A-Za-z0-9_-]{1,200}$/.test(v.responseId)) && object(t)
    && [t.input, t.output, t.total].every(count) && count(t.cachedInput) && count(t.reasoningOutput)
    && t.total === t.input + t.output && t.cachedInput <= t.input && t.reasoningOutput <= t.output;
}

export function routerUsage(response, model, source = "responses-api") {
  const v = { source, status: "reported", model, responseId: source === "decisions-api" ? null : response?.id,
    tokens: { input: response?.usage?.input_tokens, output: response?.usage?.output_tokens, total: response?.usage?.total_tokens,
      cachedInput: response?.usage?.input_tokens_details?.cached_tokens,
      reasoningOutput: response?.usage?.output_tokens_details?.reasoning_tokens } };
  return validRouterUsage(v) ? v : { source, status: "unknown", model, tokens: null, responseId: null };
}

export function validOperationUsage(v, op) {
  return v === undefined || object(v) && (v.model === undefined || validWorkerUsage(v.model))
    && (v.modelArtifact === undefined || v.model && id(v.modelArtifact?.id) && /^sha256:[a-f0-9]{64}$/.test(v.modelArtifact.digest))
    && (v.execution === undefined || validExecution(v.execution, op))
    && (v.collection === undefined || object(v.collection) && count(v.collection.attempts) && v.collection.attempts > 0
      && stamp(v.collection.at) && stamp(v.collection.nextAt) && typeof v.collection.reason === "string" && v.collection.reason.length <= 2000);
}

export function usageText(usage) {
  const lines = [`${usage.legacyUnknown ? "Factory usage since migration" : "Usage"}: Claude reports $${usage.workerReportedUsd.toFixed(4)}; Crew execution ${usage.crewMinutes.toFixed(2)} min.`];
  if (usage.legacyUnknown) lines.push("Legacy model cost and Crew minutes were not measured.");
  if (usage.workerUnknown || usage.crewUnknown) lines.push(`Missing or partial measurements: ${usage.workerUnknown} Claude attempt(s), ${usage.crewUnknown} Crew job(s).`);
  if (usage.routingRequests) lines.push(`Mention routing: ${usage.routingTokens.total} reported tokens; ${usage.routingUnknown} request(s) with unknown usage; dollar cost unavailable for ${usage.routingUnpriced} response(s).`);
  return lines.join(" ");
}

export function itemUsage(ledger, key) {
  const ops = Object.values(ledger.operations).filter((o) => o.item === key && o.owner);
  const modelOps = ops.filter((o) => o.mode !== "update");
  const routing = Object.values(ledger.items[key].commands).flatMap((c) => (c.routingAttempts ?? []).map((_, n) => c.routingUsage?.[n]));
  const knownTokens = routing.filter((u) => u?.status === "reported");
  return {
    legacyUnknown: ledger.items[key].migration !== undefined,
    workerReportedUsd: modelOps.reduce((s, o) => s + (o.usage?.model?.reportedUsd ?? 0), 0),
    workerTurns: modelOps.reduce((s, o) => s + (o.usage?.model?.turns ?? 0), 0),
    workerUnknown: modelOps.filter((o) => o.usage?.model?.complete !== true && o.usage?.execution?.ran !== false).length,
    crewMinutes: ops.filter((o) => o.mode !== "update").reduce((s, o) => s + (o.usage?.execution?.durationMs ?? 0) / 60000, 0),
    executionUnknown: ops.filter((o) => !o.usage?.execution).length,
    crewUnknown: modelOps.filter((o) => !o.usage?.execution).length,
    routingRequests: routing.length, routingUnknown: routing.filter((u) => !u || u.status === "unknown").length,
    routingUnpriced: knownTokens.length,
    routingTokens: Object.fromEntries(["input", "output", "total", "cachedInput", "reasoningOutput"].map((k) => [k,
      knownTokens.reduce((s, u) => s + u.tokens[k], 0)])),
  };
}
