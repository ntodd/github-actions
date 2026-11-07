// The workflow's first step: should this event start a run, and at what
// effort? Outputs run, reason, issue and effort.

import { readFileSync } from "node:fs";
import { checkTrigger, resolveEffort, parseList } from "../lib/gate.mjs";
import { client } from "../lib/github.mjs";
import { main, setOutput, summary } from "../lib/action.mjs";

main(async () => {
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const trustedUsers = parseList(env.AGENT_TRUSTED_USERS);
  const res = checkTrigger(event, { label: env.AGENT_LABEL, trustedUsers });
  setOutput("run", res.run);
  if (!res.run) {
    setOutput("reason", res.reason);
    summary(`agent-ready didn't run: ${res.reason}.`);
    console.log(`Not running: ${res.reason}.`);
    return;
  }
  const number = event.issue.number;
  const gh = client({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const effort = resolveEffort({
    labels: event.issue.labels ?? [],
    comments: await gh.comments(number),
    trustedUsers,
    defaultEffort: env.AGENT_DEFAULT_EFFORT,
  });
  setOutput("issue", number);
  setOutput("effort", effort);
  console.log(`Running on #${number} at ${effort} effort.`);
});
