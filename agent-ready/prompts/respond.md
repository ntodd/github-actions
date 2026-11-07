## Respond phase, round {{round}}

The workflow waited for CI and the review bots on your pull requests. This is what still needs work.

### Failed checks
{{failed}}

### Open review threads
{{threads}}
{{waitingFor}}
Work through them the way issue-fix-stack's phase 4 says, using the pr-feedback skill for the threads.

- **Failures:** read the logs (`gh run view <run> --log-failed`, or `gh api` for the job). A cancelled or superseded run isn't a failure. A test that passes when you run it again is a flake: say so, and don't change code for it. Fix a real failure at the right layer, with a test, then rerun the gates.
- **Commits:** amend or add commits at the right level of the stack, and restack the levels above.
- **Threads:** decide for each one whether to fix it, refute it with evidence, or leave it for {{owner}} to decide. Draft the reply.

GH_TOKEN is read-only in this phase. Commit locally, and don't push or post anything.

Finish with {{state}}/outcome.json:

- `{"status": "ready"}` when there's anything to push or any reply to post.
- `{"status": "blocked"}` when it needs {{owner}}. Put the reason in {{state}}/comment.md.
- `{"status": "nothing-to-do"}` when nothing should change, for example when the only failure is a flake. Say why in {{state}}/comment.md.
