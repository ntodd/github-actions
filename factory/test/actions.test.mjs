import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { actionsClient, resultFiles, resultName } from "../lib/actions.mjs";
import { claimed, operation, proposal, A } from "./fixtures.mjs";

function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries, { descriptor = false } = {}) {
  const local = [], central = []; let offset = 0;
  for (const [name, raw, mode = 0o100644] of entries) {
    const bytes = Buffer.from(raw), filename = Buffer.from(name), data = deflateRawSync(bytes), checksum = crc(bytes);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(descriptor ? 8 : 0, 6); h.writeUInt16LE(8, 8);
    if (!descriptor) { h.writeUInt32LE(checksum, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(bytes.length, 22); }
    h.writeUInt16LE(filename.length, 26);
    const d = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) { d.writeUInt32LE(0x08074b50); d.writeUInt32LE(checksum, 4); d.writeUInt32LE(data.length, 8); d.writeUInt32LE(bytes.length, 12); }
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(descriptor ? 8 : 0, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(checksum, 16); c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE((mode * 65536) >>> 0, 38); c.writeUInt32LE(offset, 42);
    local.push(h, filename, data, d); central.push(c, filename); offset += h.length + filename.length + data.length + d.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
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

test("foreign workflows, repository heads and rerun attempts cannot provide a result", async () => {
  for (const run of [{ path: ".github/workflows/ci.yml" }, { run_attempt: 2 }, { head_sha: "b".repeat(40) },
    { event: "pull_request" }, { head_repository: { id: 99 } }, { head_branch: "feature" }]) {
    await assert.rejects(() => fixture({ run }).client.inspect(op, context), /provenance/);
  }
  await assert.rejects(() => fixture({ artifact: { workflow_run: { id: 999 } } }).client.inspect(op, context), /metadata/);
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
