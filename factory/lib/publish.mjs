// One short publisher pass, called only by a trusted job holding factory-control.
// All code/object validation belongs to the clean Git adapter. This coordinator
// never executes project code and never gives write credentials to a worker.
import { evolve, ProtocolError } from "./protocol.mjs";
import { expectedEffectHead } from "./effects.mjs";
const sameRun = (a, b) => a?.id === b?.id && a?.attempt === b?.attempt;

export async function publishOperation({ store, itemKey, operationId, publisherRun,
  observe, writer, now = () => new Date().toISOString() }) {
  const opFrom = (state) => {
    const item = state.items[itemKey], op = state.operations[operationId];
    if (!item || item.activeOperation !== operationId || !op || op.item !== itemKey) throw new ProtocolError("stale", "Publisher operation is no longer active");
    return op;
  };
  const save = (event) => store.transact((s) => evolve(s, itemKey, { operationId, at: now(), publisher: publisherRun, ...event }));
  const inspect = async (effect, op) => {
    const receipt = await writer.inspect(effect, op);
    if (!receipt || receipt.outcome === "unknown") return false;
    await save({ type: "effect-observed", effectId: effect.id, requestId: effect.requests.at(-1).id, ...receipt });
    return true;
  };

  let { state } = await store.load();
  let op = opFrom(state);
  if (["done", "failed", "superseded"].includes(op.phase)) return { status: op.phase, operationId };
  if (op.phase === "result-ready") {
    const observation = await observe(state.items[itemKey], op);
    ({ state } = await save({ type: "authorize-publish", observation }));
    op = opFrom(state);
  }
  if (op.phase !== "publishing") return { status: op.phase, operationId };

  const resolveQuestion = async () => {
    ({ state } = await store.load()); op = opFrom(state);
    const question = state.items[itemKey].question;
    if (question?.kind === "publish-outcome" && question.recovery.operation === op.id
      && op.effects.some((e) => e.id === question.recovery.effect && ["applied", "rejected"].includes(e.status))) {
      ({ state } = await save({ type: "resolve-publish-question" })); op = opFrom(state);
    }
  };
  await resolveQuestion();

  for (const planned of op.effects) {
    ({ state } = await store.load());
    op = opFrom(state);
    let effect = op.effects.find((e) => e.id === planned.id);
    if (effect.status === "applied") continue;
    if (effect.status === "pending") {
      // An unchanged head is still unknown. This path never resends a write.
      if (!await inspect(effect, op)) return { status: "waiting", operationId, reason: "Publish request outcome is unknown" };
      await resolveQuestion();
      ({ state } = await store.load());
      op = opFrom(state);
      effect = op.effects.find((e) => e.id === planned.id);
      if (effect.status === "applied") continue;
    }

    const observation = await observe(state.items[itemKey], op);
    const expectedHead = expectedEffectHead(op, effect);
    const item = state.items[itemKey];
    const current = !item.paused && !item.complete && !item.question && op.generation === item.generation && op.revision === item.revision
      && observation.authorization?.valid === true && observation.authorization.revision === item.revision
      && observation.open === true && observation.head === expectedHead
      && (!["thread-reply", "thread-resolve"].includes(effect.type) || observation.threadRevisions?.[effect.thread] === effect.revision);
    if (!current && op.effects.every((e) => e.status !== "pending")) {
      ({ state } = await save({ type: "abandon-publish", effectId: effect.id, observation }));
      return { status: opFrom(state).phase, operationId };
    }
    if (effect.status === "rejected" && effect.requests.length
      && Date.parse(now()) < Date.parse(effect.requests.at(-1).at) + Math.min(300_000, 60_000 * 2 ** (effect.requests.length - 1))) {
      return { status: "waiting", operationId, reason: "Waiting before another bounded publish request" };
    }
    // Validate commit ancestry, tree changes and forbidden paths before the
    // durable intent. The worker's test report alone authorizes no writes.
    try { await writer.validate(effect, op); }
    catch (error) {
      await save({ type: "publish-blocked", effectId: effect.id, reason: String(error.message || "Publisher validation failed").slice(0, 2000) });
      throw error;
    }
    const fresh = await observe(state.items[itemKey], op);
    const previousCount = effect.requests.length;
    ({ state } = await save({ type: "request-effect", effectId: effect.id, observation: fresh }));
    op = opFrom(state);
    effect = op.effects.find((e) => e.id === planned.id);
    const request = effect.requests.at(-1);
    // Only the job that committed the new request can submit it. A racing
    // publisher sees somebody else's pending intent and yields to recovery.
    if (effect.status !== "pending" || effect.requests.length !== previousCount + 1 || !sameRun(request.publisher, publisherRun)) {
      return { status: "waiting", operationId, reason: "Another publisher owns this request" };
    }
    try {
      const receipt = await writer.apply(effect, op);
      if (!receipt || receipt.outcome === "unknown") return { status: "waiting", operationId, reason: "Publish response did not establish an outcome" };
      await save({ type: "effect-observed", effectId: effect.id, requestId: request.id, ...receipt });
    } catch (error) {
      // Even a failure persisting the receipt is ambiguous: the external effect
      // may be applied. Recovery must inspect it; never roll the intent back.
      return { status: "waiting", operationId, reason: "Publish or receipt write was interrupted", error };
    }
    ({ state } = await store.load());
    op = opFrom(state);
    effect = op.effects.find((e) => e.id === planned.id);
    if (effect.status !== "applied") return { status: "waiting", operationId, reason: "Publish was rejected; another bounded pass may revalidate it" };
  }
  ({ state } = await save({ type: "finish-publish" }));
  return { status: opFrom(state).phase, operationId };
}
