// The caller's two small jobs that start resolve runs, on GitHub's own
// runners with the job's GITHUB_TOKEN (actions: write, to dispatch):
//
// - a "/resolve" comment on a pull request (issue_comment)
// - the sweep, after a push to the default branch and once a day
//
// Both dispatch the caller itself with mode: resolve, so the run lands in
// its issue's (or its PR's) concurrency group. Neither checks out the
// repo: this is the tooling at the caller's pinned ref, and it only reads
// the API.
//
// Env: GITHUB_TOKEN, AGENT_TRUSTED_USERS, AGENT_APP_BOT (the App's login,
// like ntodd-agent[bot]), AGENT_LABEL and AGENT_TIMEOUT_MINUTES (optional),
// AGENT_DRY_RUN=true to print what it would dispatch.

import { readFileSync } from "node:fs";
import { client } from "../lib/github.mjs";
import { parseList } from "../lib/gate.mjs";
import { planSweep, planComment, dispatchInputs } from "../lib/resolve.mjs";
import { main, summary } from "../lib/action.mjs";

main(async () => {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  const trustedUsers = parseList(env.AGENT_TRUSTED_USERS);
  const appBot = String(env.AGENT_APP_BOT ?? "").trim();
  if (!trustedUsers.length) throw new Error("AGENT_TRUSTED_USERS isn't set");
  if (!appBot) throw new Error("AGENT_APP_BOT isn't set");
  // owner/repo/.github/workflows/agent-ready.yml@refs/heads/main
  const workflow = /\/([^/@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? "")?.[1];
  if (!workflow) throw new Error("GITHUB_WORKFLOW_REF doesn't name the workflow to dispatch");
  const dry = env.AGENT_DRY_RUN === "true";

  const github = client({ token: env.GITHUB_TOKEN, repo, apiUrl: env.GITHUB_API_URL });
  const opts = {
    github,
    repo,
    label: env.AGENT_LABEL || "agent-ready",
    trustedUsers,
    appBot,
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  };
  // These events all run on the default branch, which is where a
  // workflow_dispatch has to go.
  const start = async (inputs) => {
    if (dry) return console.log(`Would dispatch ${workflow} on ${env.GITHUB_REF_NAME}: ${JSON.stringify(inputs)}`);
    await github.dispatch(workflow, env.GITHUB_REF_NAME, inputs);
  };
  const say = (line) => {
    console.log(line);
    summary(line);
  };

  let active = [];
  try {
    active = await github.activeResolves(workflow);
  } catch (err) {
    console.log(`Couldn't list the resolve runs already going: ${err.message}`);
  }

  if (env.GITHUB_EVENT_NAME === "issue_comment") {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const plan = await planComment({ ...opts, event, active });
    if (!plan.inputs) return say(`/resolve did nothing: ${plan.reason}.`);
    await start(plan.inputs);
    return say(`Started a resolve run on #${plan.inputs.pr}.`);
  }

  const { picked, skipped } = await planSweep({ ...opts, active, timeoutMs: Number(env.AGENT_TIMEOUT_MINUTES || 360) * 60_000 });
  let failed = 0;
  for (const p of picked) {
    try {
      await start(dispatchInputs(p));
      say(`- Started a resolve run on #${p.pr}, for #${p.issue}.`);
    } catch (err) {
      failed++;
      say(`- Couldn't start a resolve run on #${p.pr}: ${err.message}`);
    }
  }
  for (const s of skipped) say(`- Left #${s.pr} alone: ${s.reason}.`);
  if (!picked.length && !skipped.length) say(`None of ${appBot}'s open pull requests conflict.`);
  if (failed) process.exitCode = 1;
});
