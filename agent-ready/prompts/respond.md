## Respond phase, round {{round}}

The workflow waited for CI and the review bots on your pull requests. This is what still needs work.

### Failed checks
{{failed}}

### Open review threads
{{threads}}
{{waitingFor}}
Work through them the way issue-fix-stack's phase 4 says, using the pr-feedback skill for the threads.

- **Failures:** read the logs (`gh run view <run> --log-failed`, or `gh api` for the job). Each one ends green one way or another:
  - It fails the same way on main: fix it anyway, the way the system prompt says.
  - A flake (it passes when you run it again) or a cancelled job: don't change code for it. Name the job and the evidence in {{state}}/comment.md. The workflow reruns it.
  - Anything else: fix it at the right layer, with a test, then rerun the gates.
- **Commits:** amend or add commits at the right level of the stack, and restack the levels above.
- **Threads:** decide for each one whether to fix it, refute it with evidence, or leave it for {{owner}} to decide. Draft the reply.

GH_TOKEN is read-only in this phase. Commit locally, and don't push or post anything.

Finish with {{state}}/outcome.json:

- `{"status": "ready"}` when there's anything to push or any reply to post.
- `{"status": "blocked", "reason": "<one line: exactly why>"}` when it needs {{owner}}. Put the details in {{state}}/comment.md.
- `{"status": "nothing-to-do"}` when nothing should change, because every failure left is a flake or a cancelled job. The workflow reruns those jobs and waits again. Say why in {{state}}/comment.md.
