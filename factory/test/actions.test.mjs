import { test } from "node:test";
import assert from "node:assert/strict";
import { zip } from "./archive-fixture.mjs";
import { createHash } from "node:crypto";
import { actionsClient, resultFiles, resultName } from "../lib/actions.mjs";
import { claimed, operation, proposal, A } from "./fixtures.mjs";

const op = operation(claimed()), context = { repositoryId: "42", defaultBranch: "main" };
function fixture({ run = {}, artifact = {}, data, listing = null, jobs = [] } = {}) {
  const bytes = data ?? zip([["proposal.json", JSON.stringify({ ...proposal, outcome: "no-change", effects: [] })]], { descriptor: true });
  const a = { id: 200, name: resultName(op), digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size_in_bytes: bytes.length, expired: false,
    workflow_run: { id: 100, repository_id: 42, head_repository_id: 42, head_sha: A, head_branch: "main" }, ...artifact };
  const requests = [];
  const json = (v) => new Response(JSON.stringify(v));
  const client = actionsClient({ token: "secret", repo: "ntodd/project", fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/attempts/1")) return json({ id: 100, run_attempt: 1, repository: { id: 42 }, head_repository: { id: 42 },
      path: ".github/workflows/factory.yml", head_sha: A, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "failure", ...run });
    if (url.includes("/artifacts?")) return json({ artifacts: listing ?? [a] });
    if (url.includes("/jobs?")) return json({ jobs });
    if (url.endsWith("/200/zip")) return new Response(null, { status: 302, headers: { location: "https://objects.example/result?signature=x" } });
    if (url.startsWith("https://objects.example/")) return new Response(bytes);
    throw new Error(`Unexpected request: ${url}`);
  } });
  return { client, requests, artifact: a };
}

test("a terminal failed run can supply its recorded artifact and redirects receive no GitHub credentials", async () => {
  const f = fixture();
  const result = await f.client.download(op, context);
  try {
    assert.equal(result.proposal.outcome, "no-change");
    assert.equal(result.artifact.run.attempt, 1);
    const redirected = f.requests.find((r) => r.url.startsWith("https://objects.example"));
    assert.equal(redirected.options.headers, undefined);
    assert.equal(redirected.options.redirect, "error");
  } finally { result.dispose(); }
});

test("Actions transport and incomplete JSON are read failures rather than invalid worker results", async () => {
  for (const fetch of [async () => { throw new Error("connection interrupted"); }, async () => new Response('{"id":')]) {
    const client = actionsClient({ token: "secret", repo: "ntodd/project", fetch });
    await assert.rejects(client.inspect(op, context), (e) => e.code === "read-unavailable");
  }
  const client = actionsClient({ token: "secret", repo: "ntodd/project", fetch: async () => new Response(null, { status: 503 }) });
  await assert.rejects(client.inspect(op, context), (e) => e.status === 503 && e.code !== "invalid-result");
});

test("signed artifact transport failures stay retryable while size and digest violations remain invalid", async () => {
  const artifact = { id: "200", digest: `sha256:${"a".repeat(64)}` };
  for (const mode of ["fetch", "status", "stream", "size", "digest"]) {
    const client = actionsClient({ token: "secret", repo: "ntodd/project", fetch: async (url, options) => {
      if (url.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: "https://objects.example/result" } });
      assert.equal(options.headers, undefined);
      if (mode === "fetch") throw new Error("connection interrupted");
      if (mode === "status") return new Response(null, { status: 503 });
      if (mode === "stream") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection interrupted")); } }));
      if (mode === "size") return new Response("", { headers: { "content-length": String(100 * 1024 * 1024) } });
      return new Response("wrong digest");
    } });
    await assert.rejects(client.downloadArchive(artifact), (e) => mode === "status" ? e.status === 503
      : e.code === (["size", "digest"].includes(mode) ? "invalid-result" : "read-unavailable"));
  }
});

test("foreign workflows, repository heads and rerun attempts cannot provide a result", async () => {
  for (const run of [{ path: ".github/workflows/ci.yml" }, { run_attempt: 2 }, { head_sha: "b".repeat(40) },
    { event: "pull_request" }, { head_repository: { id: 99 } }, { head_branch: "feature" }]) {
    await assert.rejects(() => fixture({ run }).client.inspect(op, context), /provenance/);
  }
  await assert.rejects(() => fixture({ artifact: { workflow_run: { id: 999 } } }).client.inspect(op, context), /metadata/);
});

test("historical owner and artifact provenance use the recorded default branch after a repository switch", async () => {
  const latest = { ...context, defaultBranch: "release" }, f = fixture();
  assert.equal((await f.client.inspect(op, latest)).owner.status, "completed");
  const result = await f.client.download(op, latest);
  try { assert.equal(result.proposal.outcome, "no-change"); } finally { result.dispose(); }
  f.artifact.workflow_run.head_branch = "release";
  await assert.rejects(f.client.inspect(op, latest), /metadata/);
  const wrong = fixture({ run: { head_branch: "release" }, artifact: { workflow_run: { id: 100, repository_id: 42,
    head_repository_id: 42, head_sha: A, head_branch: "release" } } });
  await assert.rejects(wrong.client.inspect(op, latest), /provenance/);
});

test("queued runs are uninspected, missing results are observed absent, and expired results are not accepted", async () => {
  const queued = fixture({ run: { status: "queued" } });
  assert.equal((await queued.client.inspect(op, context)).inspected, false);
  assert.equal(queued.requests.length, 1);
  assert.equal((await fixture({ listing: [] }).client.inspect(op, context)).available, false);
  const expired = fixture({ artifact: { expired: true } });
  assert.equal((await expired.client.inspect(op, context)).expired, true);
  await assert.rejects(() => expired.client.download(op, context), /unavailable/);
});

test("an in-progress workflow retains queued ownership until its actual Crew job starts", async () => {
  const queued = fixture({ run: { status: "in_progress" }, jobs: [{ name: "factory / factory-worker", status: "queued", started_at: null }] });
  assert.equal((await queued.client.inspect(op, context)).owner.status, "queued");
  assert.ok(queued.requests.some((r) => r.url.includes("/attempts/1/jobs")));
  const running = fixture({ run: { status: "in_progress" }, jobs: [{ name: "factory-worker", status: "in_progress", started_at: "2026-11-12T12:05:00Z" }] });
  assert.equal((await running.client.inspect(op, context)).owner.status, "in_progress");
  assert.equal((await running.client.inspect(op, context)).owner.startedAt, "2026-11-12T12:05:00Z");
  const sentinel = fixture({ run: { status: "in_progress" }, jobs: [{ name: "factory-worker", status: "queued", started_at: "2026-11-12T12:00:00Z" }] });
  assert.equal((await sentinel.client.inspect(op, context)).owner.status, "queued");
});

const job = { id: 321, name: "factory / factory-worker", run_id: 100, run_attempt: 1, head_sha: A, status: "completed",
  conclusion: "failure", runner_id: 123, runner_name: "crew", labels: ["self-hosted", "crew-l"], steps: [],
  started_at: "2026-11-12T12:01:00Z", completed_at: "2026-11-12T12:03:00Z" };

test("execution measurements use the owned job's elapsed time even when its artifact is absent", async () => {
  const f = fixture({ jobs: [job], listing: [] });
  const usage = await f.client.measure(op, context);
  assert.equal(usage.durationMs, 120000);
  assert.equal(usage.jobId, "321");
  assert.equal(usage.ran, true);
  assert.equal(f.requests.some((r) => r.url.includes("/artifacts")), false);
  assert.equal(await fixture({ run: { status: "in_progress" } }).client.measure(op, context), null);
});

test("historical execution accounting survives a default-branch switch without accepting a replacement branch", async () => {
  const latest = { ...context, defaultBranch: "release" };
  assert.equal((await fixture({ jobs: [job] }).client.measure(op, latest)).durationMs, 120000);
  await assert.rejects(fixture({ jobs: [job], run: { head_branch: "release" } }).client.measure(op, latest), /provenance/);
});

test("missing jobs, ambiguous roles, wrong attempts/runners and incomplete timestamps stay unknown", async () => {
  for (const jobs of [[], [job, { ...job, id: 322 }], ...[
    { run_id: 999 }, { run_attempt: 2 }, { head_sha: "b".repeat(40) }, { labels: ["crew-s"] },
    { status: "in_progress" }, { completed_at: null }, { started_at: "2026-11-13T00:00:00Z" }, { runner_id: 0 },
  ].map((patch) => [{ ...job, ...patch }])]) await assert.rejects(() => fixture({ jobs }).client.measure(op, context));
});

test("cancelled queued jobs count zero only with explicit absence of runner execution", async () => {
  const queued = { ...job, conclusion: "cancelled", runner_id: 0, runner_name: null, steps: [],
    started_at: "2026-11-12T12:01:00Z", completed_at: "2026-11-12T12:03:00Z" };
  const usage = await fixture({ jobs: [queued] }).client.measure(op, context);
  assert.equal(usage.durationMs, 0);
  assert.equal(usage.startedAt, null);
  assert.equal(usage.ran, false);
  await assert.rejects(() => fixture({ jobs: [{ ...queued, steps: [{ started_at: queued.started_at }] }] }).client.measure(op, context));
});

test("a replaced artifact or archive digest mismatch prevents use", async () => {
  await assert.rejects(() => fixture().client.download(op, context, { id: "201", digest: "sha256:bad" }), /substituted/);
  await assert.rejects(() => fixture({ artifact: { digest: `sha256:${"e".repeat(64)}` } }).client.download(op, context), /digest/);
});

test("screenshot archives require manifest, content and digest agreement after provenance checks", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=", "base64");
  const hash = createHash("sha256").update(png).digest("hex"), file = `screenshot-${hash}.png`;
  const manifest = [{ file, paths: ["./screenshots/phone.png"], digest: `sha256:${hash}`, size: png.length, contentType: "image/png" }];
  const document = { ...proposal, outcome: "no-change", effects: [], attachments: manifest };
  const pack = JSON.stringify([{ file, base64: png.toString("base64") }]);
  const good = fixture({ data: zip([["proposal.json", JSON.stringify(document)], ["screenshots.json", pack]]) });
  const result = await good.client.download(op, context);
  try { assert.deepEqual(result.proposal.attachments, manifest); assert.deepEqual(result.attachmentFiles.get(file), png); }
  finally { result.dispose(); }
  for (const entries of [
    [["proposal.json", JSON.stringify(document)]],
    [["proposal.json", JSON.stringify(document)], ["screenshots.json", JSON.stringify([{ file, base64: Buffer.concat([png, Buffer.from("changed")]).toString("base64") }])]],
    [["proposal.json", JSON.stringify({ ...document, attachments: [] })], ["screenshots.json", pack]],
    [["proposal.json", JSON.stringify(document)], ["screenshots.json", pack, 0o120777]],
  ]) await assert.rejects(fixture({ data: zip(entries) }).client.download(op, context), (e) => e.code === "invalid-result");
});

test("ZIP handling accepts flat streamed results and rejects traversal, symlinks, duplicates and oversized inflate", () => {
  const good = zip([["proposal.json", "{}"], ["proposal.bundle", "bundle"]], { descriptor: true });
  assert.equal(resultFiles(good).get("proposal.bundle").toString(), "bundle");
  for (const entries of [ [["../proposal.json", "{}"]], [["proposal.json", "{}", 0o120777]],
    [["proposal.json", "{}"], ["proposal.json", "{}"]], [["proposal.json", "{}"], ["extra.sh", "code"]] ]) {
    assert.throws(() => resultFiles(zip(entries)));
  }
  assert.throws(() => resultFiles(zip([["proposal.json", "x".repeat(1024 * 1024 + 1)]])));
  const broken = Buffer.from(good); broken[40] ^= 1;
  assert.throws(() => resultFiles(broken));
});
