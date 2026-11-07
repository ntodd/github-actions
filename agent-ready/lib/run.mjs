// The run: Claude works with a read-only token, publishes with a fresh
// App token, and the workflow (not Claude) waits on CI and review bots
// between rounds. Every dependency is passed in, so the loop is tested
// with fakes; main.mjs wires up the real ones.

import { summarizeChecks, botsSettled, openThreads } from "./checks.mjs";
import { silent } from "./status.mjs";

const WORK = new Set(["ready", "blocked", "nothing-to-do"]);

const prList = (ns) => {
  const t = ns.map((n) => `#${n}`);
  return t.length < 2 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
};
const named = (failed) => failed.map((f) => `#${f.pr} ${f.name}`).join(", ");
const sentence = (s) => String(s).replace(/\.$/, "");

// What a round left open, for a reason line: "#5 test (failure); 2 open
// review threads on #6".
export function describeOpen({ failed = [], threads = [] }) {
  const parts = [];
  if (failed.length) parts.push(failed.map((f) => `#${f.pr} ${f.name} (${f.conclusion})`).join(", "));
  if (threads.length) {
    const by = new Map();
    for (const t of threads) by.set(t.pr, (by.get(t.pr) ?? 0) + 1);
    parts.push([...by].map(([pr, n]) => `${n} open review thread${n === 1 ? "" : "s"} on #${pr}`).join(", "));
  }
  return parts.join("; ");
}

export async function runAgent({ repo, issue, config, readToken, github, mint, writer, claude, attach = async () => {}, rerun = null, progress = silent, render, clock, log }) {
  const { label, maxRounds } = config;
  const phases = [];
  let prs = [];
  let rounds = 0;
  let report = "";
  let comment = "";

  const phase = async (name, vars, step, token = readToken) => {
    log(`${name}: starting`);
    await progress.step(step);
    const res = await claude({ phase: name, token, prompt: render(name, { repo, issue, ...vars }) });
    phases.push({ phase: name, turns: res.turns, cost: res.cost, status: res.outcome?.status });
    log(`${name}: ${res.outcome?.status}`);
    return res.outcome ?? {};
  };

  // Done: take the drafts out of draft and ask for a review, so it shows
  // up for whoever has to look at it. Returns the PRs it handed over.
  const handOver = async (w) => {
    const who = config.reviewers?.length ? config.reviewers : [issue.author].filter(Boolean);
    const ready = [];
    for (const n of prs) {
      try {
        const p = await github.pr(n);
        if (p.state !== "open") continue;
        if (p.draft) await w.markReady(p.nodeId);
        if (who.length) await w.requestReviewers(n, who);
        ready.push(n);
      } catch (err) {
        log(`#${n}: couldn't mark it ready or ask for review: ${err.message}`);
      }
    }
    return ready;
  };

  // Blocked always says why on the issue, first, then Claude's details.
  const blockedNote = (reason) =>
    [
      `**Blocked:** ${sentence(reason)}.`,
      comment,
      [prs.length ? `Pull requests: ${prs.map((n) => `#${n}`).join(", ")}.` : "", config.runUrl ? `[Run log](${config.runUrl})` : ""].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join("\n\n");

  const headline = (status, reason, ready) => {
    if (status !== "done") {
      const r = sentence(reason);
      return `**agent-ready is blocked.** ${r.charAt(0).toUpperCase()}${r.slice(1)}.`;
    }
    if (!prs.length) return "**agent-ready is done.** No pull request was needed, and the next comment says why.";
    if (!ready.length) return "**agent-ready is done.**";
    return `**agent-ready is done.** ${prList(ready)} ${ready.length === 1 ? "is" : "are"} ready for review.`;
  };

  const finish = async (status, reason) => {
    let ready = [];
    try {
      const w = writer(await mint());
      if (status === "done") ready = await handOver(w);
      const body = status === "done" ? comment : blockedNote(reason);
      if (body) await w.comment(issue.number, body);
      await w.removeLabel(issue.number, "agent-working");
      await w.addLabels(issue.number, [status === "done" ? "agent-done" : "agent-blocked"]);
    } catch (err) {
      log(`couldn't update the issue: ${err.message}`);
    }
    await progress.finish(headline(status, reason, ready));
    return { status, reason, prs, rounds, report, phases };
  };

  const publish = async (round) => {
    const step = round === 0 ? "Open the draft PRs" : `Push round ${round}'s changes and answer the threads`;
    const out = await phase("publish", { round }, step, await mint());
    if (out.status === "blocked") return { blocked: round === 0 ? "opening the pull requests stopped" : `pushing round ${round}'s changes stopped`, details: out.comment };
    const numbers = Array.isArray(out.prs) ? out.prs.filter(Number.isInteger) : [];
    if (out.status !== "published" || numbers.length === 0) return { blocked: "publishing reported no pull requests" };
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

  // Respond found nothing to change. If everything still open is a failed
  // Actions job, those are flakes or cancels: rerun them and wait again.
  const rerunFlakes = async (seen) => {
    const stuck = { reason: `nothing in the pull requests needs to change, but these are still open: ${describeOpen(seen)}` };
    if (!rerun || seen.threads.length || !seen.failed.length || seen.failed.some((f) => !f.job)) return stuck;
    await progress.step(`Rerun the flaky jobs: ${named(seen.failed)}`);
    try {
      await rerun([...new Set(seen.failed.map((f) => f.job))]);
    } catch (err) {
      return { reason: `couldn't rerun ${named(seen.failed)}: ${err.message}` };
    }
    log(`reran ${named(seen.failed)}`);
    await clock.sleep(config.pollMs);
    return { ok: true };
  };

  try {
    const w = writer(await mint());
    await w.removeLabel(issue.number, label);
    await w.addLabels(issue.number, ["agent-working"]);

    const built = await phase("build", {}, "Build: triage, reproduce, TDD and review");
    if (!WORK.has(built.status)) return await finish("blocked", `the build ended with status "${built.status}"`);
    if (built.status !== "ready") {
      comment = built.comment ?? "";
      if (built.status === "nothing-to-do") return await finish("done", "nothing-to-do");
      return await finish("blocked", "the build stopped before opening a pull request");
    }

    const pub = await publish(0);
    if (pub.blocked) {
      comment = pub.details ?? "";
      return await finish("blocked", pub.blocked);
    }

    let status = "done";
    let reason = "";
    for (;;) {
      const since = clock.now();
      await progress.step(`Wait for ${config.bots?.length ? "CI and review bots" : "CI"} on ${prList(prs)}`);
      const seen = await waitForRound({ prs, since, config, github, writer, mint, clock, log, progress });
      if (seen.closed) break;
      if (seen.failed.length === 0 && seen.threads.length === 0) break;
      if (rounds >= maxRounds) {
        status = "blocked";
        reason = `CI or review is still open after ${maxRounds} rounds: ${describeOpen(seen)}`;
        break;
      }
      rounds++;
      const out = await phase("respond", { round: rounds, failed: seen.failed, threads: seen.threads, waitingFor: seen.waitingFor }, `Respond to CI and review, round ${rounds}`);
      if (out.status === "nothing-to-do") {
        const rr = await rerunFlakes(seen);
        if (rr.ok) continue;
        status = "blocked";
        reason = rr.reason;
        comment = out.comment ?? "";
        break;
      }
      if (out.status !== "ready") {
        status = "blocked";
        reason = out.status === "blocked" ? `round ${rounds} needs a decision from you: ${describeOpen(seen)}` : `round ${rounds} ended with status "${out.status}"`;
        comment = out.comment ?? "";
        break;
      }
      const again = await publish(rounds);
      if (again.blocked) {
        status = "blocked";
        reason = again.blocked;
        comment = again.details ?? "";
        break;
      }
    }

    const final = await phase("report", { status, reason, rounds, prs }, "Write the report");
    report = final.report ?? "";
    if (status === "blocked" && final.comment) comment = final.comment;
    return await finish(status, reason);
  } catch (err) {
    log(`error: ${err.stack ?? err}`);
    return await finish("blocked", `the run hit an error: ${err.message}`);
  }
}

// Polls until every PR's checks have finished (or, with no checks at all,
// the grace period is over), marks drafts ready for the bots if asked, then
// waits for each review bot to look at the head commit (or the review
// timeout). Returns what still needs work.
export async function waitForRound({ prs, since, config, github, writer, mint, clock, log, progress = silent }) {
  const { checksGraceMs, reviewTimeoutMs, pollMs, bots, trustedUsers, readyForBots, ignoreChecks = [] } = config;
  const marked = new Set();
  let lastNote = "";
  const note = async (s) => {
    if (s !== lastNote) log((lastNote = s));
    await progress.note(`${s.charAt(0).toUpperCase()}${s.slice(1)}`);
  };

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
      await note(`waiting for checks: ${pending.map((s) => `#${s.n} ${s.checks.pending.join(", ")}`).join("; ") || "none reported yet"}`);
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
        await note(`waiting for review bots: ${waitingFor.join(", ")}`);
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
