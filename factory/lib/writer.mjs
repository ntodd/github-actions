import { effectMarker, validEffect } from "./effects.mjs";
import { renderAttachments } from "./attachments.mjs";
const positive = (n) => Number.isSafeInteger(n) && n > 0;
export function publisherWriter({ git, api, read, repo, appLogin, attachments }) {
  const matches = (p, effect, op) => p.head?.ref === effect.head && p.base?.ref === effect.base
    && p.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase()
    && p.user?.login?.toLowerCase() === appLogin.toLowerCase() && p.body?.includes(effectMarker(op, effect));
  function receipt(pr, effect) {
    if (!positive(pr.number) || !["open", "closed"].includes(pr.state)) return { outcome: "unknown" };
    return { outcome: "applied", evidence: { kind: "pull-request", number: pr.number,
      state: pr.merged_at ? "merged" : pr.state, mergedSha: pr.merged_at ? pr.merge_commit_sha : null,
      head: effect.head, base: effect.base, commit: effect.commit } };
  }
  const thread = async (effect) => {
    if (!read) throw new Error("Thread publication requires the read-only API adapter");
    const found = (await read.threads(effect.number)).find((t) => t.id === effect.thread);
    if (!found) throw new Error("The assigned thread no longer belongs to the recorded PR");
    return found;
  };
  const replyReceipt = (comment, effect, op) => comment && comment.author?.toLowerCase() === appLogin.toLowerCase()
    && comment.body?.includes(effectMarker(op, effect))
    ? { outcome: "applied", evidence: { kind: "thread-reply", number: effect.number, thread: effect.thread, id: comment.nodeId ?? comment.id } }
    : { outcome: "unknown" };
  return {
    async validate(effect, op) {
      if (!validEffect(effect, op)) throw new Error("Effect exceeds the recorded operation");
      if (effect.type === "push") {
        for (const image of op.effects.filter((e) => e.type === "attachment")) {
          if (!attachments) throw new Error("The clean attachment adapter is required");
          await attachments.validate(image, op);
        }
        return git.validate(effect, op);
      }
      if (effect.type === "attachment") {
        if (!attachments) throw new Error("The clean attachment adapter is required");
        return attachments.validate(effect, op);
      }
      if (effect.body) renderAttachments(effect.body, op);
      if (["thread-reply", "thread-resolve"].includes(effect.type)) {
        await thread(effect);
        const pr = await read.pull(effect.number);
        if (pr.state !== "open" || pr.user?.login?.toLowerCase() !== appLogin.toLowerCase()
          || pr.head?.ref !== op.target.branch || pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) throw new Error("The assigned PR is no longer an open App-owned branch");
        return;
      }
      const prs = await api.pullsForBranch(effect.head, effect.base);
      if (prs.some((p) => p.state === "open" && !matches(p, effect, op))) throw new Error("The reserved branch already has an unrelated PR");
    },
    async inspect(effect, op) {
      if (effect.type === "push") return git.inspect(effect, op);
      if (effect.type === "attachment") return attachments ? attachments.inspect(effect, op) : { outcome: "unknown" };
      if (effect.type === "thread-reply") {
        const matches = (await thread(effect)).comments.filter((c) => c.author?.toLowerCase() === appLogin.toLowerCase() && c.body?.includes(effectMarker(op, effect)));
        if (matches.length > 1) throw new Error("Several replies claim one effect");
        return replyReceipt(matches[0], effect, op);
      }
      if (effect.type === "thread-resolve") return (await thread(effect)).isResolved
        ? { outcome: "applied", evidence: { kind: "thread-resolve", number: effect.number, thread: effect.thread, resolved: true } }
        : { outcome: "unknown" };
      const prs = (await api.pullsForBranch(effect.head, effect.base)).filter((p) => matches(p, effect, op));
      if (prs.length > 1) throw new Error("Multiple PRs claim this publish effect");
      return prs.length ? receipt(prs[0], effect) : { outcome: "unknown" };
    },
    async apply(effect, op) {
      if (effect.type === "push") return git.apply(effect, op);
      if (effect.type === "attachment") return attachments.apply(effect, op);
      try {
        if (effect.type === "thread-reply") {
          const comment = await api.replyThread(effect.thread, `${renderAttachments(effect.body, op)}\n\n${effectMarker(op, effect)}`, `${op.id}/${effect.id}`);
          return comment?.pullRequest?.number === effect.number ? replyReceipt(comment, effect, op) : { outcome: "unknown" };
        }
        if (effect.type === "thread-resolve") {
          const current = await thread(effect);
          if (current.isResolved) return { outcome: "applied", evidence: { kind: "thread-resolve", number: effect.number, thread: effect.thread, resolved: true } };
          const resolved = await api.resolveThread(effect.thread, `${op.id}/${effect.id}`);
          return resolved?.id === effect.thread && resolved?.isResolved === true && resolved?.pullRequest?.number === effect.number
            ? { outcome: "applied", evidence: { kind: "thread-resolve", number: effect.number, thread: effect.thread, resolved: true } } : { outcome: "unknown" };
        }
        const pr = await api.createPull({ head: effect.head, base: effect.base, title: effect.title,
          body: `${renderAttachments(effect.body, op)}\n\n${effectMarker(op, effect)}` });
        return matches(pr, effect, op) ? receipt(pr, effect) : { outcome: "unknown" };
      } catch (error) {
        if ([400, 401, 403, 404, 409, 410, 422].includes(error.status)) return { outcome: "rejected", evidence: { kind: "http-rejection", status: error.status } };
        throw error;
      }
    },
    dispose() { git.dispose(); },
  };
}
