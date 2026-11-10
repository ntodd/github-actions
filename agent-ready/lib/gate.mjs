// Who may start a run, in which mode, and at what effort.

import { clean } from "./status.mjs";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function parseList(text) {
  return String(text ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const login = (user) => String(user?.login ?? "").toLowerCase();

// flake-hunt files its issues with the job's GITHUB_TOKEN, as
// github-actions[bot], and starts a run on each with a workflow_dispatch.
// Only workflows in the repo can write as github-actions[bot]. Claude
// can't: its writes are the App's.
export const FLAKE_HUNT_BOT = "github-actions[bot]";
const FLAKE_HUNT_MARKER = /<!-- flake-hunt:\S+ -->/;

export function isFlakeHuntIssue(issue) {
  return login(issue?.user) === FLAKE_HUNT_BOT && FLAKE_HUNT_MARKER.test(issue?.body ?? "");
}

// A run starts when a trusted user adds the label to an open issue, or
// dispatches the workflow on an open issue that has it. Either way a
// trusted user or flake-hunt must have written the issue. flake-hunt may
// dispatch too, but only on its own issues. Everything else is skipped
// with a reason.
export function checkTrigger(event, { label, trustedUsers, eventName = "issues", issue = event.issue }) {
  const trusted = new Set(trustedUsers.map((u) => u.toLowerCase()));
  const no = (reason) => ({ run: false, reason });
  if (trusted.size === 0) return no("no trusted-users are set");
  const dispatched = eventName === "workflow_dispatch";
  if (dispatched) {
    if (!issue) return no("no issue was given");
    if (issue.pull_request) return no(`#${issue.number} is a pull request`);
    if (!(issue.labels ?? []).some((l) => (l.name ?? l) === label)) return no(`#${issue.number} isn't labeled ${label}`);
  } else {
    if (event.action !== "labeled" || !issue) return no("this isn't a labeled issue");
    if (event.label?.name !== label) return no(`the label added was ${event.label?.name}, not ${label}`);
  }
  if (issue.state !== "open") return no(`#${issue.number} isn't open`);
  const flake = isFlakeHuntIssue(issue);
  const sender = login(event.sender);
  if (dispatched && sender === FLAKE_HUNT_BOT && !trusted.has(sender)) {
    if (!flake) return no(`${FLAKE_HUNT_BOT} started the run, and it may only start runs on flake-hunt's issues`);
  } else if (!trusted.has(sender)) {
    return no(`${event.sender?.login} ${dispatched ? "started the run" : "added the label"} and isn't trusted`);
  }
  if (!trusted.has(login(issue.user)) && !flake) return no(`${issue.user?.login} wrote the issue and isn't trusted`);
  const editor = untrustedEditor(issue, trustedUsers);
  if (editor) return no(`${editor} edited #${issue.number} and isn't trusted`);
  return { run: true };
}

// What the event asks for. Only a workflow_dispatch can ask for anything
// but a build: no mode means build, "resolve" means resolve, and anything
// else is an error, so a mode this version doesn't know never runs as a
// build. The gate and run/index.mjs both read the mode through here.
const positive = (v) => (/^[1-9]\d{0,14}$/.test(String(v ?? "")) ? Number(v) : null);
const given = (v) => v != null && v !== "";

export function parseRequest(eventName, inputs) {
  if (eventName !== "workflow_dispatch") return { mode: "build" };
  const i = inputs ?? {};
  if (!given(i.mode)) return { mode: "build", issue: positive(i.issue) };
  if (i.mode !== "resolve") return { error: `"${clean(String(i.mode), 40)}" isn't a mode agent-ready knows` };
  const no = (what) => ({ error: `a resolve run needs ${what}` });
  const pr = positive(i.pr);
  if (!pr) return no("the pull request's number");
  if (!/^[0-9a-f]{40}$/.test(String(i.head ?? ""))) return no("the pull request's head SHA from when it was checked");
  const issue = positive(i.issue);
  if (given(i.issue) && !issue) return no("an issue number, if it names an issue");
  const comment = positive(i.comment);
  if (given(i.comment) && !comment) return no("a comment ID, if it names a comment");
  if (issue && comment) return no("an issue or a comment, not both");
  if (!issue && !comment) return no("the issue the pull request closes, or the /resolve comment that asked for it");
  return { mode: "resolve", issue, pr, head: i.head, comment };
}

export const isResolveComment = (body) => String(body ?? "").trim() === "/resolve";

// The last time the label was added. events: github.labelEvents, oldest first.
export const latestLabeled = (events, label) => events.filter((e) => e.label === label).at(-1) ?? null;

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

// The issues a PR closes, all in this repo. Anything else is refused:
// none, one in another repo (other/repo#7 is never #7), or a list GitHub
// only gave part of.
export function closingIssues(pr, repo) {
  const c = pr.closes;
  if (!c || c.more || c.total !== c.issues?.length) return { reason: `couldn't read everything #${pr.number} closes` };
  if (c.total === 0) return { reason: `#${pr.number} closes 0 issues` };
  const away = c.issues.find((i) => !same(i.repo, repo));
  if (away) return { reason: `#${pr.number} closes ${away.repo}#${away.number}, which is in another repo` };
  return { issues: c.issues.map((i) => i.number) };
}

// flake-hunt's report groups the flakes of one hunt that fail the same
// way. The group's first issue lists the others in its body, which only
// flake-hunt or a trusted user can have written (untrustedEditor). The
// list sits right before the key marker at the end: a failure message or
// a diagnosis earlier in the body can hold anything.
const FLAKE_GROUP_MARKER = /<!-- flake-hunt-group:([\d,]+) -->\s*<!-- flake-hunt:\S+ -->\s*$/;

export function flakeGroup(issue) {
  if (!isFlakeHuntIssue(issue)) return [];
  const m = FLAKE_GROUP_MARKER.exec(issue.body);
  return m ? m[1].split(",").filter(Boolean).map(Number) : [];
}

// "#1", "#1 and #2", "#1, #2 and #3".
export const numberList = (ns) => {
  const t = ns.map((n) => `#${n}`);
  return t.length < 2 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
};

// Who may start a resolve run, and on what. A PR being the App's, or
// saying it closes an issue, isn't enough: Claude can open and edit PRs in
// publish phases. So an agent PR needs an issue a trusted user wrote and
// labeled (the label is gone by now, because every run removes it, so the
// proof is the issue's timeline, which the App can't forge), and a PR
// opened after that label that closes that issue (and, for a flake-hunt
// group, the others alsoCloses allows, in others). A trusted user's own PR needs their /resolve comment on it. appBot is the
// App's login. Only null skips that check: the gate doesn't know the login
// and passes null, and run/index.mjs checks it before Claude starts.
export function checkResolve({ request, sender, pr, issue, labeled, others = {}, comment, repo, label, trustedUsers, appBot }) {
  const trusted = new Set(trustedUsers.map((u) => u.toLowerCase()));
  const no = (reason) => ({ run: false, reason });
  if (trusted.size === 0) return no("no trusted-users are set");
  const by = login(sender);
  // The /resolve job and the sweep dispatch as github-actions[bot].
  if (!trusted.has(by) && by !== FLAKE_HUNT_BOT) return no(`${sender?.login} started the run and isn't trusted`);
  if (!pr) return no(`there's no pull request #${request.pr}`);
  const n = `#${pr.number}`;
  if (pr.state !== "open") return no(`${n} isn't open`);
  if (!same(pr.headRepo, repo)) return no(`${n}'s branch is in ${pr.headRepo || "a repo that's gone"}, not ${repo}`);
  if (!pr.baseRef || pr.baseRef !== pr.defaultBranch) return no(`${n} goes into ${pr.baseRef}, not ${pr.defaultBranch}`);
  // The branch names go into the commands Claude is given, and git allows
  // far more in a ref than a shell reads as a plain word.
  if (![pr.headRef, pr.baseRef].every((ref) => /^[\w][\w./-]*$/.test(ref ?? ""))) return no(`${n}'s branch names have characters a resolve run won't put in a command`);

  if (!request.issue) {
    if (!trusted.has(String(pr.author ?? "").toLowerCase())) return no(`${pr.author} opened ${n} and isn't trusted`);
    // The title and description are all Claude has for what the PR means
    // to do, and the App's token can edit them.
    const editor = (pr.editors ?? ["(unknown)"]).find((e) => !trusted.has(String(e).toLowerCase()));
    if (editor) return no(`${editor} edited ${n}'s title or description and isn't trusted`);
    // The dispatch came from github-actions[bot], which proves nothing
    // about who asked. The comment does.
    if (!comment) return no(`there's no /resolve comment ${request.comment}`);
    if (comment.pr !== pr.number) return no(`comment ${request.comment} isn't on ${n}`);
    if (!isResolveComment(comment.body)) return no(`comment ${request.comment} doesn't say /resolve`);
    if (!trusted.has(String(comment.author ?? "").toLowerCase())) return no(`${comment.author} wrote the /resolve comment and isn't trusted`);
    return { run: true, kind: "own" };
  }

  if (!issue) return no(`there's no issue #${request.issue}`);
  const i = `#${issue.number}`;
  if (issue.pull_request) return no(`${i} is a pull request, not an issue`);
  if (issue.state !== "open") return no(`${i} isn't open`);
  const flake = isFlakeHuntIssue(issue);
  if (!trusted.has(login(issue.user)) && !flake) return no(`${issue.user?.login} wrote the issue and isn't trusted`);
  const editor = untrustedEditor(issue, trustedUsers);
  if (editor) return no(`${editor} edited ${i} and isn't trusted`);
  if (!labeled) return no(`nobody labeled ${i} ${label}`);
  const labeler = String(labeled.actor ?? "").toLowerCase();
  if (!trusted.has(labeler) && !(flake && labeler === FLAKE_HUNT_BOT)) return no(`${labeled.actor} last labeled ${i} ${label} and isn't trusted`);
  if (appBot !== null && !same(pr.author, appBot)) return no(`${pr.author} opened ${n}, not ${appBot}`);
  if (!(Date.parse(pr.createdAt) > Date.parse(labeled.at))) return no(`${n} was opened before ${i} was last labeled ${label}`);
  const closing = closingIssues(pr, repo);
  if (closing.reason) return no(closing.reason);
  if (!closing.issues.includes(issue.number)) return no(`${n} closes ${numberList(closing.issues)}, not ${i}`);
  for (const m of closing.issues.filter((x) => x !== issue.number)) {
    const why = alsoCloses({ m, n, i, issue, flake, other: others?.[m], trustedUsers });
    if (why) return no(why);
  }
  return { run: true, kind: "agent" };
}

// A flake-hunt group's PR closes the group's first issue and any of the
// others the fix covered. Each of those has to be in the first issue's
// group, flake-hunt's, and unedited. The group is the proof: flake-hunt
// labels nearly every issue it files, so a label proves nothing about
// this PR. Closed is fine: the owner may have closed a duplicate by hand.
// others: { [number]: { issue, labeled } }.
function alsoCloses({ m, n, i, issue, flake, other, trustedUsers }) {
  if (!flake) return `${n} also closes #${m}, and only a flake-hunt group's pull request closes more than one issue`;
  if (!flakeGroup(issue).includes(m)) return `${n} also closes #${m}, which isn't in ${i}'s group`;
  const o = other?.issue;
  if (!o) return `there's no issue #${m}`;
  if (o.pull_request) return `#${m} is a pull request, not an issue`;
  if (!isFlakeHuntIssue(o)) return `#${m} isn't one of flake-hunt's issues`;
  const editor = untrustedEditor(o, trustedUsers);
  if (editor) return `${editor} edited #${m} and isn't trusted`;
  return null;
}

// Who edited the issue's body or title (issue.editors, from the gate),
// other than a trusted user, or flake-hunt on its own issue. The App's
// token can edit any issue, so without this Claude could rewrite one and
// have it worked the next time it's labeled, or flake-hunt reopens it.
export function untrustedEditor(issue, trustedUsers) {
  const trusted = new Set(trustedUsers.map((u) => u.toLowerCase()));
  const flake = isFlakeHuntIssue(issue);
  return (issue.editors ?? []).find((e) => {
    const l = String(e).toLowerCase();
    return !trusted.has(l) && !(flake && l === FLAKE_HUNT_BOT);
  });
}

// Sub-issues are the run's set, so only a trusted user's count. The App
// can add sub-issues too.
export function trustedSubIssues(subIssues, trustedUsers) {
  const trusted = new Set(trustedUsers.map((u) => u.toLowerCase()));
  return subIssues.filter((s) => trusted.has(String(s.user ?? "").toLowerCase()));
}

export function trustedComments(comments, trustedUsers) {
  const trusted = new Set(trustedUsers.map((u) => u.toLowerCase()));
  return comments.filter((c) => trusted.has(login(c.user)));
}

// An effort:<level> label wins (the highest, if there are several). Then
// the last /effort <level> in a trusted comment. Then the default.
export function resolveEffort({ labels, comments, trustedUsers, defaultEffort }) {
  const fromLabels = labels
    .map((l) => /^effort:\s*(\w+)$/i.exec(l.name ?? "")?.[1]?.toLowerCase())
    .filter((e) => EFFORTS.includes(e));
  if (fromLabels.length) return fromLabels.reduce((a, b) => (EFFORTS.indexOf(b) > EFFORTS.indexOf(a) ? b : a));

  let fromComment;
  for (const c of trustedComments(comments, trustedUsers)) {
    for (const m of String(c.body ?? "").matchAll(/^\/effort\s+(\w+)/gim)) {
      if (EFFORTS.includes(m[1].toLowerCase())) fromComment = m[1].toLowerCase();
    }
  }
  return fromComment ?? defaultEffort;
}
