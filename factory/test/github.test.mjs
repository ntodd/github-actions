import { test } from "node:test";
import assert from "node:assert/strict";
import { readClient } from "../lib/github.mjs";
const conn = (nodes, cursor = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });
function api(handler) {
  const calls = [];
  return { calls, client: readClient({ token: "secret", repo: "ntodd/repo", fetch: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    return handler(url, body, calls);
  } }) };
}

test("REST comment pagination reads all pages and refuses to forward credentials across origins", async () => {
  const { client, calls } = api((url) => url.endsWith("/graphql") ? Response.json({ data: { node: { lastEditedAt: null, userContentEdits: conn([]) } } })
    : url.includes("page=2") ? Response.json([{ id: 2, node_id: "IC_2" }])
      : Response.json([{ id: 1, node_id: "IC_1" }], { headers: { link: '<https://api.github.com/repos/ntodd/repo/issues/7/comments?page=2>; rel="next"' } }));
  assert.deepEqual(await client.comments(7), [1, 2].map((id) => ({ id, node_id: `IC_${id}`, lastEditedAt: null, editors: [] })));
  assert.equal(calls.length, 4);
  const unsafe = api(() => Response.json([], { headers: { link: '<https://evil.example/?token=x>; rel="next"' } }));
  await assert.rejects(unsafe.client.comments(7), /pagination/);
  assert.equal(unsafe.calls.length, 1);
});

test("edit history paginates both content edits and title changes with deleted actors denied", async () => {
  const { client, calls } = api((_url, body) => {
    const edits = body.query.includes("userContentEdits");
    const connection = edits
      ? body.variables.cursor ? conn([{ editor: null }]) : conn([{ editor: { login: "ntodd", __typename: "User" } }], "edits-2")
      : conn([{ actor: { login: "github-actions", __typename: "Bot" } }]);
    return Response.json({ data: { repository: { issue: { [edits ? "userContentEdits" : "timelineItems"]: connection } } } });
  });
  assert.deepEqual(await client.editors(7), ["ntodd", "ghost", "github-actions[bot]"]);
  assert.equal(calls.length, 3);
});

test("review thread and nested comment pagination preserve every reply", async () => {
  const { client, calls } = api((_url, body) => {
    if (body.query.includes("reviewThreads")) return Response.json({ data: { repository: { pullRequest: {
      reviewThreads: body.variables.cursor ? conn([{ id: "T2", isResolved: false }]) : conn([{ id: "T1", isResolved: false }], "threads-2"),
    } } } });
    const id = body.variables.id;
    const comments = id === "T1" && !body.variables.cursor
      ? conn([{ databaseId: 1, body: "first", author: { login: "ntodd", __typename: "User" }, lastEditedAt: null }], "comments-2")
      : conn([{ databaseId: id === "T1" ? 2 : 3, body: "reply", author: { login: "reviewer", __typename: "Bot" }, lastEditedAt: null }]);
    return Response.json({ data: { node: { comments } } });
  });
  const threads = await client.threads(9);
  assert.deepEqual(threads.map((t) => t.comments.map((c) => c.id)), [[1, 2], [3]]);
  assert.equal(threads[0].comments[1].author, "reviewer[bot]");
  assert.equal(calls.length, 5);
});

test("review bodies carry edit status, commit identity and every page", async () => {
  const { client } = api((_url, body) => Response.json({ data: { repository: { pullRequest: {
    reviews: body.variables.cursor ? conn([{ databaseId: 2, author: { login: "ntodd" }, lastEditedAt: null, commit: { oid: "b".repeat(40) } }])
      : conn([{ databaseId: 1, author: { login: "ntodd" }, lastEditedAt: null, commit: { oid: "a".repeat(40) } }], "next"),
  } } } }));
  const reviews = await client.reviews(9);
  assert.deepEqual(reviews.map((r) => r.id), [1, 2]);
  assert.equal(reviews[0].lastEditedAt, null);
  assert.equal(reviews[1].commitSha, "b".repeat(40));
});

test("incomplete or looping GraphQL responses cannot masquerade as a complete conversation", async () => {
  const looping = api(() => Response.json({ data: { repository: { pullRequest: { reviews: conn([], "same-cursor") } } } }));
  await assert.rejects(looping.client.reviews(9), /pagination/);
  const partial = api(() => Response.json({ data: { repository: {} }, errors: [{ message: "permission denied" }] }));
  await assert.rejects(partial.client.editors(7), /complete/);
});

test("config content reads require a commit and verify size; no mutating endpoints exist", async () => {
  const text = "trusted-users: [ntodd]", { client, calls } = api(() => Response.json({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), size: Buffer.byteLength(text) }));
  assert.equal((await client.fileAt(".github/factory.yml", "a".repeat(40))).content, text);
  assert.match(calls[0].url, /ref=aaaaaaaa/);
  await assert.rejects(client.fileAt(".github/factory.yml", "feature"), /pinned/);
  assert.equal(client.comment, undefined);
  assert.equal(client.merge, undefined);
});

test("edited comments include their fully paginated editor history", async () => {
  const { client } = api((url, body) => {
    if (url.includes("/comments")) return Response.json([{ id: 1, node_id: "IC_1", body: "edited", created_at: "before", updated_at: "after" }]);
    return Response.json({ data: { node: { lastEditedAt: "2026-11-12T12:00:00Z", userContentEdits: body.variables.cursor ? conn([{ editor: { login: "outsider", __typename: "User" } }])
      : conn([{ editor: { login: "ntodd", __typename: "User" } }], "next") } } });
  });
  assert.deepEqual((await client.comments(7))[0].editors, ["ntodd", "outsider"]);
});

test("same-second comment edits still fetch editor history", async () => {
  const at = "2026-11-12T12:00:00Z";
  const { client } = api((url) => url.includes("/comments")
    ? Response.json([{ id: 1, node_id: "IC_1", body: "/agent stop", user: { login: "ntodd" }, created_at: at, updated_at: at }])
    : Response.json({ data: { node: { lastEditedAt: at, userContentEdits: conn([{ editor: { login: "outsider", __typename: "User" } }]) } } }));
  const fact = (await client.comments(7))[0];
  assert.deepEqual(fact.editors, ["outsider"]);
  assert.equal(fact.lastEditedAt, at);
});

test("failed-step logs follow a signed redirect without forwarding any GitHub credentials", async () => {
  const { client, calls } = api((url) => url.startsWith("https://api.github.com/")
    ? new Response(null, { status: 302, headers: { location: "https://logs.example/step?signature=opaque" } })
    : new Response("specific diagnostic\n"));
  assert.equal(await client.stepLog("123", 10), "specific diagnostic\n");
  assert.equal(calls[0].url, "https://api.github.com/repos/ntodd/repo/actions/jobs/123/steps/10/logs");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[1].init.headers, undefined); assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[0].init.headers["x-github-api-version"], "2026-03-10");
});

test("diagnostic downloads reject unsafe redirects, excessive bodies and injected identities", async () => {
  for (const location of ["http://logs.example/file", "https://user:password@logs.example/file"]) {
    const f = api(() => new Response(null, { status: 302, headers: { location } }));
    await assert.rejects(f.client.stepLog("123", 10), /Invalid diagnostic/);
    assert.equal(f.calls.length, 1);
  }
  const large = api(() => new Response("x".repeat(1001)));
  await assert.rejects(large.client.stepLog("123", 10, 1000), /size limit/);
  const invalid = api(() => { throw new Error("No network expected"); });
  await assert.rejects(invalid.client.stepLog("../other", 10), /Invalid diagnostic/);
  await assert.rejects(invalid.client.stepLog("123", -1), /Invalid diagnostic/);
  await assert.rejects(invalid.client.job("../other"), /stable job/);
  assert.equal(invalid.calls.length, 0);
});

test("annotation evidence is fully paginated and bounded", async () => {
  const f = api((url) => url.includes("page=2") ? Response.json([{ path: "src/b.ts", annotation_level: "failure" }])
    : Response.json([{ path: "src/a.ts", annotation_level: "failure" }], { headers: {
      link: '<https://api.github.com/repos/ntodd/repo/check-runs/123/annotations?page=2>; rel="next"',
    } }));
  assert.equal((await f.client.annotations("123")).length, 2);
  const large = api(() => Response.json(Array.from({ length: 1001 }, () => ({ path: "src/a.ts" }))));
  await assert.rejects(large.client.annotations("123"), /item limit/);
});
