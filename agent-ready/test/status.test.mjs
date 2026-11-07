import { test } from "node:test";
import assert from "node:assert/strict";
import { tracker, progressNote, clean } from "../lib/status.mjs";

function fakeIssue() {
  let t = Date.parse("2026-11-07T17:21:00Z");
  const bodies = [];
  const calls = [];
  const t0 = tracker({
    post: async (body) => {
      calls.push("post");
      bodies.push(body);
      return 41;
    },
    edit: async (id, body) => {
      calls.push(`edit ${id}`);
      bodies.push(body);
    },
    clock: { now: () => t },
    everyMs: 5 * 60_000,
    runUrl: "https://github.com/o/r/actions/runs/9",
    log: () => {},
  });
  return { status: t0, bodies, calls, advance: (min) => (t += min * 60_000) };
}

test("the first step posts the status comment, and later steps edit it", async () => {
  const s = fakeIssue();
  await s.status.step("Build: triage, reproduce, TDD and review");
  s.advance(22);
  await s.status.step("Publish");
  assert.deepEqual(s.calls, ["post", "edit 41"]);
  assert.equal(s.status.commentId(), 41);
  const body = s.bodies.at(-1);
  assert.match(body, /^\*\*agent-ready is working on this\.\*\* Started 17:21 UTC\. \[Run log\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/9\)/);
  assert.match(body, /- \[x\] Build: triage, reproduce, TDD and review \(22 min\)\n- \[ \] Publish \(0 min so far\)/);
});

test("notes show what's happening now, at most once per interval", async () => {
  const s = fakeIssue();
  await s.status.step("Build");
  await s.status.note("Reproducing the bug");
  s.advance(2);
  await s.status.note("Writing the failing test");
  assert.equal(s.calls.length, 1, "too soon to edit");
  s.advance(4);
  await s.status.note("Running mix test");
  assert.equal(s.calls.length, 2);
  assert.match(s.bodies.at(-1), /- \[ \] Build \(6 min so far\)\n\nNow \(17:27 UTC\): Running mix test/);
});

test("a new step drops the last step's note", async () => {
  const s = fakeIssue();
  await s.status.step("Build");
  s.advance(6);
  await s.status.note("Running mix test");
  await s.status.step("Waiting for CI on #5");
  assert.doesNotMatch(s.bodies.at(-1), /Now/);
});

test("finish replaces the headline and closes the last step", async () => {
  const s = fakeIssue();
  await s.status.step("Build");
  s.advance(3);
  await s.status.finish("**agent-ready is done.** #5 is ready for review.");
  assert.match(s.bodies.at(-1), /^\*\*agent-ready is done\.\*\* #5 is ready for review\. \[Run log\]/);
  assert.match(s.bodies.at(-1), /- \[x\] Build \(3 min\)$/);
});

test("a failed post or edit is logged, not thrown", async () => {
  const lines = [];
  const s = tracker({
    post: async () => {
      throw new Error("502");
    },
    edit: async () => {},
    clock: { now: () => 0 },
    log: (l) => lines.push(l),
  });
  await s.step("Build");
  assert.match(lines[0], /status comment: 502/);
});

test("progressNote takes the in-progress todo, or else the narration's first line", () => {
  const todo = {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Reproduce", status: "completed", activeForm: "Reproducing" },
              { content: "Write the failing test", status: "in_progress", activeForm: "Writing the failing test" },
              { content: "Fix it", status: "pending", activeForm: "Fixing it" },
            ],
          },
        },
      ],
    },
  };
  assert.equal(progressNote(todo), "Writing the failing test (2 of 3)");
  const text = { type: "assistant", message: { content: [{ type: "text", text: "The bug is in Tip.round/1.\n\nNext I'll write a test." }] } };
  assert.equal(progressNote(text), "The bug is in Tip.round/1.");
  assert.equal(progressNote({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }), null);
  assert.equal(progressNote({ type: "user" }), null);
});

test("clean keeps notes to one short line, defuses mentions and hides tokens", () => {
  assert.equal(clean("ping @ntodd and @org/team"), "ping @\u200bntodd and @\u200borg/team");
  assert.equal(clean("token ghs_abcdefghijklmnopqrstuvwxyz0123 and sk-proj-abcdefghijklmnopqrstu"), "token [redacted] and [redacted]");
  assert.equal(clean("a\nb"), "a b");
  assert.equal(clean("x".repeat(300)).length, 200);
});

test("stopped swaps the headline of a status comment the run never finished", async () => {
  const { stopped } = await import("../lib/status.mjs");
  const body = "**agent-ready is working on this.** Started 17:21 UTC. [Run log](https://r)\n\n- [ ] Build (40 min so far)";
  assert.equal(stopped(body, "https://r"), "**agent-ready stopped before it finished.** The job was cancelled, timed out or crashed. [Run log](https://r)\n\n- [ ] Build (40 min so far)");
});
