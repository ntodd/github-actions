import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { appJwt, installationToken } from "../lib/app-token.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());

test("appJwt is an RS256 JWT for the App, backdated a minute and good for nine", () => {
  const jwt = appJwt({ appId: 12345, privateKey, now: 1_700_000_000 });
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(decode(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(p), { iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "12345" });
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  assert.ok(ok);
});

test("installationToken finds the repo's installation and mints a token for that repo alone", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
    if (url.endsWith("/repos/ntodd/sandbox/installation")) return Response.json({ id: 99 });
    if (url.endsWith("/app/installations/99/access_tokens")) {
      return Response.json({ token: "ghs_x", expires_at: "2026-11-07T14:00:00Z" }, { status: 201 });
    }
    return new Response("nope", { status: 404 });
  };
  const res = await installationToken({
    appId: 1,
    privateKey,
    repo: "ntodd/sandbox",
    permissions: { contents: "write" },
    fetch,
  });
  assert.deepEqual(res, { token: "ghs_x", expiresAt: "2026-11-07T14:00:00Z" });
  assert.match(calls[0].auth, /^Bearer ey/);
  assert.deepEqual(calls[1].body, { repositories: ["sandbox"], permissions: { contents: "write" } });
  assert.equal(calls[1].method, "POST");
});

test("installationToken says to run enable.sh when the App isn't on the repo", async () => {
  const fetch = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  await assert.rejects(
    installationToken({ appId: 1, privateKey, repo: "ntodd/x", permissions: {}, fetch }),
    /isn't installed on ntodd\/x.*enable\.sh/,
  );
});

test("appSlug reads the App's slug with its JWT", async () => {
  const { appSlug } = await import("../lib/app-token.mjs");
  const fetch = async (url, init) => {
    assert.ok(url.endsWith("/app"));
    assert.match(init.headers.authorization, /^Bearer ey/);
    return Response.json({ slug: "ntodd-agent" });
  };
  assert.equal(await appSlug({ appId: 1, privateKey, fetch }), "ntodd-agent");
});
