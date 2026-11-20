// Restart is a controller operation, never a worker instruction to close PRs.
// The old worker/publication must be terminal before any replacement is built.
import { evolve, TERMINAL } from "./protocol.mjs";

export function restartService({ api, store, effects, appLogin, now = () => new Date().toISOString() }) {
  const read = async (key) => {
    const { state } = await store.load();
    const item = state.items[key];
    if (!item?.restart) throw new Error("No recorded restart");
    return { state, item, restart: item.restart };
  };
  const definition = (item, kind, target, payload) => ({ kind, target, payload,
    guard: { generation: item.restart.generation, revision: item.restart.revision, commandId: item.restart.commandId } });
  const current = async (key) => {
    const { item, restart } = await read(key);
    return !item.paused && !item.question && restart.generation === item.generation && restart.revision === item.revision
      && item.commands[restart.commandId]?.status === "queued"
      && await effects.workGuard(key, definition(item, "restart", Number(key.split(":")[1]), {}));
  };
  async function abandon(key, reason) {
    const { item, restart } = await read(key);
    if (Object.values(item.apiEffects ?? {}).some((e) => e.definition.guard?.commandId === restart.commandId
      && ["pr-close", "issue-reopen"].includes(e.definition.kind) && e.status === "pending")) return { status: "waiting", reason: "A restart request still has an unknown outcome" };
    await store.transact((s) => {
      const r = s.items[key].restart;
      if (["done", "superseded"].includes(r.phase)) return s;
      s = evolve(s, key, { type: "abandon-restart", commandId: r.commandId, reason, at: now() });
      if (!s.items[key].paused && !s.items[key].question) s = evolve(s, key, { type: "ask", reason, at: now() });
      return s;
    });
    return { status: "superseded", reason };
  }
  return async ({ key }) => {
    let { state, item, restart } = await read(key);
    if (["done", "superseded"].includes(restart.phase)) return { status: restart.phase };
    const op = state.operations[item.activeOperation];
    if (item.continuation?.phase === "requested") return { status: "waiting", reason: "Recover the issue continuation before restarting" };
    if (op && !TERMINAL.has(op.phase)) return { status: "waiting", reason: "Recover the previous worker and publication first" };
    if (restart.phase === "requested") {
      if (!await current(key)) return abandon(key, "Restart intent changed; post a new restart command to continue");
      const targets = [];
      for (const record of item.prs) {
        const pr = await api.pull(record.number);
        if (pr.state !== "open") continue;
        if (pr.user?.login?.toLowerCase() !== appLogin.toLowerCase()) return abandon(key, `Recorded PR #${pr.number} is not owned by the App; decide its disposition before restarting`);
        targets.push({ number: pr.number, head: pr.head.sha, slot: `restart:${key}:${restart.commandId}:close:${pr.number}` });
      }
      const issue = await api.issue(Number(key.split(":")[1]));
      const reopenSlot = issue.state === "closed" ? `restart:${key}:${restart.commandId}:reopen` : null;
      await store.transact((s) => evolve(s, key, { type: "plan-restart", commandId: restart.commandId,
        targets, retire: item.prs.map((p) => p.number), reopenSlot, at: now() }));
      ({ state, item, restart } = await read(key));
    }
    if (restart.phase === "ready") {
      if (!await current(key)) return abandon(key, "Restart was paused or changed before its replacement build");
      return { status: "ready" };
    }
    const perform = async (slot, def) => effects.execute(key, slot, def, () => current(key));
    if (restart.reopenSlot) {
      const result = await perform(restart.reopenSlot, definition(item, "issue-reopen", Number(key.split(":")[1]), {}));
      if (result.status !== "applied") {
        if (!await current(key) || result.status === "superseded") return abandon(key, "Restart intent changed while reopening the issue");
        return { status: "waiting", reason: "Recover the issue-reopen request before closing PRs" };
      }
    }
    for (const target of restart.targets) {
      const def = definition(item, "pr-close", target.number, { head: target.head });
      const result = await effects.execute(key, target.slot, def, async () => await current(key) && await effects.workGuard(key, def));
      if (result.status !== "applied") {
        if (!await current(key) || result.status === "superseded") return abandon(key, `Restart inputs changed while closing PR #${target.number}; post a new restart command to continue`);
        return { status: "waiting", reason: `Recover the close request for PR #${target.number}` };
      }
    }
    if (!await current(key)) return abandon(key, "Restart was paused or changed after closing its PRs");
    const observations = [];
    for (const number of restart.retire) {
      const pr = await api.pull(number);
      if (pr.state === "open") return abandon(key, `PR #${number} reopened during restart; post a new restart command to include it`);
      observations.push({ type: "pr-observed", number, state: pr.merged_at ? "merged" : "closed", mergedSha: pr.merged_at ? pr.merge_commit_sha : null });
    }
    await store.transact((s) => {
      for (const event of observations) s = evolve(s, key, { ...event, at: now() });
      return evolve(s, key, { type: "finish-restart", commandId: restart.commandId, at: now() });
    });
    return { status: "ready" };
  };
}
