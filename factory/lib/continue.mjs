// Reopening an early-closed issue is an explicit human decision. Its API
// request keeps ownership through response loss, stop and source changes.
import { evolve } from "./protocol.mjs";

export function continueService({ api, store, effects, now = () => new Date().toISOString() }) {
  const read = async (key) => {
    const { state } = await store.load(), item = state.items[key];
    if (!item?.continuation) throw new Error("No recorded issue continuation");
    return { item, continuation: item.continuation };
  };
  const definition = (item) => ({ kind: "issue-reopen", target: Number(item.key.split(":")[1]), payload: {},
    guard: { generation: item.continuation.generation, revision: item.continuation.revision, commandId: item.continuation.commandId } });
  const current = async (key) => {
    const { item, continuation: c } = await read(key);
    return !item.paused && !item.question && c.generation === item.generation && c.revision === item.revision
      && item.commands[c.commandId].status === "queued" && await effects.workGuard(key, definition(item));
  };
  async function abandon(key, reason, closed = false) {
    await store.transact((s) => {
      const item = s.items[key], c = item.continuation;
      if (c.phase !== "requested") return s;
      s = evolve(s, key, { type: "abandon-continuation", commandId: c.commandId, reason, at: now() });
      if (!s.items[key].paused && !s.items[key].question) s = evolve(s, key, { type: "ask", at: now(),
        reason: `${reason}${closed ? "\n\nReply /agent answer continue to try reopening the issue again, or /agent stop to keep it closed." : ""}`,
        ...(closed ? { kind: "issue-closure" } : {}) });
      return s;
    });
    return { status: "superseded", reason };
  }
  return async ({ key, context }) => {
    let { item, continuation: c } = await read(key);
    if (c.phase !== "requested") return { status: c.phase };
    const def = definition(item);
    // Another sent state change may still arrive. Do not undo it on the
    // assumption that the issue's current state establishes its outcome.
    for (const older of Object.values(item.apiEffects ?? {}).filter((e) => e.slot !== c.slot && e.status === "pending"
      && e.definition.target === def.target && ["issue-close", "issue-reopen"].includes(e.definition.kind))) {
      const outcome = await effects.execute(key, older.slot, older.definition, undefined, true);
      if (outcome.status === "pending") return { status: "waiting", reason: "An earlier issue-state request still has an unknown outcome" };
    }
    let effect = Object.values(item.apiEffects ?? {}).find((e) => e.slot === c.slot);
    // Recover a sent request even when the authorizing source disappeared or
    // stop won the race. This branch never submits a new request.
    if (effect && ["pending", "applied"].includes(effect.status)) effect = await effects.execute(key, c.slot, def, undefined, true);
    if (effect?.status === "pending") return { status: "waiting", reason: "The issue-reopen request has an unknown outcome" };
    if (effect?.status !== "applied") {
      if (!await current(key) || effect?.status === "superseded") return abandon(key, "The continue request was paused or changed; no new reopening will be sent");
      const deadline = Date.parse(c.createdAt) + (context?.config?.timeouts?.publishMinutes ?? 15) * 60_000;
      if (Date.parse(now()) >= deadline || effect?.status === "rejected" && effect.requests.length >= 3) {
        return abandon(key, "The issue could not be reopened within its deadline or request budget", (await api.issue(def.target)).state === "closed");
      }
      effect = await effects.execute(key, c.slot, def, () => current(key));
      if (effect.status !== "applied") return effect.status === "superseded"
        ? abandon(key, "The continue request changed before the issue was reopened")
        : { status: "waiting", reason: "Recover the recorded reopen request before continuing work" };
    }
    // A previously successful reopen is not permission to reopen it again if
    // a person closed the issue while its receipt was being recovered.
    const actual = await api.issue(def.target);
    if (actual.state !== "open") return abandon(key, "The issue closed again after its recorded reopening; a fresh decision is needed", actual.state === "closed");
    await store.transact((s) => evolve(s, key, { type: "finish-continuation", commandId: c.commandId, issueOpen: true, at: now() }));
    return { status: "done" };
  };
}
