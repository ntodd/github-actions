import { test } from "node:test";
import assert from "node:assert/strict";
import { readClient } from "../lib/github.mjs";
import { writeClient } from "../lib/github-write.mjs";
import { actionsClient } from "../lib/actions.mjs";
import { githubData } from "../lib/store.mjs";

test("API adapters expose rate-limit diagnostics without echoing response bodies or retrying", async () => {
  const readers = [
    (fetch) => readClient({ token: "secret", repo: "ntodd/project", fetch }).repository(),
    (fetch) => writeClient({ token: "secret", repo: "ntodd/project", fetch }).comments(7),
    (fetch) => actionsClient({ token: "secret", repo: "ntodd/project", fetch }).dispatched({ base: { ref: "main" },
      dispatch: { attempts: [{ run: { id: "100", attempt: 1 } }] } }, { repositoryId: "42" }),
    (fetch) => githubData({ token: "secret", repo: "ntodd/project", fetch }).ref("main"),
  ];
  for (const read of readers) for (const secondary of [false, true]) {
    let calls = 0;
    await assert.rejects(read(async () => {
      calls++;
      return Response.json({ message: secondary ? "secondary rate limit; do-not-echo" : "do-not-echo" }, {
        status: secondary ? 429 : 403,
        headers: { "x-ratelimit-remaining": secondary ? "300" : "0", "x-ratelimit-reset": "2100000000", "retry-after": "120" },
      });
    }), (error) => {
      assert.match(error.message, secondary ? /secondary API rate limit/ : /API rate limit exhausted/);
      assert.match(error.message, /rate limit resets at/);
      assert.doesNotMatch(error.message, /do-not-echo|secret/);
      assert.equal(error.rateLimitReset, 2100000000); assert.equal(error.retryAfter, 120);
      return true;
    });
    assert.equal(calls, 1);
  }
});
