// The run: Claude works with a read-only token, publishes with a fresh
// App token, and the workflow (not Claude) waits on CI and review bots
// between rounds. Every dependency is passed in, so the loop is tested
// with fakes; main.mjs wires up the real ones.
//
// A resolve run works a PR that already exists and conflicts with its
// base. It skips the build: Claude merges the base in and resolves the
// conflicts, the merge is pushed to the PR's own branch, and then it's the
// same wait and respond loop, with one more thing to pass at the end: the
// PR has to be mergeable, not just green.

import { summarizeChecks, botsSettled, openThreads } from "./checks.mjs";
import { silent, clean } from "./status.mjs";
import { awaitMergeable } from "./resolve.mjs";
import { isFlakeHuntIssue } from "./gate.mjs";

const WORK = new Set(["ready", "blocked", "nothing-to-do", "covered"]);

const prList = (ns) => {
  const t = ns.map((n) => `#${n}`);
  return t.length < 2 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
};
const named = (failed) => failed.map((f) => `#${f.pr} ${f.name}`).join(", ");
// A reason as a sentence: capitalized, ending in one stop.
const sentence = (s) => {
  const t = String(s).trim().replace(/\.$/, "");
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[?!]$/.test(t) ? "" : "."}`;
};

// A blocked outcome's own one-line reason, or the phase's fallback.
const why = (out, fallback) => (typeof out.reason === "string" && out.reason.trim() ? clean(out.reason, 300) : fallback);

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

// The comment a resolve run leaves on the PR after each merge it pushes,
// so the PR shows why it changed since anyone last looked.
export function mergeNote({ baseRef, baseSha, headRef, files, own }) {
  const resolved = (Array.isArray(files) ? files : [])
    .filter((f) => typeof f === "string" && f.trim())
    .slice(0, 30)
    .map((f) => `\`${clean(f, 200).replace(/`/g, "")}\``);
  return [
    `Merged \`${baseRef}\` (${String(baseSha).slice(0, 7)}) into this branch, because \`${baseRef}\` had moved and the two conflicted.`,
    resolved.length ? `Conflicts resolved in ${resolved.join(", ")}.` : "",
    own ? `The merge commit is on \`${headRef}\` now, so pull before you push again.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// resolve: null for a build, or the PR a resolve run works: { pr, own,
// stack, headRef, baseRef, headSha }. On a trusted user's own PR (own)
// there's no issue, and `issue` is the PR itself, so the status comment
// and the labels land on the PR.
export async function runAgent({ repo, issue, resolve = null, config, readToken, github, mint, writer, claude, attach = async () => {}, rerun = null, progress = silent, render, clock, log }) {
  const { label, maxRounds } = config;
  const own = Boolean(resolve?.own);
  // An own PR's review threads, draft state and reviewers are its
  // author's. The run only waits for CI on it.
  const waiting = own ? { ...config, bots: [], readyForBots: false, threads: false } : config;
  // Whether the PR still conflicts as far as the run knows. A resolve run
  // that ends blocked on a PR that does leaves it labeled agent-conflict,
  // so the sweep doesn't start another on it.
  let conflicting = Boolean(resolve);
  const phases = [];
  let prs = [];
  let rounds = 0;
  let report = "";
  let comment = "";
  // The App's open PR that the build found already fixes this flake.
  let coveredBy = null;

  const phase = async (name, vars, step, token = readToken) => {
    log(`${name}: starting`);
    await progress.step(step);
    const res = await claude({ phase: name, token, prompt: render(name, { repo, issue, resolve, ...vars }) });
    phases.push({ phase: name, turns: res.turns, cost: res.cost, status: res.outcome?.status });
    log(`${name}: ${res.outcome?.status}`);
    return res.outcome ?? {};
  };

  // Done: take the drafts out of draft and ask for a review, so it shows
  // up for whoever has to look at it. Returns the PRs it handed over and
  // what went wrong, which goes on the issue.
  const handOver = async (w) => {
    // The issue's author, unless that's flake-hunt's bot or someone else
    // who can't review: then the first trusted user.
    const author = config.trustedUsers?.includes(String(issue.author ?? "").toLowerCase()) ? issue.author : config.trustedUsers?.[0];
    const who = config.reviewers?.length ? config.reviewers : [author].filter(Boolean);
    const ready = [];
    const problems = [];
    for (const n of prs) {
      let p;
      try {
        p = await github.pr(n);
        if (p.state !== "open") continue;
        if (p.draft) await w.markReady(p.nodeId);
        ready.push(n);
      } catch (err) {
        problems.push(`couldn't mark #${n} ready for review: ${err.message}`);
        continue;
      }
      try {
        if (who.length) await w.requestReviewers(n, who);
      } catch (err) {
        problems.push(`couldn't ask ${who.join(", ")} to review #${n}: ${err.message}`);
      }
    }
    for (const p of problems) log(p);
    return { ready, problems };
  };

  // Blocked always says why on the issue, first, then Claude's details.
  const blockedNote = (reason) =>
    [
      `**Blocked:** ${sentence(reason)}`,
      comment,
      [prs.length && !own ? `Pull requests: ${prs.map((n) => `#${n}`).join(", ")}.` : "", config.runUrl ? `[Run log](${config.runUrl})` : ""].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join("\n\n");

  const headline = (status, reason, { ready = [], problems = [] }) => {
    if (status === "covered") return `**agent-ready is done.** #${coveredBy} already fixes this, so there's no pull request of its own.${comment ? ` The next comment shows the seeds that pass with #${coveredBy}.` : ""} Close this by hand when #${coveredBy} merges.`;
    if (status !== "done") return `**agent-ready is blocked.** ${sentence(reason)}`;
    if (own) return `**agent-ready is done.** #${resolve.pr} merges into \`${resolve.baseRef}\` again, and CI is green.`;
    if (!prs.length) return "**agent-ready is done.** No pull request was needed, and the next comment says why.";
    const failed = problems.length ? " Asking for the review failed; the next comment says why." : "";
    if (!ready.length) return `**agent-ready is done.**${failed}`;
    return `**agent-ready is done.** ${prList(ready)} ${ready.length === 1 ? "is" : "are"} ready for review.${failed}`;
  };

  const finish = async (status, reason) => {
    let handed = {};
    try {
      const w = writer(await mint());
      if (status === "done" && !own) handed = await handOver(w);
      const problems = handed.problems?.length ? `The pull requests are done, but:\n\n${handed.problems.map((p) => `- ${p}`).join("\n")}` : "";
      const body = status === "done" || status === "covered" ? [comment, problems].filter(Boolean).join("\n\n") : blockedNote(reason);
      if (body) await w.comment(issue.number, body);
      await w.removeLabel(issue.number, "agent-working");
      // The merge may be pushed and the base have moved again since.
      if (resolve && status !== "done" && !conflicting) {
        try {
          conflicting = (await github.pull(resolve.pr))?.mergeable === "CONFLICTING";
        } catch (err) {
          log(`couldn't read whether #${resolve.pr} conflicts: ${err.message}`);
        }
      }
      const stuck = Boolean(resolve) && status !== "done" && conflicting;
      if (own) await w.addLabels(issue.number, [status === "done" ? "agent-done" : stuck ? "agent-conflict" : "agent-blocked"]);
      else {
        await w.addLabels(issue.number, [{ done: "agent-done", covered: "agent-covered" }[status] ?? "agent-blocked"]);
        if (stuck) await w.addLabels(resolve.pr, ["agent-conflict"]);
      }
      // Last, so a PR that won't take the comment can't leave the issue
      // labeled agent-working. It asks for a close by hand: a PR that
      // closes an issue outside its group fails the resolve checks.
      if (status === "covered") {
        try {
          await w.comment(
            coveredBy,
            `#${issue.number} is another flaky test, and the agent run on it found it passes its failing seeds with this branch, so it didn't open a fix of its own. Close #${issue.number} by hand when this merges.`,
          );
        } catch (err) {
          log(`couldn't comment on #${coveredBy}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`couldn't update the issue: ${err.message}`);
    }
    await progress.finish(headline(status, reason, handed));
    return { status, reason, prs, rounds, report, phases };
  };

  // The build found an open PR of the App's that already fixes this
  // flake. The issue stays open for that PR, and isn't labeled done:
  // nothing of this run's waits for a review.
  const covered = async (out) => {
    const n = out.pr;
    if (!isFlakeHuntIssue({ user: { login: issue.author }, body: issue.body })) return finish("blocked", "the build ended covered, which only a flake-hunt issue can");
    if (!Number.isInteger(n)) return finish("blocked", "the build said an open pull request already fixes this, but didn't say which pull request");
    const p = await github.pull(n);
    const app = String(config.appBot ?? "").toLowerCase();
    if (!p || p.state !== "open" || !app || String(p.author).toLowerCase() !== app) return finish("blocked", `the build said #${n} already fixes this, but #${n} isn't an open pull request of ${config.appBot}'s`);
    coveredBy = n;
    return finish("covered", "");
  };

  const publish = async (round) => {
    const step = resolve
      ? round === 0
        ? `Push the merge to #${resolve.pr}`
        : `Push round ${round}'s changes to #${resolve.pr}`
      : round === 0
        ? "Open the draft PRs"
        : `Push round ${round}'s changes and answer the threads`;
    const out = await phase("publish", { round }, step, await mint());
    if (out.status === "blocked") return { blocked: why(out, round === 0 && !resolve ? "opening the pull requests stopped" : `pushing round ${round}'s changes stopped`), details: out.comment };
    if (resolve) {
      // The run knows its PR, and whatever number Claude reports is ignored.
      if (out.status !== "published") return { blocked: `publishing ended with status "${out.status}"` };
    } else {
      const numbers = Array.isArray(out.prs) ? out.prs.filter(Number.isInteger) : [];
      if (out.status !== "published" || numbers.length === 0) return { blocked: "publishing reported no pull requests" };
      prs = [...new Set([...prs, ...numbers])];
    }
    for (const n of own ? [] : prs) {
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
    if (!rerun || seen.threads.length || !seen.failed.length || seen.failed.some((f) => !f.run)) return stuck;
    await progress.step(`Rerun the flaky jobs: ${named(seen.failed)}`);
    try {
      await rerun([...new Set(seen.failed.map((f) => f.run))]);
    } catch (err) {
      return { reason: `couldn't rerun ${named(seen.failed)}: ${err.message}` };
    }
    log(`reran ${named(seen.failed)}`);
    await clock.sleep(config.pollMs);
    return { ok: true };
  };

  // One merge of the base into the PR: Claude resolves with a read-only
  // token, the merge is pushed to the PR's branch, and a comment on the PR
  // says what was merged. Round 0 is the run's first. A later one is for a
  // base that moved while the run worked.
  const resolveOnce = async (round) => {
    const { pr, baseRef } = resolve;
    const head = round === 0 ? resolve.headSha : (await github.pr(pr)).headSha;
    const baseSha = await github.branchSha(baseRef);
    const step = round === 0 ? `Merge ${baseRef} into #${pr} and resolve the conflicts` : `Resolve #${pr} again: ${baseRef} moved (round ${round})`;
    const out = await phase("resolve", { round, headSha: head, baseSha }, step);
    if (out.status !== "ready") {
      comment = out.comment ?? "";
      // There's no nothing-to-do here: a PR that should be closed mustn't
      // end done and be handed over as ready for review.
      return { blocked: out.status === "blocked" ? why(out, `the conflict in #${pr} needs a decision from you`) : `the resolve phase ended with status "${out.status}"` };
    }
    const pub = await publish(round);
    if (pub.blocked) {
      comment = pub.details ?? "";
      return { blocked: pub.blocked };
    }
    if ((await github.pr(pr)).headSha === head) return { blocked: `the merge was reported as pushed, but #${pr}'s head is still ${String(head).slice(0, 7)}` };
    conflicting = false;
    try {
      await writer(await mint()).comment(pr, mergeNote({ baseRef, baseSha, headRef: resolve.headRef, files: out.files, own }));
    } catch (err) {
      log(`couldn't comment on #${pr}: ${err.message}`);
    }
    return {};
  };

  // Waits for CI and review on what's published and sends what's still
  // open back to Claude, round after round, until it's all green and
  // answered, the rounds run out, or something needs the owner.
  const settle = async () => {
    for (;;) {
      const since = clock.now();
      await progress.step(`Wait for ${waiting.bots?.length ? "CI and review bots" : "CI"} on ${prList(prs)}`);
      const seen = await waitForRound({ prs, since, config: waiting, github, writer, mint, clock, log, progress });
      if (seen.closedUnmerged) return { status: "blocked", reason: `#${seen.closedUnmerged} was closed without merging` };
      if (seen.closed) return { status: "done", reason: "", closed: true };
      if (seen.failed.length === 0 && seen.threads.length === 0) return { status: "done", reason: "" };
      if (rounds >= maxRounds) return { status: "blocked", reason: `CI or review is still open after ${maxRounds} rounds: ${describeOpen(seen)}` };
      rounds++;
      const out = await phase("respond", { round: rounds, failed: seen.failed, threads: seen.threads, waitingFor: seen.waitingFor }, `Respond to CI and review, round ${rounds}`);
      if (out.status === "nothing-to-do") {
        const rr = await rerunFlakes(seen);
        if (rr.ok) continue;
        comment = out.comment ?? "";
        return { status: "blocked", reason: rr.reason };
      }
      if (out.status !== "ready") {
        comment = out.comment ?? "";
        return { status: "blocked", reason: out.status === "blocked" ? why(out, `round ${rounds} needs a decision from you: ${describeOpen(seen)}`) : `round ${rounds} ended with status "${out.status}"` };
      }
      const again = await publish(rounds);
      if (again.blocked) {
        comment = again.details ?? "";
        return { status: "blocked", reason: again.blocked };
      }
    }
  };

  try {
    const w = writer(await mint());
    if (resolve) {
      // The label that starts builds stays as it is: it's gone already,
      // unless the owner has just asked for a new build. agent-conflict
      // is cleared here, inside the concurrency group, so a run that's
      // finishing can't put it back after this one cleared it.
      for (const l of ["agent-done", "agent-blocked"]) await w.removeLabel(issue.number, l);
      await w.removeLabel(resolve.pr, "agent-conflict");
    } else {
      // agent-working goes on first: a run on another flake-hunt issue
      // waits while this one has either label (queue.mjs). A reopened
      // issue may still say how the last run ended.
      await w.addLabels(issue.number, ["agent-working"]);
      for (const l of [label, "agent-done", "agent-blocked", "agent-covered"]) await w.removeLabel(issue.number, l);
    }
    if (resolve) await w.addLabels(issue.number, ["agent-working"]);

    if (resolve) {
      prs = [resolve.pr];
      if (resolve.stack) return await finish("blocked", `#${resolve.pr} is part of a stack, and resolve runs only handle one-branch pull requests so far`);
      const first = await resolveOnce(0);
      if (first.blocked) return await finish("blocked", first.blocked);
    } else {
      const built = await phase("build", {}, "Build: triage, reproduce, TDD and review");
      if (!WORK.has(built.status)) return await finish("blocked", `the build ended with status "${built.status}"`);
      if (built.status !== "ready") {
        comment = built.comment ?? "";
        if (built.status === "nothing-to-do") return await finish("done", "nothing-to-do");
        if (built.status === "covered") return await covered(built);
        return await finish("blocked", why(built, "the build stopped before opening a pull request"));
      }

      const pub = await publish(0);
      if (pub.blocked) {
        comment = pub.details ?? "";
        return await finish("blocked", pub.blocked);
      }
    }

    let status = "done";
    let reason = "";
    for (;;) {
      const settled = await settle();
      ({ status, reason } = settled);
      if (!resolve || status !== "done" || settled.closed) break;
      // Green isn't enough for a resolve run. The base can move while the
      // run works, and the wait above never looks at mergeability.
      const { pr, baseRef } = resolve;
      const now = await awaitMergeable({ github, pr, clock });
      if (!now || now.state !== "open" || now.mergeable === "MERGEABLE") break;
      const block = (because) => void ([status, reason] = ["blocked", because]);
      if (now.mergeable !== "CONFLICTING") {
        block(`GitHub never worked out whether #${pr} can be merged`);
        break;
      }
      conflicting = true;
      if (rounds >= maxRounds) {
        block(`#${pr} conflicts with ${baseRef} again, and the run is out of rounds (${maxRounds})`);
        break;
      }
      rounds++;
      const again = await resolveOnce(rounds);
      if (again.blocked) {
        block(again.blocked);
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
      // A merged PR is out of the wait; the rest still have to go green.
      if (pr.state === "merged") continue;
      if (pr.state !== "open") {
        log(`#${n} was closed; stopping`);
        return { closedUnmerged: n, failed: [], threads: [], waitingFor: [] };
      }
      states.push({ n, pr, checks: summarizeChecks({ ...(await github.checks(pr.headSha)), ignore: ignoreChecks }) });
    }

    if (!states.length) {
      log("every pull request is merged; stopping");
      return { closed: true, failed: [], threads: [], waitingFor: [] };
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
    // threads: false leaves the review threads to the PR's author.
    for (const s of config.threads === false ? [] : states) {
      threads.push(...openThreads(await github.threads(s.n), { trustedUsers, bots }).map((t) => ({ pr: s.n, ...t })));
    }
    return { closed: false, failed, threads, waitingFor };
  }
}
