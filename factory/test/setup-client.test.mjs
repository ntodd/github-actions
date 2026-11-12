import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { setupClient, inspectSetupApp } from "../lib/setup-client.mjs";

test("setup secret encryption uses gh stdin, with no secret or administrator token in command arguments", async () => {
  const calls = [], client = setupClient({ token: "administrator-token", repo: "ntodd/project", gh: async (args, input) => calls.push({ args, input }) });
  await client.setSecret("OPENAI_API_KEY", "model-credential");
  assert.deepEqual(calls[0].args, ["secret", "set", "OPENAI_API_KEY", "--repo", "ntodd/project"]);
  assert.equal(calls[0].input, "model-credential");
  assert.equal(JSON.stringify(calls[0].args).includes("credential"), false);
  await assert.rejects(client.setSecret("UNRELATED_SECRET", "value"));
});

test("setup reads complete check pagination and rejects credential-bearing pagination outside its repository", async () => {
  const calls = [];
  const client = setupClient({ token: "administrator-token", repo: "ntodd/project", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const page = calls.length;
    return new Response(JSON.stringify({ check_runs: [{ id: page }] }), { headers: page === 1
      ? { link: '<https://api.github.com/repos/ntodd/project/commits/abc/check-runs?page=2>; rel="next"' } : {} });
  } });
  assert.deepEqual((await client.checks("abc")).check_runs.map((c) => c.id), [1, 2]);
  assert.equal(calls.every((c) => c.options.redirect === "error"), true);
  let requests = 0;
  const hostile = setupClient({ token: "administrator-token", repo: "ntodd/project", fetchImpl: async () => {
    requests++; return new Response("[]", { headers: { link: '<https://api.github.com/repos/ntodd/project/../../other/labels>; rel="next"' } });
  } });
  await assert.rejects(hostile.labels(), /Unexpected setup API target/); assert.equal(requests, 1);
});

test("inspection setup reads exact attempts and paginates jobs and artifacts without writes", async () => {
  const calls = [], api = setupClient({ token: "administrator-token", repo: "ntodd/project", fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    const u = new URL(url), second = u.searchParams.get("page") === "2", name = u.pathname.endsWith("/jobs") ? "jobs" : "artifacts";
    if (u.pathname.endsWith("/attempts/2")) return Response.json({ id: 100, run_attempt: 2 });
    return Response.json({ [name]: [{ id: second ? 2 : 1 }] }, { headers: second ? {} : { link: `<${url}&page=2>; rel="next"` } });
  } });
  assert.deepEqual(await api.run("100", 2), { id: 100, run_attempt: 2 });
  assert.deepEqual(await api.jobs("100", 2), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await api.artifacts("100"), [{ id: 1 }, { id: 2 }]);
  assert.match(calls[1], /runs\/100\/attempts\/2\/jobs/); assert.equal(calls.length, 5);
  for (const action of [() => api.run("../other", 2), () => api.run("100", 0), () => api.jobs("100", NaN), () => api.artifacts("100/other")]) assert.throws(action);
  assert.equal(calls.length, 5);
});

test("App inspection validates the installation and returns only public metadata", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }), calls = [];
  const result = await inspectSetupApp({ appId: 123, privateKey: pem, repo: "ntodd/project", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith("/app") ? { id: 123, slug: "factory-app", permissions: { contents: "write" }, pem: "must-not-escape", client_secret: "must-not-escape" }
      : { id: 7, app_id: 123, permissions: { contents: "write" }, repository_selection: "selected", suspended_at: null, access_token: "must-not-escape" }));
  } });
  assert.equal(result.app.id, 123); assert.equal(result.installation.id, 7);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.equal(calls.every((c) => c.options.redirect === "error" && !c.options.body), true);
  await assert.rejects(inspectSetupApp({ appId: 123, privateKey: pem, repo: "ntodd/project", fetchImpl: async (url) => new Response(JSON.stringify(url.endsWith("/app")
    ? { id: 123 } : { id: 7, app_id: 999, permissions: {}, suspended_at: null })) }), /not actively installed/);
});
