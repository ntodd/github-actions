import { diagnosticHash, parseFailureLog, parseFailureAnnotations } from "./failure-report.mjs";
const positive = (v) => typeof v === "string" && /^[1-9]\d{0,39}$/.test(v) || Number.isSafeInteger(v) && v > 0;

async function evidenceForCheck(api, raw, context, scope) {
  if (raw.app?.slug === "github-actions" && api.job && api.stepLog) {
    const url = new URL(raw.details_url), server = new URL(context.serverUrl
      ?? (api.apiUrl?.endsWith("/api/v3") ? new URL(api.apiUrl).origin : "https://github.com"));
    const path = `/${context.repo}/actions/runs/`, parts = url.pathname.startsWith(path) ? url.pathname.slice(path.length).split("/") : [];
    if (url.origin !== server.origin || parts.length !== 3 || parts[1] !== "job" || !positive(parts[0]) || !positive(parts[2])) throw new Error("The check has no bound Actions job");
    const [runId, , jobId] = parts, job = await api.job(jobId), run = await api.run(runId);
    const expected = `${api.apiUrl ?? "https://api.github.com"}/repos/${context.repo}/check-runs/${raw.id}`;
    if (String(job.id) !== jobId || String(job.run_id) !== runId || job.check_run_url !== expected || job.head_sha !== raw.head_sha
      || job.name !== raw.name || job.status !== "completed" || job.conclusion !== "failure"
      || !Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1 || String(run.id) !== runId || run.run_attempt !== job.run_attempt
      || String(run.repository?.id) !== context.repositoryId || String(run.head_repository?.id) !== context.repositoryId
      || (scope === "base" ? run.head_sha !== raw.head_sha || run.head_branch !== context.defaultBranch
        : ![raw.head_sha, context.headSha].includes(run.head_sha))) throw new Error("Diagnostic job provenance does not match its check and commits");
    const failed = job.steps?.filter((s) => s.conclusion === "failure");
    if (!failed?.length || failed.length > 4 || failed.some((s) => s.status !== "completed" || !Number.isSafeInteger(s.number) || s.number < 1)) throw new Error("The failed job steps are incomplete or exceed the diagnostic budget");
    const diagnostics = [], evidence = []; let complete = true;
    for (const step of failed) {
      const log = await api.stepLog(jobId, step.number), report = parseFailureLog(log);
      complete &&= report.complete;
      diagnostics.push(...report.diagnostics);
      evidence.push({ source: "step-log", run: runId, attempt: job.run_attempt, job: jobId, step: step.number, digest: diagnosticHash(log), sha: raw.head_sha });
    }
    if (diagnostics.length > 100) complete = false;
    return { diagnostics: diagnostics.slice(0, 100), completeEvidence: complete && diagnostics.length > 0, evidence,
      diagnosticReason: complete ? null : "A failed step has unclassified diagnostics" };
  }
  if (api.annotations && raw.output?.annotations_count > 0) {
    const annotations = await api.annotations(String(raw.id)), report = parseFailureAnnotations(annotations, raw.output.annotations_count);
    return { diagnostics: report.diagnostics, completeEvidence: report.complete,
      evidence: [{ source: "annotations", check: String(raw.id), digest: diagnosticHash(annotations), sha: raw.head_sha }], diagnosticReason: report.reason };
  }
  const output = [raw.output?.summary, raw.output?.text].filter(Boolean).join("\n"), report = parseFailureLog(output);
  return { diagnostics: report.diagnostics, completeEvidence: report.complete,
    evidence: [{ source: "check-output", check: String(raw.id), digest: diagnosticHash(output), sha: raw.head_sha }], diagnosticReason: report.reason };
}

export async function diagnoseChecks(api, checks, raw, context, scope = "pr") {
  const next = structuredClone(checks);
  for (let i = 0; i < next.failed.length; i++) {
    const failure = next.failed[i], source = raw.checkRuns.find((c) => String(c.id) === String(failure.id) && c.head_sha === raw.sha);
    if (i >= 8 || failure.kind !== "check" || !source) {
      Object.assign(failure, { completeEvidence: false, diagnostics: [], evidence: [], diagnosticReason: "Failure evidence is unavailable or exceeds the diagnostic budget" });
      continue;
    }
    try { Object.assign(failure, await evidenceForCheck(api, source, context, scope)); }
    catch (error) { Object.assign(failure, { completeEvidence: false, diagnostics: [], evidence: [], diagnosticReason: String(error.message).slice(0, 500) }); }
  }
  if (next.failed.some((f) => f.completeEvidence)) {
    try {
      const current = await api.checks(raw.sha);
      for (const failure of next.failed.filter((f) => f.completeEvidence)) {
        const source = raw.checkRuns.find((c) => String(c.id) === String(failure.id));
        const latest = current.checkRuns.filter((c) => c.head_sha === raw.sha && c.name === source.name && c.app?.id === source.app?.id)
          .sort((a, b) => String(b.started_at ?? b.completed_at ?? "").localeCompare(String(a.started_at ?? a.completed_at ?? ""))
            || (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0))[0];
        if (!latest || String(latest.id) !== String(source.id)
          || diagnosticHash([latest.status, latest.conclusion, latest.output]) !== diagnosticHash([source.status, source.conclusion, source.output])) {
          next.state = "pending"; failure.completeEvidence = false; failure.diagnosticReason = "The check changed while diagnostics were read";
        }
      }
    } catch {
      next.state = "pending";
      for (const failure of next.failed) { failure.completeEvidence = false; failure.diagnosticReason = "The check could not be reobserved after diagnosis"; }
    }
  }
  return next;
}
