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
