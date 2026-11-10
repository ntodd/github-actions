// Keeping PRs mergeable: what a resolve run checks before it starts, and
// what the two jobs that start one (the sweep after a push to the default
// branch, and a /resolve comment) decide to dispatch.

import { checkResolve, closingIssues, flakeGroup, latestLabeled, isResolveComment, FLAKE_HUNT_BOT } from "./gate.mjs";

// GitHub works out mergeable in the background, so a PR can be UNKNOWN for
// a while after a push. These are the waits between looks: about five
// minutes in all.
export const BACKOFF_MS = [5, 10, 20, 40, 60, 60, 60, 60].map((s) => s * 1000);

const lower = (s) => String(s ?? "").toLowerCase();
const short = (sha) => String(sha).slice(0, 7);
const notFound = async (promise) => {
  try {
    return await promise;
  } catch (err) {
    if (/: 404 /.test(err.message)) return null;
    throw err;
  }
};

// The PR, read again until GitHub has worked out whether it merges (or
// the PR is gone, or the waits run out).
export async function awaitMergeable({ github, pr, clock, first, backoff = BACKOFF_MS }) {
  let p = first ?? (await github.pull(pr));
  for (const ms of backoff) {
    if (!p || p.state !== "open" || p.mergeable !== "UNKNOWN") break;
    await clock.sleep(ms);
    p = await github.pull(pr);
  }
  return p;
}

// Stacks are out of scope for now: a stack/ branch (the only way the
// build makes one), or a branch another open PR is based on.
export const isStack = (pr, open) => pr.headRef.startsWith("stack/") || open.some((o) => o.number !== pr.number && o.baseRef === pr.headRef);

// What the resolve checks need to know about an issue.
async function issueFacts(github, n, label) {
  const raw = await notFound(github.issue(n));
  if (!raw || raw.pull_request) return { issue: raw, labeled: null, events: [] };
  const events = await github.labelEvents(n);
  return { issue: { ...raw, editors: await github.editors(n) }, labeled: latestLabeled(events, label), events };
}

// The issue a resolve is for: the one the PR closes, or for a flake-hunt
// group's PR, the group's first issue, whose body lists the rest.
export async function closingIssue(github, pr, repo) {
  const closing = closingIssues(pr, repo);
  if (closing.reason) return closing;
  const all = closing.issues;
  if (all.length === 1) return { issue: all[0] };
  for (const n of all) {
    const group = flakeGroup(await notFound(github.issue(n)));
    if (all.every((m) => m === n || group.includes(m))) return { issue: n };
  }
  return { reason: `#${pr.number} closes ${all.length} issues, and none of them is a flake-hunt group's first issue listing the rest` };
}

// The other issues a PR closes, for checkResolve. Only the same repo's:
// checkResolve refuses the rest without reading them.
async function othersFacts(github, pr, n, repo, label) {
  const others = {};
  for (const i of pr?.closes?.issues ?? []) {
    if (i.number !== n && lower(i.repo) === lower(repo)) others[i.number] = await issueFacts(github, i.number, label);
  }
  return others;
}

// Reads the PR a resolve was asked for (and its issue or its /resolve
// comment), runs the resolve checks, and makes sure there's still
// something to do: the head is the one that was checked, and the PR still
// conflicts. A refusal is `refused`. Anything else that stops it (a push
// in the meantime, a sweep that raced a /resolve) isn't a failure.
//
// The gate calls this with no appBot and wait: false, so UNKNOWN goes
// through to run/index.mjs, which calls it again with both.
export async function prepareResolve({ request, sender, github, repo, label, trustedUsers, appBot = null, clock, wait = true }) {
  const stop = (reason, refused = false) => ({ go: false, refused, reason });
  let pr = await github.pull(request.pr);
  let facts = { issue: null, labeled: null };
  let comment = null;
  let others = {};
  if (request.issue) {
    facts = await issueFacts(github, request.issue, label);
    others = await othersFacts(github, pr, request.issue, repo, label);
  } else if (request.comment) comment = await github.commentById(request.comment);

  const checked = () => checkResolve({ request, sender, pr, issue: facts.issue, labeled: facts.labeled, others, comment, repo, label, trustedUsers, appBot });
  let check = checked();
  if (!check.run) return stop(check.reason, true);

  const moved = () => pr.headSha !== request.head && `#${pr.number}'s head moved from ${short(request.head)} to ${short(pr.headSha)} since this was asked for`;
  if (moved()) return stop(moved());
  if (wait) {
    pr = await awaitMergeable({ github, pr: pr.number, clock, first: pr });
    if (!pr || pr.state !== "open") return stop(`#${request.pr} isn't open any more`);
    if (moved()) return stop(moved());
    // The wait can be minutes, and it's this later read that the run uses.
    check = checked();
    if (!check.run) return stop(check.reason, true);
  }
  if (pr.mergeable === "MERGEABLE") return stop(`#${pr.number} doesn't conflict with ${pr.baseRef} any more`);
  if (pr.mergeable !== "CONFLICTING" && wait) return stop(`GitHub didn't say whether #${pr.number} conflicts with ${pr.baseRef}`);
  return { go: true, kind: check.kind, pr, issue: facts.issue };
}

// The sweep: which of the App's open PRs to start a resolve run on. Only
// PRs that conflict, never ones that are just behind (those still merge,
// and updating them would only rerun CI). At most `cap`, one per issue,
// the least recently updated first, so a big batch takes turns.
//
// active: PRs with a resolve run already queued or going.
export async function planSweep({ github, repo, label, trustedUsers, appBot, clock, timeoutMs, active = [], cap = 5, backoff = BACKOFF_MS }) {
  let open = await github.openPulls();
  const mine = () => open.filter((p) => lower(p.author) === lower(appBot));
  for (const ms of backoff) {
    if (!mine().some((p) => p.mergeable === "UNKNOWN")) break;
    await clock.sleep(ms);
    open = await github.openPulls();
  }

  const picked = [];
  const skipped = [];
  const taken = new Set();
  const oldestFirst = mine().sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  for (const pr of oldestFirst) {
    const skip = (reason) => void skipped.push({ pr: pr.number, reason });
    if (pr.mergeable === "MERGEABLE") continue;
    if (pr.mergeable !== "CONFLICTING") skip("GitHub hasn't worked out whether it conflicts, so the next sweep looks again");
    else if (active.includes(pr.number)) skip("a resolve run on it is already queued or going");
    else if (pr.labels.includes("agent-conflict")) skip("it's labeled agent-conflict: a resolve run blocked on it, and it waits for you");
    else if (isStack(pr, open)) skip("it's part of a stack, and resolve runs don't handle stacks yet");
    else {
      const closing = await closingIssue(github, pr, repo);
      if (closing.reason) skip(closing.reason);
      else if (taken.has(closing.issue)) skip(`another pull request for #${closing.issue} is being resolved first`);
      else if (picked.length >= cap) skip(`a sweep starts ${cap} at a time, and the rest wait for the next one`);
      else {
        const { issue, labeled, events } = await issueFacts(github, closing.issue, label);
        // A run on the issue is still going, unless the label has been
        // there longer than a job can run: then the run died.
        const has = (name) => (issue?.labels ?? []).some((l) => (l.name ?? l) === name);
        // The build stopped short and the PR waits for the owner. A
        // resolve run that went green would hand it over as done.
        if (has("agent-blocked")) {
          skip(`#${closing.issue} is labeled agent-blocked and waits for you`);
          continue;
        }
        const working = has("agent-working");
        const since = Date.parse(latestLabeled(events, "agent-working")?.at ?? "");
        if (working && !(clock.now() - since > timeoutMs)) {
          skip(`#${closing.issue} is labeled agent-working, so a run is on it`);
          continue;
        }
        const request = { mode: "resolve", issue: closing.issue, pr: pr.number, head: pr.headSha, comment: null };
        const others = await othersFacts(github, pr, closing.issue, repo, label);
        const check = checkResolve({ request, sender: { login: FLAKE_HUNT_BOT }, pr, issue, labeled, others, repo, label, trustedUsers, appBot });
        if (!check.run) skip(check.reason);
        else {
          taken.add(closing.issue);
          picked.push({ issue: closing.issue, pr: pr.number, head: pr.headSha });
        }
      }
    }
  }
  return { picked, skipped };
}

// A workflow_dispatch's inputs are strings.
export const dispatchInputs = ({ issue, pr, head, comment }) => ({
  ...(issue ? { issue: String(issue) } : {}),
  mode: "resolve",
  pr: String(pr),
  head,
  ...(comment ? { comment: String(comment) } : {}),
});

// A comment on a PR: is it a trusted /resolve, and on what? The App's PR
// resolves for its issue. A trusted user's own PR resolves on the strength
// of the comment. Everything is read fresh from the API, not the payload.
//
// active: PRs with a resolve run already queued or going.
export async function planComment({ event, github, repo, label, trustedUsers, appBot, clock, active = [] }) {
  const trusted = new Set(trustedUsers.map(lower));
  const no = (reason) => ({ reason });
  if (event.action !== "created") return no("this isn't a new comment");
  if (!event.issue?.pull_request) return no(`#${event.issue?.number} isn't a pull request`);
  if (!isResolveComment(event.comment?.body)) return no("the comment isn't exactly /resolve");
  if (!trusted.has(lower(event.sender?.login))) return no(`${event.sender?.login} commented and isn't trusted`);
  if (!trusted.has(lower(event.comment?.user?.login))) return no(`${event.comment?.user?.login} wrote the comment and isn't trusted`);

  const number = event.issue.number;
  if (active.includes(number)) return no(`a resolve run on #${number} is already queued or going`);
  const pr = await github.pull(number);
  if (!pr) return no(`there's no pull request #${number}`);
  let request = { mode: "resolve", issue: null, pr: number, head: pr.headSha, comment: event.comment.id };
  if (lower(pr.author) === lower(appBot)) {
    const closing = await closingIssue(github, pr, repo);
    if (closing.reason) return no(closing.reason);
    request = { ...request, issue: closing.issue, comment: null };
  }
  const prep = await prepareResolve({ request, sender: event.sender, github, repo, label, trustedUsers, appBot, clock });
  if (!prep.go) return no(prep.reason);
  return { inputs: dispatchInputs(request) };
}
