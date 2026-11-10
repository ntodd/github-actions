// The workflow's first step: should this event start a run, and at what
// effort? Outputs run, reason, issue and effort. For a resolve run on a
// trusted user's own PR, which has no issue, `issue` is the PR's number:
// it's where the run reports.

import { readFileSync } from "node:fs";
import { checkTrigger, parseRequest, resolveEffort, parseList } from "../lib/gate.mjs";
import { prepareResolve } from "../lib/resolve.mjs";
import { client } from "../lib/github.mjs";
import { main, setOutput, summary } from "../lib/action.mjs";

main(async () => {
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const trustedUsers = parseList(env.AGENT_TRUSTED_USERS);
  const gh = client({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const eventName = env.GITHUB_EVENT_NAME;
  const skip = (reason) => {
    setOutput("run", false);
    setOutput("reason", reason);
    summary(`agent-ready didn't run: ${reason}.`);
    console.log(`Not running: ${reason}.`);
  };
  const request = parseRequest(eventName, event.inputs);
  if (request.error) return skip(request.error);

  // A labeled issue carries itself. A dispatched build (flake-hunt's, or
  // one started by hand) names its issue. A resolve names its PR, and the
  // run/index.mjs step checks all of this again with the App's login.
  let issue = event.issue;
  if (request.mode === "resolve") {
    const prep = await prepareResolve({
      request,
      sender: event.sender,
      github: gh,
      repo: env.GITHUB_REPOSITORY,
      label: env.AGENT_LABEL,
      trustedUsers,
      clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      wait: false,
    });
    if (!prep.go) return skip(prep.reason);
    issue = prep.issue ?? { number: prep.pr.number, labels: prep.pr.labels.map((name) => ({ name })) };
  } else {
    if (eventName === "workflow_dispatch") issue = request.issue ? await gh.issue(request.issue) : null;
    if (issue && !issue.pull_request) issue = { ...issue, editors: await gh.editors(issue.number) };
    const res = checkTrigger(event, { label: env.AGENT_LABEL, trustedUsers, eventName, issue });
    if (!res.run) return skip(res.reason);
  }
  setOutput("run", true);
  const number = issue.number;
  const effort = resolveEffort({
    labels: issue.labels ?? [],
    comments: await gh.comments(number),
    trustedUsers,
    defaultEffort: env.AGENT_DEFAULT_EFFORT,
  });
  setOutput("issue", number);
  setOutput("effort", effort);
  console.log(`${request.mode === "resolve" ? `Resolving #${request.pr}, reporting on` : "Running on"} #${number} at ${effort} effort.`);
});
