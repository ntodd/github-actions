import { createHash } from "node:crypto";
export const diagnosticHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const generic = /^(?:process completed with exit code \d+\.?|test .+\([^)]+\)|assertion (?:with .* )?failed|compilation failed|error|cannot compile module.*errors have been logged.*)$/i;
const fatal = /^\s*(?:\*\*\s*\(|error\b|fatal\b|failed\b|failure\b|exception\b|panic\b|Traceback\b|not ok\b|::error\b)/i;
const pathOf = (value) => {
  let path = String(value ?? "").replaceAll("\\", "/");
  if (path.startsWith("/")) path = /(?:^|\/)((?:test|tests|lib|src|apps|app|packages|crates)\/.*)$/.exec(path)?.[1] ?? "";
  return path && path.length <= 512 && !path.split("/").includes("..") && !/[\x00-\x1f]/.test(path) ? path.replace(/^\.\//, "") : null;
};
const clean = (value) => String(value).replace(/^\uFEFF/, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z[ \t]?/, "").replace(/^##\[error\]/, "")).join("\n");
const messageOf = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
function diagnostic(kind, path, name, message) {
  path = pathOf(path); message = messageOf(message);
  if (!path || !message || generic.test(message) || message.length > 8000 || String(name).length > 1000) return null;
  const value = { kind, path, name, message };
  return { ...value, signature: diagnosticHash(value) };
}
const unknown = (reason, diagnostics = []) => ({ complete: false, reason, diagnostics });
const report = (diagnostics, complete, reason) => diagnostics.length > 0 && diagnostics.length <= 100 && diagnostics.every(Boolean) && complete
  ? { complete: true, diagnostics, reason: null } : unknown(reason, diagnostics.filter(Boolean).slice(0, 100));

// Parse complete failed-step output. A generic exit code, test name, partial
// report or unknown error format is insufficient to defer the entire check.
export function parseFailureLog(input) {
  if (typeof input !== "string" || Buffer.byteLength(input) > 512 * 1024) return unknown("Failure output is missing or exceeds its bound");
  const text = clean(input), lines = text.split("\n");
  if (lines.some((line) => line.length > 16000)) return unknown("A diagnostic line exceeds its bound");
  const headers = [...text.matchAll(/^\s+\d+\) (test .+\([^)]+\))\s*$/gm)];
  if (headers.length) {
    const footer = [...text.matchAll(/^(?:.*?\b\d+ tests?,\s*(\d+) failures?\b.*|Failed:\s*(\d+) tests?)$/gm)].at(-1);
    const diagnostics = headers.map((header, i) => {
      const block = text.slice(header.index + header[0].length, headers[i + 1]?.index ?? footer?.index ?? text.length);
      const location = /^\s*(\S+\.exs?):\d+(?::\d+)?\s*$/m.exec(block);
      if (!location) return null;
      const body = block.slice(location.index + location[0].length).split(/^\s*stacktrace:\s*$/m)[0];
      return diagnostic("exunit", location[1], header[1], body);
    });
    const count = Number(footer?.[1] ?? footer?.[2]);
    const outside = text.slice(0, headers[0].index) + (footer ? text.slice(footer.index + footer[0].length) : "");
    const extraError = outside.split("\n").some((line) => fatal.test(line));
    return report(diagnostics, Boolean(footer) && count === headers.length && !extraError,
      "The test failure report is incomplete or contains another unclassified failure");
  }
  const diagnostics = [], handled = new Set(); let compilePath = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const file = /^== Compilation error in file (.+?) ==\s*$/.exec(line);
    if (file) { compilePath = file[1]; handled.add(i); continue; }
    const ts = /^\s*(.+?\.[cm]?[jt]sx?)(?:\(\d+,\d+\):|:\d+:\d+\s*-?)\s*error\s+(TS\d+):\s*(.+)$/.exec(line);
    if (ts) { diagnostics.push(diagnostic("typescript", ts[1], ts[2], ts[3])); handled.add(i); continue; }
    const exception = /^\s*\*\* \(([^)]+)\) (?:(.+?\.exs?):\d+:\s*)?(.+)$/.exec(line);
    if (exception) {
      const [, kind, path, message] = exception;
      if (compilePath || path) {
        if (!generic.test(message)) diagnostics.push(diagnostic("compiler", path ?? compilePath, kind, message));
        handled.add(i);
      }
      continue;
    }
    const error = /^\s*error:\s*(.+)$/.exec(line);
    if (error) {
      const location = lines.slice(i + 1, i + 8).map((l) => /(?:^|\s)([^\s]+\.exs?):\d+(?::\d+)?(?::\s*(.*))?\s*$/.exec(l)).find(Boolean);
      if (location) { diagnostics.push(diagnostic("compiler", location[1], location[2]?.trim() || "error", error[1])); handled.add(i); }
    }
  }
  const elixir = diagnostics.some((d) => d?.kind === "compiler");
  const extraError = lines.some((line, i) => !handled.has(i) && fatal.test(line)
    && !(elixir && /^\s*\*\* \(Mix\) (?:Compilation failed|Could not compile)/.test(line)));
  const tsCount = /^Found (\d+) errors?\b/m.exec(text);
  if (tsCount && Number(tsCount[1]) !== diagnostics.filter((d) => d?.kind === "typescript").length) return unknown("The compiler error count does not match its diagnostic records", diagnostics.filter(Boolean));
  return report(diagnostics, !extraError, "The compiler output has no complete set of specific diagnostics");
}

export function parseFailureAnnotations(annotations, expectedCount) {
  if (!Array.isArray(annotations) || !Number.isSafeInteger(expectedCount) || annotations.length !== expectedCount) return unknown("The annotation report is incomplete");
  const failures = annotations.filter((a) => a.annotation_level === "failure");
  const diagnostics = failures.map((a) => generic.test(String(a.message ?? "")) ? null
    : diagnostic("annotation", a.path, String(a.title ?? ""), [a.message, a.raw_details].filter(Boolean).join("\n")));
  return report(diagnostics, failures.length > 0, "The annotations contain only generic or incomplete failure evidence");
}

export const checkIdentity = (failure) => [failure.kind, failure.name, failure.appId ?? null, failure.provider ?? null];
export const failureKeys = (checks) => (checks?.failed ?? []).flatMap((failure) => failure.diagnostics?.map((d) =>
  diagnosticHash([checkIdentity(failure), d.signature])) ?? []);

export function attributeFailures(checks, base, baseSha) {
  const next = structuredClone(checks);
  for (const failure of next.failed) {
    const match = base?.failed?.find((b) => JSON.stringify(checkIdentity(b)) === JSON.stringify(checkIdentity(failure)));
    const known = failure.completeEvidence && failure.diagnostics?.length;
    const sameCheck = (base?.records ?? []).flatMap((r) => r.observations).filter((o) => JSON.stringify(checkIdentity(o)) === JSON.stringify(checkIdentity(failure)));
    const baseGreen = base?.headSha === baseSha && sameCheck.length > 0 && sameCheck.every((o) => o.state === "success");
    const baseKnown = base?.headSha === baseSha && match?.completeEvidence && match.diagnostics?.length;
    const baseSignatures = new Set(match?.diagnostics?.map((d) => d.signature) ?? []);
    failure.attribution = baseGreen ? "pr-specific" : known && baseKnown ? failure.diagnostics.every((d) => baseSignatures.has(d.signature))
      ? "shared-main" : "pr-specific" : "unknown";
    failure.sharedMain = failure.attribution === "shared-main";
    failure.baseSha = baseSha;
    failure.signature = known ? diagnosticHash(failure.diagnostics.map((d) => d.signature).sort()) : null;
    failure.diagnostics = (failure.diagnostics ?? []).map((d) => ({ ...d, sharedMain: Boolean(baseKnown && base.state === "failure" && baseSignatures.has(d.signature)) }));
  }
  return next;
}

const short = (value, limit) => Buffer.from(String(value ?? "")).subarray(0, limit).toString("utf8");
export function failureContext(facts, prNumber = null) {
  if (!facts.main?.checks) return undefined;
  const pr = facts.prs?.find((p) => p.number === prNumber);
  const summarize = (checks) => (checks?.failed ?? []).slice(0, 8).map((f) => ({
    kind: f.kind, id: String(f.id), name: short(f.name, 256), appId: f.appId ?? null,
    attribution: f.attribution ?? "unknown", summary: short(f.summary, 512), url: short(f.url, 512),
    diagnosticReason: short(f.diagnosticReason, 256), diagnosticsOmitted: Math.max(0, (f.diagnostics?.length ?? 0) - 2),
    diagnostics: (f.diagnostics ?? []).slice(0, 2).map((d) => ({ signature: d.signature, kind: d.kind, path: short(d.path, 160),
      name: short(d.name, 160), message: short(d.message, 256), sharedMain: Boolean(d.sharedMain) })),
    evidence: (f.evidence ?? []).slice(0, 1),
  }));
  const value = { baseSha: pr?.baseSha ?? facts.main.sha, headSha: pr?.headSha ?? null,
    main: { sha: facts.main.sha, state: facts.main.checks.state, failures: summarize(facts.main.checks), repairIssue: facts.main.repairIssue ?? null },
    pr: pr ? { number: pr.number, state: pr.checks?.state ?? "pending", failures: summarize(pr.checks) } : null,
    repairBase: facts.main.repairWork ? facts.repairSpec?.baseSha ?? null : null,
    repairFailures: facts.main.repairWork && facts.repairSpec?.baseSha !== facts.main.sha ? summarize(facts.repairBaseline?.checks).slice(0, 4) : [] };
  const sections = [value.main, value.pr].filter(Boolean);
  for (const section of sections) section.failuresOmitted = 0;
  while (Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) {
    const section = sections.toSorted((a, b) => b.failures.length - a.failures.length)[0];
    if (section.failures.length > 1) { section.failures.pop(); section.failuresOmitted++; }
    else if (value.repairFailures.length) value.repairFailures.pop();
    else throw new Error("Failure context exceeds its bound");
  }
  return value;
}

export function validFailureContext(value, op) {
  if (value === undefined) return true;
  try {
    return value && typeof value === "object" && Buffer.byteLength(JSON.stringify(value)) <= 48 * 1024
      && value.baseSha === op.base.sha && value.headSha === op.target.head && /^[a-f0-9]{40}$/.test(value.main?.sha)
      && ["success", "failure", "pending"].includes(value.main.state)
      && (value.repairBase === null || /^[a-f0-9]{40}$/.test(value.repairBase))
      && Array.isArray(value.main.failures) && value.main.failures.length <= 8
      && (value.pr === null ? op.target.number === null : value.pr?.number === op.target.number
        && ["success", "failure", "pending"].includes(value.pr.state) && Array.isArray(value.pr.failures) && value.pr.failures.length <= 8);
  } catch { return false; }
}
