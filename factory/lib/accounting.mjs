import { evolve, TERMINAL } from "./protocol.mjs";

// Recover measurements independently of admission and active-operation status.
// A stopped or replaced attempt still consumed resources. Scan bounds and
// durable backoff prevent missing historical jobs from monopolizing a pass.
export async function collectUsage({ actions, store, context, now, limit = 8, artifactLimit = 2 }) {
  if (!actions.measure) return [];
  const { state } = await store.load(), at = now();
  const candidates = Object.values(state.operations).filter((op) => op.owner
    && (op.owner.status === "completed" || TERMINAL.has(op.phase))
    && (!op.usage?.execution || op.mode !== "update" && !op.usage?.model && op.usage.execution?.ran !== false)
    && (!op.usage?.collection || Date.parse(at) >= Date.parse(op.usage.collection.nextAt)))
    .sort((a, b) => Date.parse(a.usage?.collection?.nextAt ?? a.createdAt) - Date.parse(b.usage?.collection?.nextAt ?? b.createdAt)
      || a.id.localeCompare(b.id)).slice(0, limit);
  let artifacts = 0;
  const outcomes = [];
  for (const candidate of candidates) {
    const save = (event) => store.transact((s) => evolve(s, candidate.item, {
      operationId: candidate.id, run: candidate.owner, at, ...event }));
    try {
      let { state: current } = await save({ type: "usage-inspection" });
      let op = current.operations[candidate.id];
      if (!op.usage.execution) {
        const measurement = await actions.measure(op, context);
        if (!measurement) continue;
        ({ state: current } = await save({ type: "record-execution", usage: measurement }));
        op = current.operations[candidate.id];
      }
      if (op.mode !== "update" && !op.usage.model && op.usage.execution.ran && artifacts < artifactLimit) {
        artifacts++;
        let result;
        try {
          result = await actions.download(op, context);
          await save({ type: "record-model-usage", artifact: result.artifact, metrics: result.proposal.metrics });
        } finally { result?.dispose(); }
      }
      outcomes.push({ key: op.item, action: "account-usage", status: "measured", operationId: op.id });
    } catch {
      // Neither an unavailable Actions read nor unusable cost data can replace
      // ownership, discard code, resume work or turn an unknown into zero.
      outcomes.push({ key: candidate.item, action: "account-usage", status: "unknown", operationId: candidate.id });
    }
  }
  return outcomes;
}
