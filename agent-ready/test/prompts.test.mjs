import { test } from "node:test";
import assert from "node:assert/strict";
import { renderer, fill } from "../lib/prompts.mjs";

test("fill replaces known placeholders and leaves unknown ones", () => {
  assert.equal(fill("{{a}} and {{b}}", { a: "x" }), "x and {{b}}");
});

const render = renderer({ owner: "ntodd", state: "/tmp/state", bot: "ntodd-agent[bot]" });
const issue = {
  number: 7,
  title: "Counter skips 3",
  body: "It goes 1, 2, 4.",
  labels: ["agent-ready", "bug"],
  comments: [{ user: { login: "ntodd" }, body: "Also on mobile.", created_at: "2026-11-07T12:00:00Z" }],
  subIssues: [{ number: 8, title: "Part one", state: "open" }],
};

test("build has the issue, ntodd's comments, sub-issues and the state dir", () => {
  const p = render("build", { repo: "ntodd/sandbox", issue });
  assert.match(p, /# Issue #7: Counter skips 3/);
  assert.match(p, /It goes 1, 2, 4\./);
  assert.match(p, /### Comments from ntodd\n\n\*\*ntodd\*\*, 2026-11-07:\n\nAlso on mobile\./);
  assert.match(p, /### Sub-issues\n\n- #8 Part one \(open\)/);
  assert.match(p, /Labels: agent-ready, bug/);
  assert.match(p, /\/tmp\/state\/outcome\.json/);
  assert.doesNotMatch(p, /\{\{/);
});

test("publish picks the first-round or later-round prompt", () => {
  assert.match(render("publish", { repo: "r", issue, round: 0 }), /open the pull requests as drafts/);
  assert.match(render("publish", { repo: "r", issue, round: 2 }), /Publish phase, round 2/);
});

test("respond lists the failures, the threads and the bots that never showed", () => {
  const p = render("respond", {
    repo: "r",
    issue,
    round: 1,
    failed: [{ pr: 5, name: "test", conclusion: "failure", url: "https://ci/1" }],
    threads: [{ pr: 5, id: "T1", author: "coderabbitai", path: "lib/a.ex", line: 3, outdated: false, url: "https://t/1", body: "Nil?\nMaybe." }],
    waitingFor: ["coderabbitai on #5"],
  });
  assert.match(p, /- #5 test: failure \(https:\/\/ci\/1\)/);
  assert.match(p, /- #5 thread T1 by coderabbitai at lib\/a\.ex:3 \(https:\/\/t\/1\)\n  > Nil\?\n  > Maybe\./);
  assert.match(p, /didn't review in time: coderabbitai on #5/);
  assert.doesNotMatch(p, /\{\{/);
});

test("respond says none when a list is empty", () => {
  const p = render("respond", { repo: "r", issue, round: 1, failed: [], threads: [], waitingFor: [] });
  assert.match(p, /### Failed checks\nNone\./);
  assert.match(p, /### Open review threads\nNone\./);
});

test("the system prompt names the repo, the owner and the bot", () => {
  const p = render("system", { repo: "ntodd/sandbox", issue });
  assert.match(p, /issue #7 in ntodd\/sandbox for ntodd/);
  assert.match(p, /goes out as ntodd-agent\[bot\]/);
  assert.doesNotMatch(p, /\{\{/);
});

test("report includes the status and the reason when there is one", () => {
  assert.match(render("report", { repo: "r", issue, status: "blocked", reason: "CI still red", rounds: 3, prs: [5, 6] }), /Status: blocked \(CI still red\)\. Pull requests: #5, #6\. Review rounds: 3\./);
});

test("build uses the repo's PR template or the git-workflow one, and ends with how it was made", () => {
  const p = render("build", { repo: "r", issue });
  assert.match(p, /If the repo has a PR template .* use it\. Otherwise use this one:/);
  assert.match(p, /\*\*What does this PR do\?\*\*/);
  assert.match(p, /\*\*How this was made\*\*\n- \[x\] Reproduced on main/);
  assert.match(p, /\*\*Decisions\*\*/);
});

test("the system prompt makes red CI the agent's to fix, main included", () => {
  const p = render("system", { repo: "ntodd/sandbox", issue });
  assert.match(p, /CI on the PRs has to end green/);
  assert.match(p, /marks them ready and asks ntodd for a review/);
});

test("every phase that can block asks for a one-line reason", () => {
  for (const phase of ["build", "respond"]) assert.match(render(phase, { repo: "r", issue, round: 1, failed: [], threads: [], waitingFor: [] }), /"status": "blocked", "reason"/);
  for (const round of [0, 1]) assert.match(render("publish", { repo: "r", issue, round }), /"status": "blocked", "reason"/);
});

test("fill keeps a section when its key is set, drops it when it isn't, and the other way round for ^", () => {
  const t = "a{{#x}} x:{{v}}{{#y}} y{{/y}}{{/x}}{{^x}} no x{{/x}} b";
  assert.equal(fill(t, { x: true, y: true, v: 1 }), "a x:1 y b");
  assert.equal(fill(t, { x: true, v: 1 }), "a x:1 b");
  assert.equal(fill(t, { v: 1 }), "a no x b");
});

test("fill doesn't expand sections or placeholders that arrive inside a value", () => {
  assert.equal(fill("{{body}}", { body: "{{#x}}hi{{/x}} {{owner}}", owner: "ntodd" }), "{{#x}}hi{{/x}} {{owner}}");
});

const rz = { pr: 9, own: false, headRef: "feature/7-fix", baseRef: "main", headSha: "a".repeat(40) };
const base = "b".repeat(40);

test("resolve gives the issue, the validated head and base, and the rules for resolving", () => {
  const p = render("resolve", { repo: "ntodd/sandbox", issue, resolve: rz, round: 0, baseSha: base, headSha: rz.headSha });
  assert.match(p, /# Resolve pull request #9/);
  assert.match(p, /closes issue #7: Counter skips 3/);
  assert.match(p, /It goes 1, 2, 4\./);
  assert.match(p, new RegExp(`git checkout -B feature/7-fix ${rz.headSha}`));
  assert.match(p, new RegExp(`git merge ${base}`));
  assert.match(p, /Merge, don't rebase/);
  assert.match(p, /Regenerate generated files/);
  assert.match(p, /fails the same way on `main` isn't this run's to fix/);
  assert.match(p, /"status": "ready", "files"/);
  assert.match(p, /"status": "blocked", "reason"/);
  assert.match(p, /no `nothing-to-do`/);
  assert.doesNotMatch(p, /\{\{/);
});

test("resolve on a trusted user's own PR has the PR's description and no issue, and blocks sooner on intent", () => {
  const pr = { number: 12, title: "Tidy the totals", body: "Splits the total.", author: "ntodd", comments: [], labels: [] };
  const p = render("resolve", { repo: "r", issue: pr, resolve: { ...rz, pr: 12, own: true }, round: 0, baseSha: base, headSha: rz.headSha });
  assert.match(p, /ntodd wrote #12 \(Tidy the totals\) and asked for this with a `\/resolve` comment/);
  assert.match(p, /Splits the total\./);
  assert.doesNotMatch(p, /closes issue/);
  assert.match(p, /doesn't make clear what ntodd meant, block and ask/);
  assert.doesNotMatch(p, /\{\{/);
});

test("a second resolve says main moved again and doesn't check the branch out afresh", () => {
  const p = render("resolve", { repo: "r", issue, resolve: rz, round: 1, baseSha: base, headSha: "c".repeat(40) });
  assert.match(p, /moved again/);
  assert.doesNotMatch(p, /git checkout -B/);
});

test("in resolve mode, publish pushes the existing branch without force and opens nothing", () => {
  for (const round of [0, 1]) {
    const p = render("publish", { repo: "r", issue, resolve: rz, round });
    assert.match(p, /git push origin HEAD:feature\/7-fix/);
    assert.match(p, /never force/);
    assert.match(p, /Don't open a pull request/);
    assert.match(p, /GitHub's own message as the reason/);
    assert.doesNotMatch(p, /as drafts|force-with-lease|gh stack/);
    assert.doesNotMatch(p, /\{\{/);
  }
  assert.match(render("publish", { repo: "r", issue, resolve: rz, round: 0 }), /^## Publish phase\n/);
  assert.match(render("publish", { repo: "r", issue, resolve: { ...rz, own: true }, round: 1 }), /Leave the review threads/);
  assert.match(render("publish", { repo: "r", issue, round: 1 }), /force-with-lease/);
});

test("in resolve mode, respond adds commits, blocks on a check main fails too, and leaves an own PR's threads alone", () => {
  const v = { repo: "r", issue, round: 1, failed: [], threads: [], waitingFor: [] };
  const p = render("respond", { ...v, resolve: rz });
  assert.match(p, /fails the same way on `main`: that isn't a resolve run's to fix/);
  assert.match(p, /Don't amend, rebase or rewrite/);
  assert.doesNotMatch(p, /fix it anyway|restack/);
  assert.match(p, /\*\*Threads:\*\* decide for each one/);
  assert.match(render("respond", { ...v, resolve: { ...rz, own: true } }), /\*\*Threads:\*\* leave them alone/);
  const build = render("respond", v);
  assert.match(build, /fix it anyway/);
  assert.match(build, /restack the levels above/);
  assert.doesNotMatch(build, /resolve run/);
});

test("the system prompt says when the run is a resolve run, and names a PR with no issue as a pull request", () => {
  const p = render("system", { repo: "ntodd/sandbox", issue, resolve: rz });
  assert.match(p, /This is a resolve run/);
  assert.match(p, /working issue #7 in ntodd\/sandbox/);
  assert.match(render("system", { repo: "r", issue: { number: 12, title: "T", body: "" }, resolve: { ...rz, pr: 12, own: true } }), /working pull request #12 in r/);
  assert.doesNotMatch(render("system", { repo: "r", issue }), /resolve run/);
  assert.doesNotMatch(p, /\{\{/);
});

test("the report is a resolve report in resolve mode", () => {
  const p = render("report", { repo: "r", issue, resolve: rz, status: "done", rounds: 0, prs: [9] });
  assert.match(p, /each file you resolved/);
  assert.doesNotMatch(p, /phase 6/);
  assert.match(render("report", { repo: "r", issue, status: "done", rounds: 0, prs: [9] }), /phase 6/);
});
