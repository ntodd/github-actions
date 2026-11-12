import { parseDocument } from "../vendor/yaml.mjs";

export const setupUsage = `Usage: factory/enable.sh [options] owner/repo

  --app <slug>       App credential directory name (default ntodd-agent)
  --app-dir <path>   Directory containing app.json and private-key.pem
  --config <path>    Config to propose; otherwise retain the repo's config
  --trusted <users>  Trusted logins for a new config (comma/space separated)
  --ci <name>        CI workflow name; repeat for several (default CI)
  --check <context>  Required check; optional @App-ID; repeat for several
  --checks <path>    JSON array of required check identities instead
  --ref <ref>        Shared workflow ref (default main)
  --preview         Read and print the plan; make no repository/local writes
  --activate        Propose an active caller after migration/legacy guards
  --bootstrap       Propose only a read-only caller/config to inspect an existing GitHub-held App key
  --journal <path>  Administrator recovery journal (default user state dir)

The default caller is read-only. Setup opens a PR; it never merges it.
Model credentials in the environment are copied to repository secrets.
`;

export function parseSetupOptions(args) {
  const options = { app: "ntodd-agent", ref: "main", ci: [], check: [], preview: false, activate: false };
  const values = new Map([["--app", "app"], ["--app-dir", "appDir"], ["--config", "config"], ["--trusted", "trusted"],
    ["--ci", "ci"], ["--check", "check"], ["--checks", "checks"], ["--ref", "ref"], ["--journal", "journal"]]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--help", "-h"].includes(arg)) return { help: true };
    if (arg === "--preview" || arg === "--dry-run") options.preview = true;
    else if (arg === "--activate") options.activate = true;
    else if (arg === "--bootstrap") options.bootstrap = true;
    else if (values.has(arg)) {
      const value = args[++i], key = values.get(arg);
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (["ci", "check"].includes(key)) options[key].push(value);
      else options[key] = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown setup option: ${arg}`);
    else if (options.repo) throw new Error("Set up one repository per command");
    else options.repo = arg;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo ?? "") || !/^[a-z\d][a-z\d-]*$/i.test(options.app)) throw new Error("Provide a valid repository and App slug");
  if (options.checks && options.check.length) throw new Error("Use --check or --checks, not both");
  if (options.config && options.trusted) throw new Error("Put trusted-users in --config, or use --trusted for a new default config");
  if (options.bootstrap && (options.activate || options.appDir || options.checks || options.check.length || !/^[a-f0-9]{40}$/.test(options.ref))) {
    throw new Error("Bootstrap needs --ref <commit SHA>; activation, local App keys and check changes belong to administrator setup");
  }
  return options;
}

export function validateSetupCi(source, name) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 128 * 1024) throw new Error(`CI workflow ${name} is missing or too large`);
  const doc = parseDocument(source, { version: "1.2", uniqueKeys: true, logLevel: "error" });
  if (doc.errors.length) throw new Error(`CI workflow ${name} could not be parsed`);
  const workflow = doc.toJS({ maxAliasCount: 100 }), on = workflow?.on;
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : on && typeof on === "object" ? Object.keys(on) : [];
  if (!events.includes("pull_request") || !events.includes("push")) throw new Error(`CI workflow ${name} must declare pull_request and push triggers`);
}

export function resolveSetupChecks(specs, observed) {
  return specs.map((spec) => {
    const binding = /^(.*)@([1-9]\d*)$/.exec(spec);
    if (binding) {
      const id = Number(binding[2]);
      if (!Number.isSafeInteger(id)) throw new Error("Invalid check App ID");
      return { context: binding[1], integration_id: id };
    }
    const apps = [...new Set(observed.checks.filter((c) => c.name === spec).map((c) => c.app?.id))];
    if (apps.length === 1 && Number.isSafeInteger(apps[0]) && apps[0] > 0) return { context: spec, integration_id: apps[0] };
    if (!apps.length && observed.statuses.some((s) => s.context === spec)) return { context: spec };
    throw new Error(`Cannot uniquely bind check ${spec} on the current default branch; use context@App-ID`);
  });
}

export function validateSharedSetupWorkflow(source, name) {
  const doc = parseDocument(source, { version: "1.2", uniqueKeys: true, logLevel: "error" });
  if (doc.errors.length) throw new Error(`Shared workflow ${name} could not be parsed`);
  const workflow = doc.toJS({ maxAliasCount: 100 });
  if (!workflow?.on || typeof workflow.on !== "object" || !Object.hasOwn(workflow.on, "workflow_call")) throw new Error(`Shared workflow ${name} is not reusable`);
}
