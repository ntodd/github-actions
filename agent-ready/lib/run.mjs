// The run: Claude works with a read-only token, publishes with a fresh
// App token, and the workflow (not Claude) waits on CI and review bots
// between rounds. Every dependency is passed in, so the loop is tested
// with fakes; main.mjs wires up the real ones.

import { summarizeChecks, botsSettled, openThreads } from "./checks.mjs";

const WORK = new Set(["ready", "blocked", "nothing-to-do"]);

export async function runAgent({ repo, issue, config, readToken, github, mint, writer, claude, attach = async () => {}, render, clock, log }) {
  const { label, maxRounds } = config;
  const phases = [];
  let prs = [];
  let rounds = 0;
  let report = "";
  let comment = "";

  const phase = async (name, vars, token = readToken) => {
    log(`${name}: starting`);
    const res = await claude({ phase: name, token, prompt: render(name, { repo, issue, ...vars }) });
    phases.push({ phase: name, turns: res.turns, cost: res.cost, status: res.outcome?.status });
    log(`${name}: ${res.outcome?.status}`);
    return res.outcome ?? {};
  };

  const finish = async (status, reason) => {
    try {
      const w = writer(await mint());
      if (comment) await w.comment(issue.number, comment);
      await w.removeLabel(issue.number, "agent-working");
      await w.addLabels(issue.number, [status === "done" ? "agent-done" : "agent-blocked"]);
    } catch (err) {
      log(`couldn't update the issue: ${err.message}`);
    }
    return { status, reason, prs, rounds, report, phases };
  };

  const publish = async (round) => {
    const out = await phase("publish", { round }, await mint());
    if (out.status === "blocked") return { blocked: out.comment ?? "Publishing was blocked." };
    const numbers = Array.isArray(out.prs) ? out.prs.filter(Number.isInteger) : [];
    if (out.status !== "published" || numbers.length === 0) return { blocked: "Publishing reported no pull requests." };
    prs = [...new Set([...prs, ...numbers])];
    for (const n of prs) {
      try {
        await attach(n);
      } catch (err) {
        log(`#${n}: couldn't attach screenshots: ${err.message}`);
      }
    }
    return {};
  };

  try {
    const w = writer(await mint());
    await w.removeLabel(issue.number, label);
    await w.addLabels(issue.number, ["agent-working"]);

    const built = await phase("build", {});
    if (!WORK.has(built.status)) return await finish("blocked", `build ended with status ${built.status}`);
    if (built.status !== "ready") {
      comment = built.comment ?? "";
      return await finish(built.status === "nothing-to-do" ? "done" : "blocked", built.status);
    }

    const pub = await publish(0);
    if (pub.blocked) return await finish("blocked", pub.blocked);

    let status = "done";
    let reason = "";
    for (;;) {
      const since = clock.now();
      const seen = await waitForRound({ prs, since, config, github, writer, mint, clock, log });
      if (seen.closed) break;
      if (seen.failed.length === 0 && seen.threads.length === 0) break;
      if (rounds >= maxRounds) {
        status = "blocked";
        reason = `CI or review threads still open after ${maxRounds} rounds`;
        break;
      }
      rounds++;
      const out = await phase("respond", { round: rounds, failed: seen.failed, threads: seen.threads, waitingFor: seen.waitingFor });
      if (out.status !== "ready") {
        status = "blocked";
        reason = out.status === "blocked" ? "respond was blocked" : "nothing left to change, but checks or threads are still open";
        comment = out.comment ?? "";
        break;
      }
      const again = await publish(rounds);
      if (again.blocked) {
        status = "blocked";
        reason = again.blocked;
        break;
      }
    }

    const final = await phase("report", { status, reason, rounds, prs });
    report = final.report ?? "";
    if (status === "blocked" && final.comment) comment = final.comment;
    return await finish(status, reason);
  } catch (err) {
    log(`error: ${err.stack ?? err}`);
    return await finish("blocked", err.message);
  }
}

// Polls until every PR's checks have finished (or, with no checks at all,
// the grace period is over), marks drafts ready for the bots if asked, then
// waits for each review bot to look at the head commit (or the review
// timeout). Returns what still needs work.
export async function waitForRound({ prs, since, config, github, writer, mint, clock, log }) {
  const { checksGraceMs, reviewTimeoutMs, pollMs, bots, trustedUsers, readyForBots, ignoreChecks = [] } = config;
  const marked = new Set();
  let lastNote = "";
  const note = (s) => s !== lastNote && log((lastNote = s));

  for (;;) {
    const now = clock.now();
    const states = [];
    for (const n of prs) {
      const pr = await github.pr(n);
      if (pr.state !== "open") {
        log(`#${n} is ${pr.state}; stopping`);
        return { closed: true, failed: [], threads: [], waitingFor: [] };
      }
      states.push({ n, pr, checks: summarizeChecks({ ...(await github.checks(pr.headSha)), ignore: ignoreChecks }) });
    }

    const pending = states.filter((s) => s.checks.state === "pending");
    const none = states.filter((s) => s.checks.state === "none");
    if (pending.length || (none.length && now < since + checksGraceMs)) {
      note(`waiting for checks: ${pending.map((s) => `#${s.n} ${s.checks.pending.join(", ")}`).join("; ") || "none reported yet"}`);
      await clock.sleep(pollMs);
      continue;
    }

    if (readyForBots) {
      for (const s of states) {
        if (s.pr.draft && !marked.has(s.n) && s.checks.state !== "failure") {
          await writer(await mint()).markReady(s.pr.nodeId);
          marked.add(s.n);
          log(`#${s.n} marked ready for review`);
        }
      }
    }

    let waitingFor = [];
    if (bots.length) {
      for (const s of states) {
        const act = await github.activity(s.n);
        const res = botsSettled({ bots, ...act, headSha: s.pr.headSha, since: new Date(since).toISOString() });
        waitingFor.push(...res.waitingFor.map((b) => `${b} on #${s.n}`));
      }
      if (waitingFor.length && now < since + reviewTimeoutMs) {
        note(`waiting for review bots: ${waitingFor.join(", ")}`);
        await clock.sleep(pollMs);
        continue;
      }
    }

    const failed = states.flatMap((s) => s.checks.failed.map((f) => ({ pr: s.n, ...f })));
    const threads = [];
    for (const s of states) {
      threads.push(...openThreads(await github.threads(s.n), { trustedUsers, bots }).map((t) => ({ pr: s.n, ...t })));
    }
    return { closed: false, failed, threads, waitingFor };
  }
}
