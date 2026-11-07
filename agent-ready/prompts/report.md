## Report

The run is over. Status: {{status}}{{reason}}. Pull requests: {{prs}}. Review rounds: {{rounds}}.

Write issue-fix-stack's phase 6 report to {{state}}/report.md:

- Lead with the count and the state.
- A table of the levels: PR, issue and title.
- Every review finding and how it was dispositioned, refutations included.
- The verification you ran, with the commands and what they showed.
- Blockers, with what you tried.
- What's still open for {{owner}}.

Report only what you ran.

If the status is blocked, also write {{state}}/comment.md: a short note for the issue saying what's left and what {{owner}} needs to do.

Finish with {{state}}/outcome.json: `{"status": "done"}`.
