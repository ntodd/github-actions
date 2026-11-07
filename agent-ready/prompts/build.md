# Issue #{{number}}: {{title}}

{{body}}

{{comments}}
{{subIssues}}
Labels: {{labels}}

## Build phase

Do phases 0 to 3 of issue-fix-stack for this issue:

1. Triage it and reproduce it on current main. Run main's gates too: if main is already red, fixing that is part of the job (see the system prompt on CI).
2. Design the levels.
3. For each level: TDD the fix, run the gates, check user-visible changes in the headless browser, and commit it (one commit per level, with `Fixes #{{number}}` or the sub-issue it fixes). A single level is a plain branch named the git-workflow way (`bug/<issue>-<slug>`, `feature/<issue>-<slug>` or `task/<issue>-<slug>`). Only a stack uses `gh stack init` and `gh stack add` with `stack/` branches, following the stacked-pr skill. Don't submit or push anything yet.
4. Get the adversarial review, then disposition every finding.

Then draft each PR's title and body. If the repo has a PR template (`.github/pull_request_template.md`, or one in `.github/PULL_REQUEST_TEMPLATE/`, `docs/` or the root), use it. Otherwise use this one:

~~~markdown
Fixes #<issue>

**What does this PR do?**
What it changes and why.

**Screenshots**
Each one as ![alt text](./screenshots/<file>.png), or N/A.

**Does this PR require any external coordination to deploy?**
Migrations, env vars, new dependencies, queue config and so on, or: No

**Additional context**
Breaking changes, affected integrations, key files modified.
~~~

Either way, end the body with these two sections:

~~~markdown
**How this was made**
- [x] Reproduced on main: how, or why it couldn't be
- [x] TDD: the test that failed first, and what made it pass
- [x] Gates: the commands, like `mix precommit`
- [x] Headless browser: the screens and states checked (light and dark, phone width)
- [x] Adversarial review by Codex: what it found, and what you fixed, refuted or left out of scope
- [ ] A step you skipped: why

**Decisions**
- Each call you made that someone could have made differently, and why you made it.
~~~

Tick only what you did. A step you skipped stays unticked with the reason, like `- [ ] Headless browser: no user-visible change`. If Codex wasn't available, the review line says a Claude subagent did it. If you made no decisions worth a reviewer's look, say so. Fill in the coordination section the way the git-workflow skill says, from the diff. In a stack, follow the stacked-pr skill: `Part of #N (stack k/m)` on the lower levels and the closing keyword on the top one, except that a level that fixes its own sub-issue says `Fixes #<sub-issue>`.

Run the text through the humanizer skill. Save each as {{state}}/prs/<branch>.md with the title on the first line and the body after a blank line. Reference a screenshot exactly as `![alt text](./screenshots/<file>.png)`.

Finish with {{state}}/outcome.json:

- `{"status": "ready"}` when every level is committed and passes its gates.
- `{"status": "blocked", "reason": "<one line: exactly why>"}` when {{owner}} has to decide something or you can't go on. Put the issue comment in {{state}}/comment.md: what you found and the exact question.
- `{"status": "nothing-to-do"}` when there's nothing to fix, because it doesn't reproduce, it's already fixed, or it's data and not code. Put the evidence in {{state}}/comment.md.
