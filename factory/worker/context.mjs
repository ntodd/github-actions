import { join } from "node:path";
import { readClient } from "../lib/github.mjs";
import { githubData, stateStore } from "../lib/store.mjs";
import { workerAssignment } from "../lib/assignment.mjs";
import { gitCommand } from "../lib/git.mjs";
import { projectEnvironmentPath } from "../lib/project-environment.mjs";
import { assertRuntimeIsolation } from "../lib/runtime-guard.mjs";

// Recheck immediately before releasing project secrets or executing project
// code. Both setup and the model worker use the same trusted assignment path.
export async function currentWorker({ env = process.env, checkout = false, api, store } = {}) {
  const token = env.GITHUB_TOKEN, repo = env.GITHUB_REPOSITORY, repositoryId = String(env.GITHUB_REPOSITORY_ID);
  const run = { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) };
  api ??= readClient({ token, repo, apiUrl: env.GITHUB_API_URL });
  store ??= stateStore({ repositoryId, git: githubData({ token, repo, apiUrl: env.GITHUB_API_URL }) });
  await assertRuntimeIsolation(api);
  const loaded = await workerAssignment({ api, store, repo, repositoryId, run, itemKey: env.FACTORY_ITEM, operationId: env.FACTORY_OPERATION });
  const readFresh = async () => { await assertRuntimeIsolation(api); return loaded.readFresh(); };
  const op = loaded.assignment.operation, fresh = await loaded.readFresh();
  if (op.worker.entrySha !== env.GITHUB_SHA || !fresh.valid || fresh.paused || fresh.generation !== op.generation
    || fresh.revision !== op.revision || fresh.head !== op.target.head || fresh.owner?.id !== run.id || fresh.owner?.attempt !== run.attempt) {
    throw new Error("The worker assignment was stopped, changed or superseded before project execution");
  }
  const cwd = env.GITHUB_WORKSPACE, environmentFile = projectEnvironmentPath(env);
  if (checkout && gitCommand(cwd, ["rev-parse", "HEAD"]).stdout.toString("utf8").trim() !== (op.target.head ?? op.base.sha)) {
    throw new Error("Project checkout does not match the recorded worker assignment");
  }
  return { ...loaded, readFresh, cwd, readToken: token, run, environmentFile, resultDir: join(env.RUNNER_TEMP, "factory", "result") };
}
