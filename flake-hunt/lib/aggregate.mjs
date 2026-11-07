// Turns the JSONL the hunt writes into per-test counts.
//
// Two record types share the files:
//   {"type":"test", module, name, file, line, status, seed, run, shard, message?}
//     one per test per run, written by run/flake_formatter.exs
//   {"type":"run", shard, run, exit, tests}
//     one per run, written by run/hunt.sh after the run ends

export function normalizeDir(dir) {
  const d = (dir ?? "").trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  return d === "." ? "" : d;
}

export function keyOf(workingDirectory, module, name) {
  return `${normalizeDir(workingDirectory)}::${module}::${name}`;
}

export function parseJsonl(text, onBadLine = () => {}) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      onBadLine(line);
    }
  }
  return out;
}

export function aggregate(records, { workingDirectory }) {
  const runs = { total: 0, reported: 0, errored: 0 };
  const tests = new Map();

  for (const r of records) {
    if (r.type === "run") {
      runs.total += 1;
      if (r.tests > 0) runs.reported += 1;
      else runs.errored += 1;
      continue;
    }
    if (r.type !== "test") continue;
    if (r.status !== "passed" && r.status !== "failed") continue;

    const key = keyOf(workingDirectory, r.module, r.name);
    let t = tests.get(key);
    if (!t) {
      t = { key, module: r.module, name: r.name, file: r.file, line: r.line, runs: 0, failures: 0, failedRuns: [] };
      tests.set(key, t);
    }
    t.runs += 1;
    if (r.status === "failed") {
      t.failures += 1;
      t.failedRuns.push({ seed: r.seed, shard: r.shard, run: r.run, message: r.message ?? "" });
    }
  }

  return { runs, tests: [...tests.values()] };
}

// Flaky: failed some runs but not all. Broken: failed every run it was in.
export function classify(tests) {
  const flaky = tests
    .filter((t) => t.failures > 0 && t.failures < t.runs)
    .sort((a, b) => b.failures / b.runs - a.failures / a.runs || a.key.localeCompare(b.key));
  const broken = tests.filter((t) => t.runs > 0 && t.failures === t.runs).sort((a, b) => a.key.localeCompare(b.key));
  return { flaky, broken };
}
