import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { attachmentUploader, renderAttachments } from "../lib/attachments.mjs";
import { admit, emptyLedger, validateLedger } from "../lib/protocol.mjs";
import { publishOperation } from "../lib/publish.mjs";
import { publisherWriter } from "../lib/writer.mjs";
import { cleanPublisher } from "../lib/publisher.mjs";
import { decideItem } from "../lib/reconcile.mjs";
import { parseConfig } from "../lib/config.mjs";
import { step, reserve, revision, run, provenance, observation, artifact, operation, A, C, D, at } from "./fixtures.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=", "base64");
const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
const attachment = { file: `screenshot-${digest.slice(7)}.png`, paths: ["./screenshots/ui.png"], digest, size: png.length, contentType: "image/png" };
const asset = "https://github.com/user-attachments/assets/12345678-abcd-1234-abcd-123456789abc";
function fixture() {
  let state = admit(emptyLedger("42"), { key: "issue:7", revision, evidence: { sourceId: "label:123" } }), head = null;
  const observed = () => ({ ...observation, head }), events = [], prs = [];
  state = step(state, reserve("op-1", { mode: "build", target: { number: null, branch: "factory/issue-7", head: null } }));
  state = step(state, { type: "claim", run, provenance, observation: observed() });
  state = step(state, { type: "owner-observed", run, status: "completed", conclusion: "success" });
  const proposal = { schemaVersion: 1, operationId: "op-1", run, outcome: "ready", attachments: [attachment],
    effects: [{ id: "push", type: "push", branch: "factory/issue-7", expectedHead: null, commit: C, baseSha: A }],
    pullRequest: { title: "Fix UI", body: "Issue: #7\n![Phone](./screenshots/ui.png)" } };
  const before = structuredClone(state);
  state = step(state, { type: "collect-result", artifact, proposal });
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const git = { validate: async () => {}, inspect: async () => head === C ? { outcome: "applied", evidence: { kind: "branch-head", commit: C } } : { outcome: "unknown" },
    apply: async () => { events.push("push"); head = C; return { outcome: "applied", evidence: { kind: "branch-head", commit: C } }; }, dispose() {} };
  const api = { pullsForBranch: async () => prs, createPull: async (body) => {
    events.push("pr"); const pr = { number: 21, state: "open", user: { login: "factory[bot]" },
      head: { ref: body.head, sha: C, repo: { full_name: "ntodd/project" } }, base: { ref: body.base }, body: body.body };
    prs.push(pr); return pr;
  } };
  const upload = { readBytes: async () => png, fetchImpl: async (url, options) => {
    events.push("attachment");
    assert.equal(operation(state).effects[1].status, "pending");
    assert.equal(operation(state).effects[1].requests.length, 1);
    assert.equal(new URL(url).origin, "https://uploads.github.com");
    assert.equal(new URL(url).searchParams.get("repository_id"), "42");
    assert.equal(options.headers.authorization, "Bearer attachment-secret");
    assert.equal(options.redirect, "error"); assert.deepEqual(options.body, png);
    return Response.json({ url: asset }, { status: 201 });
  } };
  const writer = publisherWriter({ git, api, read: {}, repo: "ntodd/project", appLogin: "factory[bot]",
    attachments: { validate: async (e) => attachmentUploader({ token: "attachment-secret", repositoryId: "42", ...upload }).validate(e),
      inspect: async () => ({ outcome: "unknown" }), apply: async (e) => attachmentUploader({ token: "attachment-secret", repositoryId: "42", ...upload }).apply(e) } });
  return { store, git, api, writer, upload, events, prs, proposal, before, observed, get state() { return state; }, set state(value) { state = value; },
    set head(value) { head = value; }, pass: (now = at) => publishOperation({ store, itemKey: "issue:7", operationId: "op-1", publisherRun: { id: "900", attempt: 1 },
      observe: async () => observed(), writer, now: () => now }) };
}

test("screenshots publish after the exact push and before App-authored PR prose", async () => {
  const f = fixture();
  assert.deepEqual(operation(f.state).effects.map((e) => e.type), ["push", "attachment", "pull-request"]);
  assert.equal((await f.pass()).status, "done");
  assert.deepEqual(f.events, ["push", "attachment", "pr"]);
  assert.ok(f.prs[0].body.includes(`![Phone](${asset})`)); assert.equal(f.prs[0].body.includes("./screenshots/"), false);
  assert.equal(operation(f.state).effects[1].receipt.digest, digest);
  assert.equal(operation(f.state).effects.every((e) => e.requests.length === 1), true);
  assert.equal(JSON.stringify(f.state).includes("attachment-secret"), false);
});

test("worker proposals cannot select foreign upload targets or invent unbound screenshots", () => {
  const f = fixture();
  for (const change of [
    (p) => { delete p.attachments; }, (p) => { p.attachments[0].repositoryId = "43"; },
    (p) => { p.attachments[0].file = "/etc/private-key.png"; }, (p) => { p.attachments[0].contentType = "image/svg+xml"; },
    (p) => { p.attachments[0].paths = ["./screenshots/other.png"]; },
    (p) => { p.effects = [{ ...p.attachments[0], type: "attachment", id: "forged" }]; },
  ]) {
    const proposal = structuredClone(f.proposal); change(proposal);
    assert.throws(() => step(f.before, { type: "collect-result", artifact, proposal }), (e) => e.code === "invalid-result");
  }
  const own = structuredClone(f.before); own.items["issue:7"].evidence.own = true;
  assert.throws(() => step(own, { type: "collect-result", artifact, proposal: f.proposal }), (e) => e.code === "invalid-result");
  const corrupt = structuredClone(f.state); operation(corrupt).effects[1].repositoryId = "43";
  assert.throws(() => validateLedger(corrupt), (e) => e.code === "corrupt");
  const unreferenced = structuredClone(f.proposal); unreferenced.pullRequest.body = "Issue: #7";
  assert.deepEqual(operation(step(f.before, { type: "collect-result", artifact, proposal: unreferenced })).effects.map((e) => e.type), ["push", "pull-request"]);
});

test("a lost screenshot upload response waits and escalates without uploading again", async () => {
  const f = fixture(); let uploads = 0;
  f.upload.fetchImpl = async () => { uploads++; throw new Error("Response lost after upload"); };
  assert.equal((await f.pass()).status, "waiting"); assert.equal((await f.pass()).status, "waiting");
  const plan = decideItem(f.state, "issue:7", { authorization: observation.authorization, issueState: "open", prs: [] }, parseConfig("trusted-users: [ntodd]"), { now: "2026-11-12T12:16:00Z" });
  for (const event of plan.events) f.state = step(f.state, event);
  assert.equal(f.state.items["issue:7"].question.kind, "publish-outcome");
  assert.equal(f.state.items["issue:7"].question.recovery.effect, operation(f.state).effects[1].id);
  f.state = step(f.state, { type: "stop" });
  assert.equal((await f.pass("2026-11-12T12:17:00Z")).status, "waiting");
  assert.equal(uploads, 1); assert.equal(f.prs.length, 0); assert.equal(operation(f.state).effects[1].status, "pending");
});

test("an explicit upload rejection has a bounded new request after backoff", async () => {
  const f = fixture(); let uploads = 0;
  f.upload.fetchImpl = async () => ++uploads === 1 ? new Response(null, { status: 413 }) : Response.json({ url: asset }, { status: 201 });
  assert.equal((await f.pass()).status, "waiting"); assert.equal((await f.pass()).status, "waiting");
  assert.equal(uploads, 1);
  assert.equal((await f.pass("2026-11-12T12:02:00Z")).status, "done");
  assert.equal(uploads, 2); assert.equal(operation(f.state).effects[1].requests.length, 2);
  assert.equal(operation(f.state).effects[1].lastRejection.status, 413);
});

test("a lost PR response recovers without its expired image artifact or another upload", async () => {
  const f = fixture(), create = f.api.createPull;
  f.api.createPull = async (...args) => { await create(...args); throw new Error("PR response lost"); };
  assert.equal((await f.pass()).status, "waiting");
  f.upload.readBytes = async () => assert.fail("Recovery must not read an expired artifact");
  f.upload.fetchImpl = async () => assert.fail("An applied image must not upload twice");
  assert.equal((await f.pass()).status, "done");
  assert.deepEqual(f.events, ["push", "attachment", "pr"]);
});

test("changed heads and stop fence new screenshot and PR writes while preserving receipts", async () => {
  const changed = fixture(), push = changed.git.apply;
  changed.git.apply = async (...args) => { const receipt = await push(...args); changed.head = D; return receipt; };
  assert.equal((await changed.pass()).status, "superseded"); assert.deepEqual(changed.events, ["push"]);
  const stopped = fixture(), upload = stopped.upload.fetchImpl;
  stopped.upload.fetchImpl = async (...args) => { const response = await upload(...args); stopped.state = step(stopped.state, { type: "stop" }); return response; };
  assert.equal((await stopped.pass()).status, "superseded"); assert.deepEqual(stopped.events, ["push", "attachment"]);
  assert.equal(operation(stopped.state).effects[1].receipt.url, asset);
});

test("image requests require prior effects and exact repository/digest/URL receipts", async () => {
  const f = fixture(); f.state = step(f.state, { type: "authorize-publish", observation: f.observed() });
  const image = operation(f.state).effects[1], pr = operation(f.state).effects[2];
  for (const effectId of [image.id, pr.id]) assert.throws(() => step(f.state, { type: "request-effect", effectId, observation: { ...observation, head: C } }), (e) => e.code === "pending");
  f.upload.fetchImpl = async () => { throw new Error("lost"); }; await f.pass();
  const requestId = operation(f.state).effects[1].requests[0].id;
  for (const change of [{ repositoryId: "43" }, { digest: `sha256:${"0".repeat(64)}` }, { url: "https://attacker.example/image.png" }, { size: 1 }]) {
    assert.throws(() => step(f.state, { type: "effect-observed", effectId: image.id, requestId, outcome: "applied",
      evidence: { kind: "attachment", repositoryId: "42", digest, size: png.length, url: asset, ...change } }), (e) => e.code === "unknown");
  }
});

test("unusable credentials, a foreign host and changed bytes cannot reach the upload endpoint", async () => {
  const f = fixture(), effect = operation(f.state).effects[1]; let calls = 0;
  for (const extra of [{ token: "" }, { serverUrl: "https://ghe.example" }, { repositoryId: "43" }, { readBytes: async () => Buffer.from("changed") }]) {
    const uploader = attachmentUploader({ token: "attachment-secret", repositoryId: "42", readBytes: async () => png,
      fetchImpl: async () => { calls++; assert.fail(); }, ...extra });
    await assert.rejects(uploader.validate(effect));
  }
  assert.equal(calls, 0);
  assert.throws(() => renderAttachments("![Phone](./screenshots/ui.png)", operation(f.state)));
});

test("unverifiable upload responses remain unknown and rendered prose stays bounded", async () => {
  const f = fixture(), effect = operation(f.state).effects[1];
  for (const response of [new Response(null, { status: 503 }), new Response("invalid JSON", { status: 201 }),
    Response.json({ url: "https://attacker.example/image.png" }, { status: 201 }), new Response("x".repeat(16385), { status: 201 })]) {
    const uploader = attachmentUploader({ token: "attachment-secret", repositoryId: "42", readBytes: async () => png, fetchImpl: async () => response });
    assert.equal((await uploader.apply(effect)).outcome, "unknown");
  }
  await f.pass();
  assert.throws(() => renderAttachments("![Phone](./screenshots/ui.png)".repeat(2000), operation(f.state)), /published text limit/);
});

test("the real clean publisher loads accepted image bytes and requires its separate credential before pushing", async () => {
  const f = fixture(); let downloads = 0;
  const api = { repository: async () => ({ id: 42, default_branch: "main" }), fileAt: async () => ({ content: "trusted-users: [ntodd]" }),
    branchSha: async (branch) => {
      if (branch === "main") return A;
      if (!f.observed().head) throw Object.assign(new Error("missing"), { status: 404 });
      return f.observed().head;
    }, issue: async () => ({ number: 7, title: "Fix it", body: "Accepted task", state: "open", user: { login: "ntodd" }, labels: [{ name: "agent-ready" }] }),
    editors: async () => [], events: async () => [{ id: 123, event: "labeled", created_at: at, actor: { login: "ntodd" }, label: { name: "agent-ready" } }],
    comments: async () => [], reviews: async () => [], threads: async () => [] };
  const args = { api, write: f.api, store: f.store, repo: "ntodd/project", appLogin: "factory[bot]", readToken: "read", writeToken: "App-write",
    actions: { inspect: async () => ({ available: true }), download: async (_op, _context, accepted) => {
      downloads++; assert.equal(accepted.id, artifact.id);
      return { bundleFile: "data-only-bundle", attachmentFiles: new Map([[attachment.file, png]]), dispose() {} };
    } }, gitWriter: (options) => { assert.equal(options.writeToken, "App-write"); assert.equal(options.attachmentToken, undefined); return f.git; }, attachmentFetch: f.upload.fetchImpl };
  const pass = { key: "issue:7", operationId: "op-1", context: { repositoryId: "42", defaultBranch: "main" }, run: { id: "900", attempt: 1 } };
  await assert.rejects(cleanPublisher(args)(pass), /AGENT_ATTACH_TOKEN/);
  assert.deepEqual(f.events, []); assert.equal(downloads, 0); assert.equal(operation(f.state).effects[0].requests.length, 0);
  await assert.rejects(cleanPublisher({ ...args, attachmentToken: "invalid\ntoken" })(pass), /AGENT_ATTACH_TOKEN/);
  assert.deepEqual(f.events, []); assert.equal(downloads, 0); assert.equal(operation(f.state).effects[0].requests.length, 0);
  assert.equal((await cleanPublisher({ ...args, attachmentToken: "attachment-secret" })(pass)).status, "done");
  assert.equal(downloads, 1); assert.deepEqual(f.events, ["push", "attachment", "pr"]);
});
