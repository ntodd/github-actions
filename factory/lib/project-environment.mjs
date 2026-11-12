// Project values and secrets belong only to the disposable Crew job. Nothing
// here writes Actions outputs, the ledger, or an environment for a clean writer.
import { constants, openSync, fstatSync, readSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parseDocument } from "../vendor/yaml.mjs";

const MAX_SECRETS = 48 * 1024, MAX_FILE = 512 * 1024;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const reserved = /^(?:GITHUB_|GH_|GIT_|ACTIONS_|RUNNER_|FACTORY_|AGENT_|FLAKE_HUNT_|INPUT_|CLAUDE_|ANTHROPIC_|OPENAI_|CODEX_|LD_|DYLD_|BASH_)/i;
const runtimeNames = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "IFS", "ENV", "CDPATH",
  "SHLVL", "SHELLOPTS", "BASHOPTS", "PS4", "NODE_OPTIONS", "NODE_PATH", "__PROTO__", "PROTOTYPE", "CONSTRUCTOR"]);
export class ProjectEnvironmentError extends Error {
  constructor(message) { super(message); this.name = "ProjectEnvironmentError"; this.code = "project-environment"; }
}
const fail = (message) => { throw new ProjectEnvironmentError(message); };
export const projectName = (name) => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
  && !reserved.test(name) && !runtimeNames.has(name.toUpperCase());
function values(value, maxBytes, maxEntries = 100) {
  if (!object(value) || Object.keys(value).length > maxEntries) fail("Project environment contains too many variables or is not a mapping");
  let bytes = 0;
  for (const [name, text] of Object.entries(value)) {
    if (!projectName(name)) fail("Project environment contains a reserved or invalid variable name");
    if (typeof text !== "string" || text.includes("\0")) fail("Project environment values must be strings without NUL characters");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(text);
    if (bytes > maxBytes) fail("Project environment values exceed their size limit");
  }
  return Object.fromEntries(Object.entries(value));
}
export function projectEnvironmentConfig(value = {}) {
  if (!object(value) || Object.keys(value).some((key) => !["values", "setup-secrets", "worker-secrets"].includes(key))) fail("Invalid project environment configuration");
  const publicValues = values(value.values ?? {}, 64 * 1024);
  const names = (list) => {
    if (!Array.isArray(list) || list.length > 100 || list.some((name) => !projectName(name)) || new Set(list).size !== list.length) fail("Project secret lists need unique, non-reserved variable names");
    if (list.some((name) => Object.hasOwn(publicValues, name))) fail("A project variable cannot have both a public and secret value");
    return [...list];
  };
  const setupSecrets = names(value["setup-secrets"] ?? []), workerSecrets = names(value["worker-secrets"] ?? []);
  if (new Set([...setupSecrets, ...workerSecrets]).size > 100) fail("Project secret lists may declare at most 100 different variables");
  return { values: publicValues, setupSecrets, workerSecrets };
}

// The legacy NAME=value format remains literal (no shell evaluation or dotenv
// expansion). JSON supports multiline values and rejects duplicate properties.
export function parseProjectSecrets(text = "") {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_SECRETS || text.includes("\0")) fail("SETUP_SECRETS is invalid or exceeds 48 KiB");
  if (!text.trim()) return {};
  if (text.trimStart().startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
      const doc = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true, stringKeys: true, logLevel: "error" });
      if (doc.errors.length || doc.warnings.length) throw new Error();
    } catch { fail("SETUP_SECRETS must be a JSON string mapping without duplicate keys, or NAME=value lines"); }
    return values(parsed, MAX_SECRETS);
  }
  const result = {};
  for (const row of text.split("\n")) {
    const line = row.replace(/\r$/, "");
    if (!line) continue;
    const split = line.indexOf("="), name = line.slice(0, split);
    if (split < 1 || !projectName(name) || Object.hasOwn(result, name)) fail("SETUP_SECRETS has an invalid, reserved or duplicate NAME=value entry");
    result[name] = line.slice(split + 1);
  }
  return values(result, MAX_SECRETS);
}
const declared = (environment) => [...new Set([...environment.setupSecrets, ...environment.workerSecrets])];
export function selectProjectSecrets(environment, text) {
  const bundle = parseProjectSecrets(text);
  return Object.fromEntries(declared(environment).map((name) => {
    if (!Object.hasOwn(bundle, name)) fail(`Required project secret is missing from SETUP_SECRETS: ${name}`);
    return [name, bundle[name]];
  }));
}
export function projectValues(environment, secrets, phase) {
  if (!["setup", "worker"].includes(phase)) fail("Unknown project environment phase");
  const checked = values(secrets, MAX_SECRETS), allowed = declared(environment);
  if (Object.keys(checked).some((name) => !allowed.includes(name))) fail("The project environment file contains undeclared secrets");
  return { ...environment.values, ...Object.fromEntries(environment[`${phase}Secrets`].map((name) => {
    if (!Object.hasOwn(checked, name)) fail(`Required project secret is unavailable: ${name}`);
    return [name, checked[name]];
  })) };
}

export function projectEnvironmentPath(env) {
  if (!isAbsolute(env.RUNNER_TEMP ?? "") || !isAbsolute(env.GITHUB_WORKSPACE ?? "")) fail("Project environment needs the runner's temporary directory and workspace");
  const path = join(env.RUNNER_TEMP, "factory", "project-environment.json"), inside = relative(env.GITHUB_WORKSPACE, path);
  if (!inside.startsWith("../") && inside !== ".." && !isAbsolute(inside)) fail("Project secrets must be stored outside the project checkout");
  return path;
}
const binding = (assignment, run) => ({ operation: assignment.operation.id, generation: assignment.operation.generation,
  configSha: assignment.operation.configSha, run: { id: run.id, attempt: run.attempt } });
export const maskProjectSecret = (text) => {
  if (text) process.stdout.write(`::add-mask::${text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`);
};
export function writeProjectEnvironment({ path, assignment, run, text, mask = maskProjectSecret }) {
  const secrets = selectProjectSecrets(assignment.config.environment, text);
  for (const value of Object.values(secrets)) mask(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...binding(assignment, run), secrets }) + "\n", { flag: "wx", mode: 0o600 });
}
export function readProjectEnvironment({ path, assignment, run }) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_FILE || stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error();
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let size = 0, read;
    do { read = readSync(descriptor, buffer, size, buffer.length - size, null); size += read; } while (read && size < buffer.length);
    if (size > MAX_FILE) throw new Error();
    const data = JSON.parse(buffer.subarray(0, size).toString("utf8")), expected = binding(assignment, run);
    if (data.schemaVersion !== 1 || data.operation !== expected.operation || data.generation !== expected.generation
      || data.configSha !== expected.configSha || data.run?.id !== run.id || data.run?.attempt !== run.attempt) throw new Error();
    projectValues(assignment.config.environment, data.secrets, "setup");
    projectValues(assignment.config.environment, data.secrets, "worker");
    return values(data.secrets, MAX_SECRETS);
  } catch { fail("Project environment file is unavailable, invalid or belongs to another operation/run attempt"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function projectProcessEnvironment(env, readToken, project, phase) {
  if (!["setup", "worker"].includes(phase) || typeof readToken !== "string" || !readToken) fail("Project processes require a read-only token and known phase");
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "SHELL", "USER", "CI", "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "GITHUB_WORKSPACE"];
  if (phase === "setup") keep.push("GITHUB_ENV", "GITHUB_PATH");
  else keep.push("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY");
  return { ...Object.fromEntries(keep.filter((key) => env[key]).map((key) => [key, env[key]])),
    ...values(project, 112 * 1024, 200), GH_TOKEN: readToken, ...(phase === "worker" ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}) };
}
