import { parseDocument } from "../vendor/yaml.mjs";
import { ROUTER_MODEL } from "./router.mjs";
import { validAppLogin } from "./identity.mjs";
import { projectEnvironmentConfig } from "./project-environment.mjs";
export class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}
const fail = (message) => { throw new ConfigError(message); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function fields(value, allowed, path) {
  if (!object(value)) fail(`${path} must be a mapping`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${path} field: ${key}`);
  return value;
}
function string(value, name, { max = 256, pattern } = {}) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || (pattern && !pattern.test(value))) fail(`Invalid ${name}`);
  return value;
}
function list(value, name, pattern) {
  if (!Array.isArray(value) || value.length > 100) fail(`${name} must be a list of at most 100 values`);
  const result = value.map((v) => string(v, name, { pattern }).toLowerCase());
  if (new Set(result).size !== result.length) fail(`${name} has duplicate values`);
  return result;
}
const count = (value, fallback, name, max = 100) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) fail(`${name} must be an integer from 1 to ${max}`);
  return n;
};
const freeze = (v) => { if (v && typeof v === "object") { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; };
// This identity comes from the protected ledger or the controller's App JWT,
// never YAML, a mention handle or a worker's proposed result.
export function withFactoryApp(config, appLogin) {
  if (appLogin === undefined) return config;
  if (!validAppLogin(appLogin) || config.factoryAppLogin && config.factoryAppLogin !== appLogin) fail("Factory App identity is invalid or changed");
  return freeze({ ...config, factoryAppLogin: appLogin });
}
export function parseConfig(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 128 * 1024) fail("Factory config is missing or too large");
  let value;
  try {
    const doc = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true, stringKeys: true,
      customTags: [], resolveKnownTags: false, merge: false, strict: true, logLevel: "error" });
    if (doc.errors.length || doc.warnings.length || doc.directives.yaml.version !== "1.2") fail("Factory config must be unambiguous YAML 1.2");
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (err) { if (err instanceof ConfigError) throw err; fail("Cannot parse factory YAML config"); }
  const v = fields(value, ["trusted-users", "handle", "runner", "effort", "max-rounds", "review-bots", "signals", "producers", "budget", "timeouts", "setup", "environment", "worker", "router"], "config");
  let environment;
  try { environment = projectEnvironmentConfig(v.environment); }
  catch (error) { fail(error.message); }
  const login = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
  const trustedUsers = list(v["trusted-users"], "trusted-users", login);
  if (!trustedUsers.length) fail("At least one trusted user is required");
  const effort = v.effort ?? "medium";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) fail("Unknown effort level");
  const worker = fields(v.worker ?? {}, ["model", "max-turns", "claude-config", "git-name", "git-email"], "worker");
  const router = fields(v.router ?? {}, ["model"], "router");
  const claudeConfig = fields(worker["claude-config"] ?? {}, ["repository", "ref", "path"], "claude-config");
  const budget = fields(v.budget ?? {}, ["automatic-attempts-per-item-per-day", "repeated-failure-limit"], "budget");
  const timeouts = fields(v.timeouts ?? {}, ["queued-minutes", "worker-minutes", "ci-minutes", "review-minutes", "dispatch-minutes", "publish-minutes"], "timeouts");
  if (!Array.isArray(v.signals ?? []) || (v.signals ?? []).length > 100) fail("signals must be a list of at most 100 checks");
  const signals = (v.signals ?? []).map((signal) => {
    fields(signal, ["check", "blocking"], "signal");
    if (typeof signal.blocking !== "boolean") fail("A signal needs an explicit blocking boolean");
    return { check: string(signal.check, "signal check name"), blocking: signal.blocking };
  });
  if (new Set(signals.map((s) => s.check)).size !== signals.length) fail("Duplicate signal names");
  if (v.setup !== undefined && (typeof v.setup !== "string" || v.setup.length > 64 * 1024)) fail("setup must be a script string");
  const configPath = claudeConfig.path ?? "claude";
  if (typeof configPath !== "string" || !/^[\w./-]+$/.test(configPath) || configPath.startsWith("/") || configPath.split("/").includes("..")) fail("Invalid Claude config path");
  return freeze({ worker: {
    model: string(worker.model ?? "opus", "worker model", { pattern: /^[a-z\d][a-z\d._:-]*$/i }),
    maxTurns: count(worker["max-turns"], 500, "max-turns", 5000),
    claudeConfig: { repository: string(claudeConfig.repository ?? "ntodd/dotfiles", "Claude config repository", { pattern: /^[\w.-]+\/[\w.-]+$/ }),
      ref: string(claudeConfig.ref ?? "main", "Claude config ref", { pattern: /^[a-z\d][a-z\d._/-]*$/i }), path: configPath },
    gitName: string(worker["git-name"] ?? "factory", "git-name"),
    gitEmail: string(worker["git-email"] ?? "factory@users.noreply.github.com", "git-email", { pattern: /^[^\s<>]+@[^\s<>]+$/ }),
  }, router: { model: string(router.model ?? ROUTER_MODEL, "router model", { pattern: /^[a-z\d][a-z\d._-]*$/i }) },
    trustedUsers, handle: string(v.handle ?? "ntodd-agent", "handle", { pattern: login }),
    runner: string(v.runner ?? "crew-l", "runner", { max: 128, pattern: /^[a-z\d][a-z\d._-]*$/i }), effort,
    maxRounds: count(v["max-rounds"], 3, "max-rounds", 20),
    reviewBots: list(v["review-bots"] ?? [], "review-bots", /^[a-z\d][a-z\d-]*(?:\[bot\])?$/i), signals,
    producers: list(v.producers ?? [], "producers", /^[a-z][a-z\d-]*$/i),
    budget: { automaticAttemptsPerItemPerDay: count(budget["automatic-attempts-per-item-per-day"], 3, "automatic-attempts-per-item-per-day"),
      repeatedFailureLimit: count(budget["repeated-failure-limit"], 2, "repeated-failure-limit") },
    timeouts: { queuedMinutes: count(timeouts["queued-minutes"], 30, "queued-minutes", 1440),
      workerMinutes: count(timeouts["worker-minutes"], 120, "worker-minutes", 1440),
      ciMinutes: count(timeouts["ci-minutes"], 60, "ci-minutes", 1440),
      reviewMinutes: count(timeouts["review-minutes"], 30, "review-minutes", 1440),
      publishMinutes: count(timeouts["publish-minutes"], 15, "publish-minutes", 1440),
      dispatchMinutes: count(timeouts["dispatch-minutes"], 5, "dispatch-minutes", 1440) }, setup: v.setup ?? "", environment });
}

// Always resolve the default branch through GitHub and pin the file read to
// that commit. Event payloads and PR worktrees never supply configuration.
export async function loadConfig(api) {
  const repository = await api.repository();
  const ref = repository.default_branch;
  if (typeof ref !== "string" || !ref) fail("Repository has no default branch");
  const sha = await api.branchSha(ref);
  if (!/^[a-f\d]{40}$/.test(sha)) fail("Invalid default-branch commit");
  const file = await api.fileAt(".github/factory.yml", sha);
  if (typeof file.content !== "string") fail("Factory config is missing");
  return { config: withFactoryApp(parseConfig(file.content), api.factoryAppLogin), sha, defaultBranch: ref, repositoryId: String(repository.id) };
}
