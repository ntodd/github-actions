// Reading a PR's state between rounds: its checks, whether the review bots
// have looked at the latest push, and which review threads still need an
// answer.

const PENDING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const OK = new Set(["success", "neutral", "skipped"]);

// checkRuns: GET /commits/{sha}/check-runs (filter=latest). statuses: the
// combined status's `statuses`, one per context.
export function summarizeChecks({ checkRuns, statuses, ignore = [] }) {
  const skip = new Set(ignore);
  const pending = [];
  const failed = [];
  let seen = 0;
  for (const r of checkRuns) {
    if (skip.has(r.name)) continue;
    seen++;
    if (PENDING.has(r.status)) pending.push(r.name);
    else if (!OK.has(r.conclusion)) failed.push({ name: r.name, conclusion: r.conclusion, url: r.html_url });
  }
  for (const s of statuses) {
    if (skip.has(s.context)) continue;
    seen++;
    if (s.state === "pending") pending.push(s.context);
    else if (s.state !== "success") failed.push({ name: s.context, conclusion: s.state, url: s.target_url });
  }
  const state = pending.length ? "pending" : failed.length ? "failure" : seen ? "success" : "none";
  return { state, pending, failed };
}

export const botLogin = (login) => String(login ?? "").toLowerCase().replace(/\[bot\]$/, "");

// A bot has settled when it has reviewed the head commit, or commented (or
// edited its summary comment) since the push.
export function botsSettled({ bots, reviews, comments, headSha, since }) {
  const waitingFor = bots.map(botLogin).filter((bot) => {
    const reviewed = reviews.some((r) => botLogin(r.user?.login) === bot && r.commit_id === headSha);
    const commented = comments.some((c) => botLogin(c.user?.login) === bot && (c.updated_at ?? c.created_at) > since);
    return !reviewed && !commented;
  });
  return { settled: waitingFor.length === 0, waitingFor };
}

// threads: GraphQL reviewThreads nodes. Only threads a trusted user or a
// listed bot started count; anyone else's are not instructions.
export function openThreads(threads, { trustedUsers, bots }) {
  const allowed = new Set([...trustedUsers.map((u) => u.toLowerCase()), ...bots.map(botLogin)]);
  return threads
    .filter((t) => !t.isResolved)
    .map((t) => ({ t, first: t.comments?.nodes?.[0] }))
    .filter(({ first }) => first && allowed.has(botLogin(first.author?.login)))
    .map(({ t, first }) => ({
      id: t.id,
      author: first.author.login,
      path: t.path,
      line: t.line,
      outdated: Boolean(t.isOutdated),
      url: first.url,
      body: first.body,
    }));
}
