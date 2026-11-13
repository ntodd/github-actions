// A privileged entry is the reviewed caller on the repository's default
// branch. In particular, a PR-context review hop cannot mint the App token.
export function controllerWakeup(eventName, event) {
  return eventName !== "workflow_run" || event?.workflow_run?.path !== ".github/workflows/factory.yml"
    || event.workflow_run.event === "workflow_dispatch" && event.workflow_run.display_title === "factory worker";
}

export async function verifyEntry({ api, env, context }) {
  const repo = env.GITHUB_REPOSITORY, completionPath = ".github/workflows/factory-completion.yml";
  const completion = env.GITHUB_WORKFLOW_REF === `${repo}/${completionPath}@refs/heads/${context.defaultBranch}`;
  const path = completion ? completionPath : ".github/workflows/factory.yml";
  if (env.GITHUB_WORKFLOW_REF !== `${repo}/${path}@refs/heads/${context.defaultBranch}`
    || completion !== (env.FACTORY_COMPLETION_ENTRY === "true")
    || completion && env.GITHUB_EVENT_NAME !== "workflow_run"
    || !["issues", "issue_comment", "pull_request_target", "push", "workflow_run", "schedule", "workflow_dispatch", "repository_dispatch", "check_run", "status"].includes(env.GITHUB_EVENT_NAME)) throw new Error("Privileged factory entry must be the default-branch caller");
  const run = await api.run(env.GITHUB_RUN_ID, Number(env.GITHUB_RUN_ATTEMPT));
  // For pull_request_target, Actions reports the PR head in the run record,
  // while GITHUB_SHA/GITHUB_REF identify the base workflow being executed.
  const target = env.GITHUB_EVENT_NAME === "pull_request_target";
  const commitMatches = target
    ? run.event === "pull_request_target" && env.GITHUB_REF === `refs/heads/${context.defaultBranch}`
      && Array.isArray(run.pull_requests) && run.pull_requests.length === 1
      && run.pull_requests[0].base?.ref === context.defaultBranch && run.pull_requests[0].base.sha === env.GITHUB_SHA
      && String(run.pull_requests[0].base.repo?.id) === context.repositoryId
      && run.pull_requests[0].head?.sha === run.head_sha && run.pull_requests[0].head.ref === run.head_branch
      && String(run.pull_requests[0].head.repo?.id) === context.repositoryId
    : run.head_branch === context.defaultBranch && run.head_sha === env.GITHUB_SHA;
  if (String(run.repository?.id) !== context.repositoryId || String(run.head_repository?.id) !== context.repositoryId
    || run.path !== path || !commitMatches
    || String(run.id) !== env.GITHUB_RUN_ID || run.run_attempt !== Number(env.GITHUB_RUN_ATTEMPT)
    || run.status !== "in_progress" || completion && run.event !== "workflow_run") throw new Error("Factory entry identity does not match the Actions API");
  return run;
}
