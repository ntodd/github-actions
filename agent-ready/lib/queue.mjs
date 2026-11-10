// Builds on flake-hunt's issues take turns. flake-hunt starts its runs
// within seconds of each other, and a run can only see another's fix once
// that run has opened its PR (the build's first step is to look, in
// prompts/build.md). So the gate holds a build on a flake-hunt issue
// while another flake-hunt issue is ahead of it:
//
// - queued: labeled agent-ready, with a lower number. Its run hasn't
//   started yet, and the lowest number goes first, so no two runs ever
//   wait on each other.
// - working: labeled agent-working, with no open PR that closes it yet.
//   A run adds agent-working before it takes agent-ready off (run.mjs),
//   so there's no moment it has neither.
//
// A label that's older than it could be on a live run doesn't count:
// agent-working past a job's timeout, or agent-ready past the longest
// wait plus time to set up (a run the gate refused, or a dispatch that
// failed). And after MAX_WAIT_MS the run goes ahead anyway.
//
// The wait counts toward the job's timeout-minutes.

import { isFlakeHuntIssue, latestLabeled, numberList } from "./gate.mjs";

// agent-ready's default timeout-minutes. The gate isn't told the
// caller's, and a shorter one only means a dead run is waited on longer.
export const STALE_MS = 360 * 60_000;
export const MAX_WAIT_MS = 120 * 60_000;
const QUEUED_MS = MAX_WAIT_MS + 30 * 60_000;
// Each look is a few reads with the job's token, and every waiting run
// looks, so not too often.
export const POLL_MS = 5 * 60_000;

const lower = (s) => String(s ?? "").toLowerCase();

export async function aheadOf({ github, issue, label, repo, now, staleMs = STALE_MS }) {
  const fresh = async (n, name, ms) => now - Date.parse(latestLabeled(await github.labelEvents(n), name)?.at ?? "") <= ms;
  const queued = [];
  for (const i of await github.labeledIssues(label)) {
    if (i.number < issue && isFlakeHuntIssue(i) && (await fresh(i.number, label, Math.min(QUEUED_MS, staleMs)))) queued.push(i.number);
  }
  const working = [];
  const others = (await github.labeledIssues("agent-working")).filter((i) => i.number !== issue && isFlakeHuntIssue(i));
  if (others.length) {
    const fixing = new Set((await github.openPulls()).flatMap((p) => (p.closes?.issues ?? []).filter((c) => lower(c.repo) === lower(repo)).map((c) => c.number)));
    for (const i of others) {
      if (!fixing.has(i.number) && (await fresh(i.number, "agent-working", staleMs))) working.push(i.number);
    }
  }
  return { queued: queued.sort((a, b) => a - b), working: working.sort((a, b) => a - b) };
}

// Waits until nothing is ahead, or MAX_WAIT_MS. Says why it's waiting
// whenever that changes. A read that fails is waited out like any other
// look: the gate shouldn't die over it and leave the issue queued.
export async function awaitTurn({ github, issue, label, repo, clock, log, staleMs = STALE_MS, maxWaitMs = MAX_WAIT_MS, pollMs = POLL_MS }) {
  const start = clock.now();
  let said = "";
  for (;;) {
    let ahead;
    try {
      ahead = await aheadOf({ github, issue, label, repo, now: clock.now(), staleMs });
    } catch (err) {
      ahead = null;
      log(`Couldn't read the flake-hunt runs ahead of #${issue}: ${err.message}`);
    }
    const { queued = [], working = [] } = ahead ?? {};
    if (ahead && !queued.length && !working.length) return { waitedMs: clock.now() - start, gaveUp: false };
    if (clock.now() - start >= maxWaitMs) {
      log(`Waited ${Math.round(maxWaitMs / 60_000)} minutes for the flake-hunt runs ahead, so going ahead anyway.`);
      return { waitedMs: clock.now() - start, gaveUp: true };
    }
    const why = [
      queued.length ? `${numberList(queued)} ${queued.length === 1 ? "is" : "are"} queued ahead` : "",
      working.length ? `the run${working.length === 1 ? "" : "s"} on ${numberList(working)} ${working.length === 1 ? "hasn't" : "haven't"} opened a pull request yet` : "",
    ]
      .filter(Boolean)
      .join(", and ");
    if (ahead && why !== said) log(`Waiting before building #${issue}: ${(said = why)}.`);
    await clock.sleep(pollMs);
  }
}
