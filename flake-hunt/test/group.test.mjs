import { test } from "node:test";
import assert from "node:assert/strict";
import { failureKeys, groupFlakes, normalizeFailure } from "../lib/group.mjs";

// Failure messages as the formatter writes them, for two tests in different
// files that hit the same rate-limit row, and two with failures of their own.
const rateLimited = (name, file, line, pid, ms) =>
  `  1) test ${name} (Demo.${name}Test)\n     ${file}:${line}\n     ** (DBConnection.ConnectionError) client #PID<0.${pid}.0> timed out because it queued and checked out the connection for longer than ${ms}ms\n     code: Demo.request(conn, "requester-${pid}@example.com")\n     stacktrace:\n       (db_connection 2.7.0) lib/db_connection.ex:1096: DBConnection.run/3\n       (demo 0.1.0) lib/demo/rate_limit.ex:42: Demo.RateLimit.hit/2\n       ${file}:${line + 3}: (test)\n`;
const flake = (name, file, line, messages) => ({
  key: `::Demo.${name}Test::test ${name}`,
  module: `Demo.${name}Test`,
  name: `test ${name}`,
  file,
  line,
  runs: 100,
  failures: messages.length,
  failedRuns: messages.map((message, i) => ({ seed: 100 + i, shard: 1, run: i + 1, message })),
});

const a = flake("a", "test/a_test.exs", 10, [rateLimited("a", "test/a_test.exs", 10, 412, 15000)]);
const b = flake("b", "test/b_test.exs", 30, [rateLimited("b", "test/b_test.exs", 30, 977, 15003)]);
const assertion = (name, file, line, left) =>
  `  1) test ${name} (Demo.${name}Test)\n     ${file}:${line}\n     Assertion with == failed\n     code:  assert Demo.count() == 2\n     left:  ${left}\n     right: 2\n     stacktrace:\n       ${file}:${line + 1}: (test)\n`;
const c = flake("c", "test/c_test.exs", 5, [assertion("c", "test/c_test.exs", 5, 3)]);
const d = flake("d", "test/d_test.exs", 8, [`  1) test d (Demo.dTest)\n     test/d_test.exs:8\n     ** (exit) exited in: GenServer.call(#PID<0.150.0>, :get, 10)\n         ** (EXIT) time out\n     stacktrace:\n       (elixir 1.20.4) lib/gen_server.ex:1183: GenServer.call/3\n       test/d_test.exs:9: (test)\n`]);

test("normalizeFailure drops the test's own header and strips what varies between runs", () => {
  const n = normalizeFailure(a.failedRuns[0].message);
  assert.doesNotMatch(n, /test a|a_test\.exs/);
  assert.doesNotMatch(n, /412|15000|requester-/);
  assert.match(n, /#PID<>/);
  assert.match(n, /<email>/);
  // Lines in the stacktrace are kept: they say where it was raised.
  assert.match(n, /lib\/demo\/rate_limit\.ex:42/);
});

test("the same failure in two tests gives them a key in common", () => {
  const shared = [...failureKeys(a)].filter((k) => failureKeys(b).has(k));
  assert.ok(shared.length > 0);
});

test("the same error from the same line outside the test is a key even when the rest differs", () => {
  const other = flake("e", "test/e_test.exs", 12, [rateLimited("e", "test/e_test.exs", 12, 5, 900).replace(/code: .*\n/, "code: Demo.other()\n")]);
  assert.ok([...failureKeys(other)].some((k) => failureKeys(a).has(k)));
  // A different line in the same file isn't the same place.
  const moved = flake("f", "test/f_test.exs", 12, [rateLimited("f", "test/f_test.exs", 12, 5, 900).replace("rate_limit.ex:42", "rate_limit.ex:57").replace(/code: .*\n/, "code: Demo.other()\n")]);
  assert.ok(![...failureKeys(moved)].some((k) => failureKeys(a).has(k)));
});

test("an error raised in the test body, or an assertion in it, is keyed by the whole failure only", () => {
  assert.equal(failureKeys(c).size, 1);
  assert.equal(failureKeys(d).size, 1);
  assert.equal(failureKeys(flake("g", "test/g_test.exs", 1, [""])).size, 0);
  assert.equal(failureKeys(flake("g", "test/g_test.exs", 1, ["setup_all failed"])).size, 0);
});

test("a setup that fails the same way groups the tests behind it", () => {
  const setup = (name, line) =>
    `  1) test ${name} (Demo.ApiTest)\n     test/api_test.exs:${line}\n     ** (RuntimeError) port 4012 in use\n     stacktrace:\n       test/api_test.exs:4: Demo.ApiTest.__ex_unit_setup_0/1\n       test/api_test.exs:1: Demo.ApiTest.__ex_unit__/2\n`;
  const groups = groupFlakes([flake("x", "test/api_test.exs", 10, [setup("x", 10)]), flake("y", "test/api_test.exs", 20, [setup("y", 20)])]);
  assert.deepEqual(groups, [[0, 1]]);
});

test("groupFlakes joins flakes that share any key, in their order, and leaves the rest alone", () => {
  // b fails two ways, and one of them is c's: so a, b and c are one group.
  const b2 = { ...b, failedRuns: [...b.failedRuns, { seed: 9, shard: 1, run: 9, message: assertion("b", "test/b_test.exs", 30, 3) }] };
  assert.deepEqual(groupFlakes([c, a, d, b2]), [[0, 1, 3], [2]]);
  assert.deepEqual(groupFlakes([a, c, d]), [[0], [1], [2]]);
  assert.deepEqual(groupFlakes([]), []);
});

test("the values an assertion compared keep their numbers, so 500 and 404 stay apart", () => {
  const status = (name, file, got) => flake(name, file, 4, [`  1) test ${name} (Demo.${name}Test)\n     ${file}:4\n     Assertion with == failed\n     code:  assert conn.status == 200\n     left:  ${got}\n     right: 200\n     stacktrace:\n       ${file}:5: (test)\n`]);
  assert.deepEqual(groupFlakes([status("p", "test/p_test.exs", 500), status("q", "test/q_test.exs", 404)]), [[0], [1]]);
  assert.deepEqual(groupFlakes([status("p", "test/p_test.exs", 500), status("q", "test/q_test.exs", 500)]), [[0, 1]]);
});

test("the same error from the same dependency frame stays apart when the rest of the message differs", () => {
  const response = (name, body) =>
    flake(name, `test/${name}_test.exs`, 4, [`  1) test ${name} (Demo.${name}Test)\n     test/${name}_test.exs:4\n     ** (RuntimeError) expected response with status 200, got: 500, with body:\n     ${body}\n     code: assert json_response(conn, 200)\n     stacktrace:\n       (phoenix 1.7.14) lib/phoenix/test/conn_test.ex:373: Phoenix.ConnTest.response/2\n       (phoenix 1.7.14) lib/phoenix/test/conn_test.ex:419: Phoenix.ConnTest.json_response/2\n       test/${name}_test.exs:6: (test)\n`]);
  assert.deepEqual(groupFlakes([response("p", '{"error":"db timeout"}'), response("q", '{"error":"invalid email"}')]), [[0], [1]]);
});
