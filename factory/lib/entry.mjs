// A privileged entry is the reviewed caller on the repository's default
// branch. In particular, a PR-context review hop cannot mint the App token.
export function controllerWakeup(eventName, event) {
  return eventName !== "workflow_run" || event?.workflow_run?.path !== ".github/workflows/factory.yml"
    || event.workflow_run.event === "workflow_dispatch";
}

export async function verifyEntry({ api, env, context }) {
  const path = ".github/workflows/factory.yml", repo = env.GITHUB_REPOSITORY;
  if (env.GITHUB_WORKFLOW_REF !== `${repo}/${path}@refs/heads/${context.defaultBranch}`
    || !["issues", "issue_comment", "pull_request_target", "push", "workflow_run", "schedule", "workflow_dispatch", "repository_dispatch", "check_run", "status"].includes(env.GITHUB_EVENT_NAME)) throw new Error("Privileged factory entry must be the default-branch caller");
  const run = await api.run(env.GITHUB_RUN_ID, Number(env.GITHUB_RUN_ATTEMPT));
  if (String(run.repository?.id) !== context.repositoryId || String(run.head_repository?.id) !== context.repositoryId
    || run.path !== path || run.head_branch !== context.defaultBranch || run.head_sha !== env.GITHUB_SHA
    || String(run.id) !== env.GITHUB_RUN_ID || run.run_attempt !== Number(env.GITHUB_RUN_ATTEMPT)
    || run.status !== "in_progress") throw new Error("Factory entry identity does not match the Actions API");
  return run;
}
