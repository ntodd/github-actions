import { publishOperation } from "./publish.mjs";
import { publisherWriter } from "./writer.mjs";
import { cleanGitWriter, repositoryUrl } from "./git.mjs";
import { publishObservation } from "./observe.mjs";
import { attachmentUploader } from "./attachments.mjs";

// The controller invokes this in its own clean job, after the Crew workflow is
// terminal. Expired artifacts do not prevent recovery of already-sent effects.
export function cleanPublisher({ api, write, store, actions, repo, readToken, writeToken, appLogin,
  serverUrl = "https://github.com", gitWriter = cleanGitWriter, assertRuntime = async () => {}, attachmentToken, attachmentFetch }) {
  return async ({ key, operationId, context, run }) => {
    const { state } = await store.load(), op = state.operations[operationId];
    let result = null, git = null;
    const getResult = async () => {
      if (!result) {
        if (op.effects.some((e) => e.type === "attachment" && ["prepared", "rejected"].includes(e.status))) {
          if (!attachmentToken) throw new Error("Screenshot publication requires AGENT_ATTACH_TOKEN in the clean controller job");
          if (serverUrl !== "https://github.com") throw new Error("Screenshot upload is supported only on GitHub.com");
        }
        const facts = await actions.inspect(op, context);
        if (!facts.available) throw new Error("The proposal artifact is unavailable for a new publish effect");
        result = await actions.download(op, context, op.result.artifact);
      }
      return result;
    };
    const getGit = async (needsBundle) => {
      if (needsBundle && !result) {
        await getResult();
        git?.dispose(); git = null;
      }
      return git ??= gitWriter({ remote: repositoryUrl(repo, serverUrl), readToken, writeToken, bundleFile: result?.bundleFile ?? null });
    };
    // Fetch artifacts only after the publisher has established that a new push
    // is still authorized. Receipt recovery and stale retirement need no bundle.
    const proxy = { inspect: async (...args) => (await getGit(false)).inspect(...args),
      validate: async (...args) => (await getGit(true)).validate(...args),
      apply: async (...args) => (await getGit(true)).apply(...args), dispose: () => git?.dispose() };
    const attachments = attachmentUploader({ token: attachmentToken, repositoryId: state.repositoryId, fetchImpl: attachmentFetch, serverUrl,
      readBytes: async (effect) => (await getResult()).attachmentFiles.get(effect.file) });
    const writer = publisherWriter({ git: proxy, api: write, read: api, repo, appLogin, attachments });
    try {
      return await publishOperation({ store, itemKey: key, operationId, publisherRun: run,
        observe: async (item, current) => { await assertRuntime(); return publishObservation(api, item, current, repo, appLogin); }, writer });
    } finally { writer.dispose(); result?.dispose(); }
  };
}
