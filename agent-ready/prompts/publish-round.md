## Publish phase, round {{round}}

GH_TOKEN can write to {{repo}} again, for about an hour.

1. Push the respond phase's commits. For a stack, restack if you changed a lower level, then `gh stack push`. Otherwise `git push`, using `--force-with-lease` only if you rewrote a commit.
2. Answer every thread from the respond phase. Reply with what changed and the commit, or with the evidence for leaving it as it is. Then resolve each thread you've answered with the `resolveReviewThread` GraphQL mutation. A thread that needs {{owner}} to decide gets a reply and stays open.
3. If a PR body is now out of date, update it.

Finish with {{state}}/outcome.json: `{"status": "published", "prs": [<all of the run's PR numbers, bottom first>]}`, or `{"status": "blocked"}` with the reason in {{state}}/comment.md.
