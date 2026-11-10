// Groups a hunt's flakes by likely cause, so one agent run works each
// cause. A flake is often many tests failing for one reason, and an issue
// per test with a run per issue makes the same fix many times over.
//
// Two flakes are in one group when any failure of one shares a key with
// any failure of the other. The keys are cheap, and wrong only by being
// too strict:
//
// - the whole failure, once what varies between runs is stripped: the
//   test's own header and stacktrace line, PIDs, addresses, numbers
// - the error (the message but for the test's own code line) and the
//   stack it was raised from, when that's outside the test body: a
//   setup, a support module, the code under test
//
// An assertion that fails in the test body only matches the same
// assertion failing with the same values elsewhere.

// Frames from these are never where a test's cause is.
const STDLIB = /^\((elixir|stdlib|kernel|ex_unit|logger|erts|iex|mix|compiler)(\s[^)]*)?\)\s/;
const TEST_BODY = /:\s*\(test\)$/;

// left: and right: are the values an assertion compared, and keep their
// numbers: a 500 and a 404 aren't the same failure.
function stripLine(line) {
  return /^(left|right):/.test(line) ? stripIds(line) : stripVarying(line);
}

function stripIds(text) {
  return text
    .replace(/#(PID|Reference|Port|Function)<[^>]*>/g, "#$1<>")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
}

function stripVarying(text) {
  return stripIds(text)
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "N");
}

// A frame keeps its file and line, which say where the failure came from,
// but not the app's version.
function frame(line) {
  return line
    .replace(/^\(([\w]+) [^)]*\)/, "($1)")
    .replace(/#(PID|Reference|Port|Function)<[^>]*>/g, "#$1<>");
}

// ExUnit's failure, split into the message and the stacktrace, without
// the header that names the test ("1) test x (Mod)" and its file:line).
function parse(message) {
  const lines = String(message ?? "").split("\n").map((l) => l.trim());
  while (lines.length && lines[0] === "") lines.shift();
  if (/^\d+\)\s/.test(lines[0] ?? "")) {
    lines.shift();
    if (/^[^\s:]+:\d+$/.test(lines[0] ?? "")) lines.shift();
  }
  const at = lines.indexOf("stacktrace:");
  const text = (at < 0 ? lines : lines.slice(0, at)).filter(Boolean);
  const frames = at < 0 ? [] : lines.slice(at + 1).filter(Boolean);
  return { text, frames };
}

export function normalizeFailure(message) {
  const { text, frames } = parse(message);
  return [...text.map(stripLine), ...frames.filter((f) => !TEST_BODY.test(f)).map(frame)].join("\n");
}

// Messages that say nothing about the cause.
const EMPTY = /^(\(no message\)|setup_all failed|\(flake-hunt couldn't format this failure.*\))?$/;

export function failureKeys(flake) {
  const keys = new Set();
  for (const r of flake.failedRuns) {
    const message = String(r.message ?? "").trim();
    if (EMPTY.test(message)) continue;
    keys.add(`failure\n${normalizeFailure(message)}`);
    const { text, frames } = parse(message);
    // The error: the message without the test's own code line, which is
    // all that differs when two tests call the same thing.
    const error = text.filter((l) => !/^code:/.test(l)).map(stripLine);
    // Where it was raised, and how it got there: the frames that aren't
    // Elixir's own or the test body's. The first of them alone isn't
    // enough, since it's often a dependency's (DBConnection's, say) that
    // many causes go through. Raised in the test body, it's that test's.
    const site = frames.find((f) => !STDLIB.test(f));
    const path = frames.filter((f) => !STDLIB.test(f) && !TEST_BODY.test(f)).map(frame);
    if (error.length && site && !TEST_BODY.test(site)) keys.add(`raised\n${error.join("\n")}\n${path.join("\n")}`);
  }
  return keys;
}

// The groups, as lists of indexes into flakes, each in the flakes' order
// and ordered by their first member.
export function groupFlakes(flakes) {
  const parent = flakes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = new Map();
  flakes.forEach((f, i) => {
    for (const k of failureKeys(f)) {
      if (!seen.has(k)) seen.set(k, i);
      else {
        const [x, y] = [find(seen.get(k)), find(i)];
        if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
      }
    }
  });
  const groups = new Map();
  flakes.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });
  return [...groups.values()];
}
