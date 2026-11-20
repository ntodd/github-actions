// No project code is checked out or executed here. All definitions have already
// passed the item's typed API journal, and new writes also need a fresh guard.
export function apiWriter({ api, write, appLogin }) {
  const own = (row) => row?.user?.login?.toLowerCase() === appLogin.toLowerCase();
  const done = (d, fields = {}) => ({ outcome: "applied", receipt: { kind: d.kind, target: d.target, ...fields } });
  const unknown = () => ({ outcome: "unknown" });
  const targetOf = (row) => Number(/\/(?:issues|pulls)\/(\d+)$/.exec(row?.issue_url ?? row?.pull_request_url ?? "")?.[1]);
  const commentReceipt = (d, c) => c && own(c) && targetOf(c) === d.target && c.body?.includes(d.payload.marker)
    && (d.kind === "comment-create" || c.id === d.payload.id && c.body === d.payload.body) ? done(d, { id: c.id }) : unknown();
  async function stateReceipt(d, effect) {
    const wanted = d.kind === "issue-reopen" ? "open" : "closed";
    const actual = d.kind === "pr-close" ? await api.pull(d.target) : await api.issue(d.target);
    if (effect?.status !== "pending" && actual.state === wanted) return done(d, { state: wanted, proof: "observation" });
    const events = await api.events(d.target);
    if (!Array.isArray(events) || events.some((e) => !(typeof e.id === "string" && /^[1-9]\d*$/.test(e.id)
      || Number.isSafeInteger(e.id) && e.id > 0))) throw new Error("Issue-state history lacks stable event identities");
    const stateCursor = events.reduce((last, e) => BigInt(e.id) > BigInt(last) ? String(e.id) : last, "0");
    if (effect?.status === "pending") {
      const request = effect.requests.at(-1);
      // Existing state alone cannot prove a sent request finished. Require an
      // App event newer than the complete preflight history and request time.
      const event = request.stateCursor === undefined ? null : events.find((e) => e.event === (wanted === "open" ? "reopened" : "closed")
        && own({ user: e.actor }) && BigInt(e.id) > BigInt(request.stateCursor)
        && Date.parse(e.created_at) >= Math.floor(Date.parse(request.at) / 1000) * 1000);
      if (event) return done(d, { state: wanted, proof: "timeline", eventId: String(event.id), eventAt: event.created_at });
    }
    return { outcome: "unknown", stateCursor };
  }
  async function inspect(d, effect) {
    const p = d.payload;
    switch (d.kind) {
      case "comment-create": {
        const matches = (await write.comments(d.target)).filter((c) => own(c) && c.body?.includes(p.marker));
        if (matches.length > 1) throw new Error("Several App comments claim one surface identity");
        return commentReceipt(d, matches[0]);
      }
      case "comment-edit": return commentReceipt(d, await write.commentById("issue-comment", p.id));
      case "reaction": {
        const found = (await write.reactions(p.sourceKind, p.id)).find((r) => own(r) && r.content === p.content);
        return found ? done(d, { id: found.id }) : unknown();
      }
      case "label-add":
      case "label-remove": {
        const present = (await api.issue(d.target)).labels.some((l) => (l.name ?? l) === p.label);
        return present === (d.kind === "label-add") ? done(d, { label: p.label }) : unknown();
      }
      case "ready": {
        const pr = await api.pull(d.target);
        return own(pr) && pr.head?.sha === p.head && pr.draft === false ? done(d, { head: p.head, draft: false }) : unknown();
      }
      case "review-request": {
        const pr = await api.pull(d.target);
        if (!own(pr) || pr.head?.sha !== p.head) return unknown();
        const current = new Set((pr.requested_reviewers ?? []).map((r) => r.login.toLowerCase()));
        // A completed review on this head also fulfills the attention request;
        // do not notify again just because GitHub removed it from the list.
        for (const r of await api.reviews(d.target)) if (r.commitSha === p.head && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(r.state)) current.add(r.author.toLowerCase());
        return p.reviewers.every((r) => current.has(r)) ? done(d, { head: p.head, reviewers: p.reviewers }) : unknown();
      }
      case "pr-close":
      case "issue-close":
      case "issue-reopen": return stateReceipt(d, effect);
      case "ci-rerun": {
        const run = await api.run(p.runId);
        return String(run.id) === p.runId && run.head_sha === p.runHead && Number.isSafeInteger(run.run_attempt)
          && run.run_attempt > p.attempt ? done(d, { runId: p.runId, attempt: run.run_attempt }) : unknown();
      }
      default: throw new Error("Unsupported controller API effect");
    }
  }
  return {
    inspect,
    async apply(d) {
      const p = d.payload;
      try {
        switch (d.kind) {
          case "comment-create": return commentReceipt(d, await write.comment(d.target, p.body));
          case "comment-edit": return commentReceipt(d, await write.editComment(p.id, p.body));
          case "reaction": {
            const r = await write.react(p.sourceKind, p.id, p.content);
            return own(r) && r.content === p.content ? done(d, { id: r.id }) : unknown();
          }
          case "label-add": await write.addLabels(d.target, [p.label]); break;
          case "label-remove": await write.removeLabel(d.target, p.label); break;
          case "ready": {
            const pr = await write.ready(p.nodeId);
            return pr.number === d.target && pr.headRefOid === p.head && pr.isDraft === false ? done(d, { head: p.head, draft: false }) : unknown();
          }
          case "review-request": await write.requestReviewers(d.target, p.reviewers); break;
          case "pr-close": await write.closePull(d.target); return done(d, { state: "closed", proof: "response" });
          case "issue-close": await write.closeIssue(d.target); return done(d, { state: "closed", proof: "response" });
          case "issue-reopen": await write.reopenIssue(d.target); return done(d, { state: "open", proof: "response" });
          case "ci-rerun": await write.rerunFailedJobs(p.runId); break;
          default: throw new Error("Unsupported controller API effect");
        }
      } catch (error) {
        // A transport/5xx failure is not a rejection. A known 4xx response
        // establishes that this request failed and allows a bounded retry.
        if ([400, 401, 403, 404, 409, 410, 422].includes(error.status)) return { outcome: "rejected", status: error.status };
        throw error;
      }
      // Failure reading a receipt after a successful mutation is uncertain;
      // never misclassify that read's 4xx as rejection of the mutation itself.
      return inspect(d);
    },
  };
}
