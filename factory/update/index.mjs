import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readClient } from "../lib/github.mjs";
import { githubData, stateStore } from "../lib/store.mjs";
import { workerAssignment } from "../lib/assignment.mjs";
import { cleanUpdate } from "../lib/worker.mjs";
import { cleanGitWriter, repositoryUrl } from "../lib/git.mjs";
import { bundleDigest } from "../lib/artifact.mjs";
import { main, summary } from "../../agent-ready/lib/action.mjs";

main(async () => {
  const env = process.env, repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN;
  const run = { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) };
  const api = readClient({ token, repo, apiUrl: env.GITHUB_API_URL }), repositoryId = String(env.GITHUB_REPOSITORY_ID);
  const store = stateStore({ git: githubData({ token, repo, apiUrl: env.GITHUB_API_URL }), repositoryId });
  const loaded = await workerAssignment({ api, store, repo, repositoryId, run, itemKey: env.FACTORY_ITEM, operationId: env.FACTORY_OPERATION });
  const { operation: op, config } = loaded.assignment, fresh = await loaded.readFresh();
  if (op.mode !== "update" || op.worker.entrySha !== env.GITHUB_SHA || !fresh.valid || fresh.paused
    || fresh.generation !== op.generation || fresh.revision !== op.revision || fresh.head !== op.target.head) throw new Error("The clean update assignment is no longer current");
  const git = cleanGitWriter({ remote: repositoryUrl(repo, env.GITHUB_SERVER_URL), readToken: token, writeToken: null });
  try {
    git.seed(op);
    const directory = env.FACTORY_RESULT_DIR;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const result = cleanUpdate({ cwd: git.directory, operation: op, directory, run,
      author: { name: config.worker.gitName, email: config.worker.gitEmail } });
    const proposal = { schemaVersion: 1, operationId: op.id, run, effects: [],
      outcome: result.outcome === "conflict" ? "failed" : result.outcome,
      reason: result.outcome === "conflict" ? "update-conflict" : "", report: "Clean Git integration; project code was not executed.", tests: [] };
    if (result.outcome === "ready") {
      proposal.bundle = { file: "proposal.bundle", ref: result.ref, commit: result.commit, digest: bundleDigest(readFileSync(result.bundleFile)) };
      proposal.effects.push({ id: "push", type: "push", branch: op.target.branch,
        expectedHead: op.target.head, commit: result.commit, baseSha: op.base.sha });
    }
    writeFileSync(join(directory, "proposal.json"), JSON.stringify(proposal, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    summary(`Factory update: ${result.outcome}.`);
  } finally { git.dispose(); }
});
