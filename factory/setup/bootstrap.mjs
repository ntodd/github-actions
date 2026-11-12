import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { setupClient, runGh } from "../lib/setup-client.mjs";
import { bootstrapPlan, applyBootstrap } from "../lib/bootstrap.mjs";
import { setupJournal } from "../lib/setup-journal.mjs";
import { validateSetupCi, validateSharedSetupWorkflow } from "../lib/setup-options.mjs";

export async function bootstrap(options) {
  const token = runGh(["auth", "token", "--hostname", "github.com"]).trim(), api = setupClient({ token, repo: options.repo });
  const repository = await api.repository(), baseSha = await api.branchSha(repository.default_branch);
  const variable = await api.variable("AGENT_APP_ID");
  let configText;
  if (options.config) configText = readFileSync(resolve(options.config), "utf8");
  else {
    try { configText = await api.fileAt(".github/factory.yml", baseSha); }
    catch (error) { if (error.status !== 404) throw error; }
    if (configText && options.trusted) throw new Error("Use --config to change an existing repository configuration");
    if (!configText) {
      const trusted = options.trusted?.split(/[\s,]+/).filter(Boolean)
        ?? [runGh(["api", "user", "--jq", ".login", "--hostname", "github.com"]).trim()];
      configText = `trusted-users: ${JSON.stringify(trusted)}\nhandle: ${options.app}\nrunner: crew-l\nproducers: [flake-hunt, main-red]\n`;
    }
  }
  const ci = options.ci.length ? options.ci : ["CI"], workflows = await api.workflows();
  for (const name of ci) {
    const matches = workflows.filter((w) => w.name === name && w.state === "active");
    if (matches.length !== 1) throw new Error(`Expected one active CI workflow named ${name}`);
    validateSetupCi(await api.fileAt(matches[0].path, baseSha), name);
  }
  const shared = setupClient({ token, repo: "ntodd/github-actions" });
  if (await shared.resolveRef(options.ref) !== options.ref) throw new Error("Bootstrap requires the exact shared runtime commit SHA");
  for (const name of ["factory-runtime", "factory-wakeup"]) validateSharedSetupWorkflow(await shared.fileAt(`.github/workflows/${name}.yml`, options.ref), name);
  const plan = bootstrapPlan({ repository, configText, baseSha, appIdCandidate: variable.value, ciWorkflows: ci, ref: options.ref });
  if (options.preview) return applyBootstrap({ plan, api, preview: true });
  const path = options.journal ? resolve(options.journal) : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "factory", `setup-${repository.id}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error(`Setup is locked at ${lock}; verify the owning process before removing a stale lock`); }
  try { return await applyBootstrap({ plan, api, journal: setupJournal(path, String(repository.id)) }); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
