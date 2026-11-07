// Reading a PR's state between rounds: its checks, whether the review bots
// have looked at the latest push, and which review threads still need an
// answer.

const PENDING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const OK = new Set(["success", "neutral", "skipped"]);

// An Actions check run's workflow run ID, from its URL, for rerunning the
// run's failed jobs.
const runId = (r) => {
  const m = /\/actions\/runs\/(\d+)\/job\/\d+/.exec(r.html_url ?? r.details_url ?? "");
  return m ? Number(m[1]) : undefined;
};

// filter=latest only collapses reruns inside one workflow run. A second run
// of the same workflow for the same event and branch (a cancelled
// duplicate, say) is another check suite, so keep the newest. Runs for
// another event, another branch or another workflow all count.
function latest(checkRuns) {
  const keep = new Map();
  for (const r of checkRuns) {
    const key = r.workflow != null ? `w${r.workflow}:${r.name}` : `s${r.check_suite?.id ?? ""}:${r.name}`;
    const prev = keep.get(key);
    if (!prev || (r.id ?? 0) > (prev.id ?? 0)) keep.set(key, r);
  }
  return [...keep.values()];
}

// checkRuns: GET /commits/{sha}/check-runs (filter=latest), each with the
// workflow it came from when that's known. statuses: the combined status's
// `statuses`, one per context.
export function summarizeChecks({ checkRuns, statuses, ignore = [] }) {
  const skip = new Set(ignore);
  const pending = [];
  const failed = [];
  let seen = 0;
  for (const r of latest(checkRuns)) {
    if (skip.has(r.name)) continue;
    seen++;
    if (PENDING.has(r.status)) pending.push(r.name);
    else if (!OK.has(r.conclusion)) failed.push({ name: r.name, conclusion: r.conclusion, url: r.html_url, run: runId(r) });
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
