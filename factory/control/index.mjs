import { readFileSync } from "node:fs";
import { readClient } from "../lib/github.mjs";
import { writeClient } from "../lib/github-write.mjs";
import { actionsClient } from "../lib/actions.mjs";
import { githubData, stateStore } from "../lib/store.mjs";
import { loadConfig, withFactoryApp } from "../lib/config.mjs";
import { recordFactoryApp } from "../lib/protocol.mjs";
import { verifyEntry } from "../lib/entry.mjs";
import { parseRequest, claimOperation, runController } from "../lib/controller.mjs";
import { cleanPublisher } from "../lib/publisher.mjs";
import { surfaceService } from "../lib/surfaces.mjs";
import { restartService } from "../lib/restart.mjs";
import { continueService } from "../lib/continue.mjs";
import { mentionRouter } from "../lib/router.mjs";
import { assertRuntimeIsolation } from "../lib/runtime-guard.mjs";
import { installationToken, appSlug } from "../../agent-ready/lib/app-token.mjs";
import { main, setOutput, summary, mask } from "../../agent-ready/lib/action.mjs";

main(async () => {
  const env = process.env, repo = env.GITHUB_REPOSITORY, apiUrl = env.GITHUB_API_URL;
  const api = readClient({ token: env.GITHUB_TOKEN, repo, apiUrl });
  const context = { ...await loadConfig(api), repo };
  await verifyEntry({ api, env, context });
  const request = parseRequest(env.FACTORY_REQUEST);
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const run = { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) };
  const dryRun = env.FACTORY_DRY_RUN === "true";
  const assertRuntime = () => assertRuntimeIsolation(api);
  if (!dryRun) await assertRuntime(); // Before minting an App write token.
  let token = env.GITHUB_TOKEN, appLogin;
  if (!dryRun) {
    const key = env.FACTORY_APP_PRIVATE_KEY;
    if (!key) throw new Error("The clean controller requires its App credential");
    const app = { appId: env.FACTORY_APP_ID, privateKey: key, repo, apiUrl };
    const installation = await installationToken({ ...app, permissions: { contents: "write", issues: "write", pull_requests: "write", actions: "write" } });
    token = installation.token; mask(token);
    appLogin = `${await appSlug(app)}[bot]`;
    delete env.FACTORY_APP_PRIVATE_KEY;
  }
  const store = stateStore({ repositoryId: context.repositoryId, git: githubData({ token, repo, apiUrl }) });
  const { state } = await store.load();
  if (!state.factoryApp) throw new Error("Factory App identity is missing from protected state; rerun factory setup before enabling work");
  if (!dryRun) recordFactoryApp(state, { id: String(env.FACTORY_APP_ID), login: appLogin.toLowerCase() });
  api.factoryAppLogin = state.factoryApp.login;
  context.config = withFactoryApp(context.config, state.factoryApp.login);
  // A controller completion must not trigger an endless workflow_run chain.
  // CI completions still reconcile; factory completions require a recorded owner.
  if (env.GITHUB_EVENT_NAME === "workflow_run" && event.workflow_run?.path === ".github/workflows/factory.yml"
    && !Object.values(state.operations).some((op) => op.owner?.id === String(event.workflow_run.id))) {
    summary("Factory controller completion: no worker operation to collect."); return;
  }
  if (request.kind === "worker") {
    if (dryRun) throw new Error("A read-only controller cannot claim a worker");
    const claimed = await claimOperation({ api, store, repo, itemKey: request.item, operationId: request.operation, run, context });
    setOutput("worker", claimed.claimed);
    if (!claimed.claimed) return;
    const op = claimed.operation, config = claimed.config;
    for (const [name, value] of Object.entries({ item: request.item, operation: op.id, mode: op.mode,
      head: op.target.head ?? op.base.sha, tooling: op.toolingSha, runner: config.runner,
      timeout: config.timeouts.workerMinutes, model: config.worker.model, effort: config.effort,
      config_repository: config.worker.claudeConfig.repository, config_ref: config.worker.claudeConfig.ref,
      config_path: config.worker.claudeConfig.path })) setOutput(name, value);
    return;
  }
  const write = writeClient({ token, repo, apiUrl }), actions = actionsClient({ token: env.GITHUB_TOKEN, repo, apiUrl });
  const surfaces = dryRun ? null : surfaceService({ api, write, store, repo, appLogin, run, assertRuntime });
  const result = await runController({ api, write, store, actions, repo, toolingSha: env.FACTORY_TOOLING_SHA, run, dryRun,
    surfaces, assertRuntime,
    route: mentionRouter({ apiKey: env.OPENAI_API_KEY }),
    restart: dryRun ? null : restartService({ api, store, effects: surfaces, appLogin }),
    continueIssue: dryRun ? null : continueService({ api, store, effects: surfaces }),
    target: request.target ?? event.issue?.number ?? event.pull_request?.number ?? null,
    publish: cleanPublisher({ api, write, store, actions, repo, readToken: env.GITHUB_TOKEN, writeToken: token,
      appLogin, serverUrl: env.GITHUB_SERVER_URL, assertRuntime }),
  });
  summary(`Factory ${dryRun ? "read-only plan" : "controller pass"}\n\n${JSON.stringify(result, null, 2)}`);
});
