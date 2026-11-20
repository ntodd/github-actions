# Using the factory

In a repository with an active factory caller, open an issue you wrote with a
clear description of the change and how to check it. Add `agent-ready`, or post
`/agent build`. The factory records the request, runs Claude on Crew and
publishes a draft PR. Its issue comment shows progress, questions and the next
action. CI and review happen after the worker has finished.

Review the PR and merge it when it is ready. You can enable GitHub auto-merge
yourself. Strict checks and approval of the latest push still apply; the
factory does not approve or merge PRs. The factory closes the issue after all
its recorded required work has an accepted final outcome.

Post commands as new comments. Edited comments do not authorize commands.

| Command | Use it to |
| --- | --- |
| `/agent build` | Start an accepted issue, or work on its existing PR. |
| `/agent respond` | Request another round on an existing PR. |
| `/agent update` | Bring an existing PR up to date with a clean merge. |
| `/agent resolve` | Resolve conflicts on an existing PR. |
| `/agent retry` | Request another attempt after a failure or question. |
| `/agent answer …` | Answer the current question, using the offered choice. |
| `/agent stop` | Pause work and fence further publication. The factory still inspects uncertain writes. |
| `/agent status` | Request the current status. |
| `/agent effort low` | Change the effort for subsequent work; medium, high, xhigh and max are also available. |

On your own PR, request `/agent update` or `/agent resolve` explicitly. This
authorizes that maintenance; it does not enroll the PR in automatic coding.

Exact commands do not need an OpenAI key. Mentions such as `@ntodd-agent`
need `OPENAI_API_KEY` for routing; coding uses the configured Claude credential.

New builds produce one PR per issue. Existing stacks can be recorded and
paused, but automatic stack maintenance is not implemented. See
[migration](MIGRATION.md) for legacy work and
[the conformance audit](../spec/CONFORMANCE.md) for validation evidence and
remaining design work.
