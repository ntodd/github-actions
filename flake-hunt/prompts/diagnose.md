You're looking at a flaky ExUnit test. A scheduled hunt ran this Mix project's suite many times with random seeds. This test failed in some runs and passed in the rest.

- Test: {{test}}
- File: `{{file}}:{{line}}`, relative to the Mix project. Your current directory is that project (`{{working_directory}}` in the repo).
- Failed {{failures}} of {{runs}} runs. Seeds of the failing runs: {{seeds}}.

The failures, one per distinct message:

<failures>
{{failures_block}}
</failures>

Work out why it flakes and how to fix it. The deps are fetched and compiled, `MIX_ENV=test` is set, and whatever the tests need (databases, tools) is set up, so you can run tests:

- `mix test --seed {{first_seed}}` runs the whole suite in an order that failed. Order-dependent and shared-state flakes often only show up this way, because running one file changes the order.
- `mix test {{file}}:{{line}} --repeat-until-failure 200` runs the test alone until it fails.
- `--max-cases 1` (serial) and `--max-cases 32` (more contention) help tell an ordering problem from a concurrency one.

Read the test, its setup, and the code it exercises. Common causes in Elixir suites:

- `async: true` tests sharing global state: named processes, ETS tables, Application env, `:persistent_term`, files, fixed ports.
- Timing: `Process.sleep`, receive timeouts, `assert_receive` windows that are too short under load.
- Processes outliving the test, or work that's still running when the test exits (missing `start_supervised`, unawaited tasks).
- Ecto sandbox ownership for processes the test spawns.
- Order: maps, sets, or rows read without an `ORDER BY`.
- Time and randomness: `DateTime.utc_now()` near a boundary, unseeded `:rand`.

Try to reproduce it before you name a cause. If ten minutes of attempts don't reproduce it, reason from the code and say you couldn't. You may edit files to test an idea, such as adding logging or trying a fix and rerunning. Your edits are thrown away afterward. Don't commit, push, or open anything.

Your reply goes into a GitHub issue as is. Reply with only the diagnosis, in GitHub markdown, under 400 words, in this shape:

**Likely cause:** one to three sentences.

**Evidence:** what you ran and what you saw. Say plainly whether you reproduced the failure.

**Suggested fix:** the smallest change that removes the flake, as a `diff` block if you're confident, otherwise in words. Don't suggest skipping the test or raising a timeout unless that's the right fix.

**Confidence:** high, medium or low, and why.

No preamble and no headings.
