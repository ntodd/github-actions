import { publishOperation } from "./publish.mjs";
import { publisherWriter } from "./writer.mjs";
import { cleanGitWriter, repositoryUrl } from "./git.mjs";
import { publishObservation } from "./observe.mjs";

// The controller invokes this in its own clean job, after the Crew workflow is
// terminal. Expired artifacts do not prevent recovery of already-sent effects.
export function cleanPublisher({ api, write, store, actions, repo, readToken, writeToken, appLogin,
  serverUrl = "https://github.com", gitWriter = cleanGitWriter, assertRuntime = async () => {} }) {
  return async ({ key, operationId, context, run }) => {
    const { state } = await store.load(), op = state.operations[operationId];
    let result = null, git = null;
    const getGit = async (needsBundle) => {
      if (needsBundle && !result) {
        const facts = await actions.inspect(op, context);
        if (!facts.available) throw new Error("The proposal bundle is unavailable for a new push");
        result = await actions.download(op, context, op.result.artifact);
        git?.dispose(); git = null;
      }
      return git ??= gitWriter({ remote: repositoryUrl(repo, serverUrl), readToken, writeToken, bundleFile: result?.bundleFile ?? null });
    };
    // Fetch artifacts only after the publisher has established that a new push
    // is still authorized. Receipt recovery and stale retirement need no bundle.
    const proxy = { inspect: async (...args) => (await getGit(false)).inspect(...args),
      validate: async (...args) => (await getGit(true)).validate(...args),
      apply: async (...args) => (await getGit(true)).apply(...args), dispose: () => git?.dispose() };
    const writer = publisherWriter({ git: proxy, api: write, read: api, repo, appLogin });
    try {
      return await publishOperation({ store, itemKey: key, operationId, publisherRun: run,
        observe: async (item, current) => { await assertRuntime(); return publishObservation(api, item, current, repo, appLogin); }, writer });
    } finally { writer.dispose(); result?.dispose(); }
  };
}
