# github-actions

Reusable workflows and actions for my repos, mostly meant to run on
[Crew](https://github.com/ntodd/crew).

| | |
|---|---|
| [flake-hunt](flake-hunt/) | Runs a Mix project's suite many times and files an issue for each flaky test, with a diagnosis from Claude. |
| [agent-ready](agent-ready/) | Works an issue labeled `agent-ready` into draft PRs, then keeps at them until CI is green and review threads are answered. Resolves their conflicts when the default branch moves, and any PR's on `/resolve`. |
| [factory](factory/) | Issue handling with durable ownership, read-only coding workers and validated publishing. In development; existing callers have not migrated. |

## Using them

Pin by commit SHA, with the tag in a comment:

```yaml
uses: ntodd/github-actions/.github/workflows/flake-hunt.yml@<sha> # flake-hunt/v1
```

Each tool has its own tags (`flake-hunt/v1`, `flake-hunt/v1.1.0`), so a
release of one doesn't move the others.

## Layout

Reusable workflows have to sit directly in `.github/workflows/`, so they're
named after their tool. Everything else a tool needs lives in its folder.
The workflows check out this repo at `job.workflow_sha`, the commit the
caller pinned, and run their actions and scripts from there. A caller's
pin covers all of it.

The actions are plain Node with no dependencies. They run on the runner's
own Node 24, so nothing needs installing and Crew's guest image works as is.

## Development

```sh
node --test
```

The tests that run Mix need `elixir` on the PATH (`mise install`).

The [factory design](DESIGN.md) has an executable
[Quint model](spec/README.md) for operation ownership, recovery and merging.
Its development dependency is separate from the dependency-free actions:

```sh
npm ci --ignore-scripts
npm run model:check
npm run model:simulate
npm run model:replay
```

Both simulation profiles use Quint's Rust backend. These checks exercise
the proposed protocol and replay it through the new [controller core](factory/).
The new runtime is under development; the existing agent-ready caller has
not migrated to it.
