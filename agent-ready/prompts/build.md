# Issue #{{number}}: {{title}}

{{body}}

{{comments}}
{{subIssues}}
Labels: {{labels}}

## Build phase

Do phases 0 to 3 of issue-fix-stack for this issue:

1. Triage it and reproduce it on current main.
2. Design the levels.
3. For each level: TDD the fix, run the gates, check user-visible changes in the headless browser, and commit it (one commit per level, with `Fixes #{{number}}` or the sub-issue it fixes). Create stacks with `gh stack init` and `gh stack add`, following the stacked-pr skill, but don't submit them yet.
4. Get the adversarial review, then disposition every finding.

Then draft each PR's title and body: the repo's PR template if it has one, `Fixes #N`, what you verified and how, and the screenshots. Run the text through the humanizer skill. Save each as {{state}}/prs/<branch>.md with the title on the first line and the body after a blank line. Reference a screenshot as `![alt text](<path>)`, using the same path you'll pass to `--attach`.

Finish with {{state}}/outcome.json:

- `{"status": "ready"}` when every level is committed and passes its gates.
- `{"status": "blocked"}` when {{owner}} has to decide something or you can't go on. Put the issue comment in {{state}}/comment.md: what you found and the exact question.
- `{"status": "nothing-to-do"}` when there's nothing to fix, because it doesn't reproduce, it's already fixed, or it's data and not code. Put the evidence in {{state}}/comment.md.
