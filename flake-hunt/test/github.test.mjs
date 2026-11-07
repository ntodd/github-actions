import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "../lib/github.mjs";

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const route = routes.find((r) => r.method === method && r.match.test(url));
    if (!route) return new Response(JSON.stringify({ message: "no route" }), { status: 500 });
    const { status = 200, body = {} } = typeof route.reply === "function" ? route.reply(url) : route.reply;
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const make = (routes) => {
  const f = fakeFetch(routes);
  return { gh: client({ token: "t0k", repo: "ntodd/crew", apiUrl: "https://api.test", fetch: f.fetch }), calls: f.calls };
};

test("listIssues pages through every issue with the label and drops pull requests", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: "open", body: "" }));
  page1[3].pull_request = {};
  const { gh, calls } = make([
    {
      method: "GET",
      match: /\/repos\/ntodd\/crew\/issues\?/,
      reply: (url) => ({ body: new URL(url).searchParams.get("page") === "1" ? page1 : [{ number: 101, state: "closed" }] }),
    },
  ]);

  const issues = await gh.listIssues("flaky-test");

  assert.equal(issues.length, 100);
  assert.ok(!issues.some((i) => i.number === 4));
  assert.equal(calls.length, 2);
  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get("labels"), "flaky-test");
  assert.equal(params.get("state"), "all");
  assert.equal(params.get("per_page"), "100");
  assert.equal(calls[0].headers.authorization, "Bearer t0k");
});

test("ensureLabel creates the label only when it is missing", async () => {
  const missing = make([
    { method: "GET", match: /\/labels\/flaky-test$/, reply: { status: 404, body: { message: "Not Found" } } },
    { method: "POST", match: /\/labels$/, reply: { status: 201, body: {} } },
  ]);
  await missing.gh.ensureLabel("flaky-test");
  assert.equal(missing.calls.at(-1).method, "POST");
  assert.equal(missing.calls.at(-1).body.name, "flaky-test");

  const present = make([{ method: "GET", match: /\/labels\/flaky-test$/, reply: { body: { name: "flaky-test" } } }]);
  await present.gh.ensureLabel("flaky-test");
  assert.equal(present.calls.length, 1);
});

test("ensureLabel tolerates a label another job created first", async () => {
  const { gh } = make([
    { method: "GET", match: /\/labels\/flaky-test$/, reply: { status: 404, body: {} } },
    { method: "POST", match: /\/labels$/, reply: { status: 422, body: { errors: [{ code: "already_exists" }] } } },
  ]);
  await gh.ensureLabel("flaky-test");
});

test("createIssue, comment and reopen send the right requests", async () => {
  const { gh, calls } = make([
    { method: "POST", match: /\/issues$/, reply: { status: 201, body: { number: 9 } } },
    { method: "POST", match: /\/issues\/9\/comments$/, reply: { status: 201, body: {} } },
    { method: "PATCH", match: /\/issues\/9$/, reply: { body: {} } },
  ]);

  assert.equal((await gh.createIssue({ title: "T", body: "B", labels: ["flaky-test"] })).number, 9);
  await gh.comment(9, "C");
  await gh.reopen(9);

  assert.deepEqual(
    calls.map((c) => [c.method, new URL(c.url).pathname, c.body]),
    [
      ["POST", "/repos/ntodd/crew/issues", { title: "T", body: "B", labels: ["flaky-test"] }],
      ["POST", "/repos/ntodd/crew/issues/9/comments", { body: "C" }],
      ["PATCH", "/repos/ntodd/crew/issues/9", { state: "open" }],
    ],
  );
});

test("errors carry the status and GitHub's message", async () => {
  const { gh } = make([{ method: "POST", match: /\/issues$/, reply: { status: 403, body: { message: "Resource not accessible by integration" } } }]);
  await assert.rejects(gh.createIssue({ title: "T", body: "B", labels: [] }), /403.*Resource not accessible/);
});

test("defaultBranch reads the repository", async () => {
  const { gh } = make([{ method: "GET", match: /\/repos\/ntodd\/crew$/, reply: { body: { default_branch: "main" } } }]);
  assert.equal(await gh.defaultBranch(), "main");
});
