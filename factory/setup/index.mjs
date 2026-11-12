#!/usr/bin/env node
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { setupClient, inspectSetupApp, runGh } from "../lib/setup-client.mjs";
import { setupPlan, validateSetupApp } from "../lib/setup.mjs";
import { parseConfig } from "../lib/config.mjs";
import { parseSetupOptions, setupUsage, validateSetupCi, resolveSetupChecks, validateSharedSetupWorkflow } from "../lib/setup-options.mjs";
import { applySetupPlan } from "../lib/setup-apply.mjs";
import { setupJournal } from "../lib/setup-journal.mjs";
import { stateStore, githubData } from "../lib/store.mjs";
import { bootstrap } from "./bootstrap.mjs";

let release = () => {};
async function configureRepository(options) {
  const appDir = options.appDir ? resolve(options.appDir) : join(homedir(), ".config", "agent-ready", options.app);
  let appFile, privateKey;
  try {
    appFile = JSON.parse(readFileSync(join(appDir, "app.json"), "utf8"));
    privateKey = readFileSync(join(appDir, "private-key.pem"), "utf8");
  } catch { throw new Error(`App credentials are unavailable in ${appDir}. Provide --app-dir or create the App with agent-ready/app/create-app.mjs.`); }
  const token = runGh(["auth", "token", "--hostname", "github.com"]).trim();
  const api = setupClient({ token, repo: options.repo });
  const repository = await api.repository();
  const inspected = await inspectSetupApp({ appId: appFile.id, privateKey, repo: options.repo });
  const sha = await api.branchSha(repository.default_branch);
  let configText;
  if (options.config) configText = readFileSync(resolve(options.config), "utf8");
  else {
    try { configText = await api.fileAt(".github/factory.yml", sha); }
    catch (error) { if (error.status !== 404) throw error; }
    if (configText && options.trusted) throw new Error("Use --config to change an existing repository configuration");
    if (!configText) {
      const trusted = options.trusted?.split(/[\s,]+/).filter(Boolean)
        ?? [runGh(["api", "user", "--jq", ".login", "--hostname", "github.com"]).trim()];
      configText = `trusted-users: ${JSON.stringify(trusted)}\nhandle: ${inspected.app.slug}\nrunner: crew-l\nproducers: [flake-hunt, main-red]\n`;
    }
  }
  validateSetupApp({ ...inspected.app, permissions: inspected.installation.permissions }, parseConfig(configText));
  const ci = options.ci.length ? options.ci : ["CI"], workflows = await api.workflows();
  for (const name of ci) {
    const matches = workflows.filter((w) => w.name === name && w.state === "active");
    if (matches.length !== 1) throw new Error(`Expected one active CI workflow named ${name}; specify --ci`);
    validateSetupCi(await api.fileAt(matches[0].path, sha), name);
  }
  let checks;
  if (options.checks) checks = JSON.parse(readFileSync(resolve(options.checks), "utf8"));
  else if (options.check.length) {
    const [runs, statuses] = await Promise.all([api.checks(sha), api.statuses(sha)]);
    checks = resolveSetupChecks(options.check, { checks: runs.check_runs, statuses });
  } else checks = (await api.branchRules(repository.default_branch)).filter((r) => r.type === "required_status_checks")
    .flatMap((r) => r.parameters.required_status_checks);
  const plan = setupPlan({ repository, app: inspected.app, configText, checks, ciWorkflows: ci, ref: options.ref, dryRun: !options.activate });
  const shared = setupClient({ token, repo: "ntodd/github-actions" }), sharedSha = await shared.resolveRef(options.ref);
  for (const name of ["factory-runtime", "factory-wakeup"]) validateSharedSetupWorkflow(await shared.fileAt(`.github/workflows/${name}.yml`, sharedSha), name);
  const secrets = { AGENT_APP_PRIVATE_KEY: privateKey };
  for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SETUP_SECRETS"]) {
    if (process.env[name]) secrets[name] = process.env[name];
  }
  const store = stateStore({ repositoryId: String(repository.id), git: githubData({ token, repo: options.repo }) });
  const journalPath = options.journal ? resolve(options.journal) : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "factory", `setup-${repository.id}.json`);
  let journal;
  if (!options.preview) {
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    const lock = `${journalPath}.lock`;
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch { throw new Error(`Setup is locked at ${lock}. If a previous process was killed, verify it has stopped before removing that lock.`); }
    release = () => rmSync(lock, { recursive: true, force: true });
    journal = setupJournal(journalPath, String(repository.id));
  }
  const result = await applySetupPlan({ plan, api, store, journal, secrets, preview: options.preview });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  const options = parseSetupOptions(process.argv.slice(2));
  if (options.help) process.stdout.write(setupUsage);
  else if (options.bootstrap) process.stdout.write(`${JSON.stringify(await bootstrap(options), null, 2)}\n`);
  else await configureRepository(options);
} catch (error) {
  process.stderr.write(`Factory setup: ${error.message}\n`); process.exitCode = 1;
} finally { release(); }
