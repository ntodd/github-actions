## Publish phase{{roundSuffix}}

GH_TOKEN can write to {{repo}} again, for about an hour.

{{^resolve}}1. Push the respond phase's commits. For a stack, restack if you changed a lower level, then `gh stack push`. Otherwise `git push`, using `--force-with-lease` only if you rewrote a commit.
2. Answer every thread from the respond phase. Reply with what changed and the commit, or with the evidence for leaving it as it is. Then resolve each thread you've answered with the `resolveReviewThread` GraphQL mutation. A thread that needs {{owner}} to decide gets a reply and stays open.
3. Bring each PR body up to date. Add this round to **How this was made**: the CI failures and what fixed them, and the review threads you answered. New screenshots go in {{state}}/screenshots/ and the body as `![alt text](./screenshots/<file>.png)`, as before.

Finish with {{state}}/outcome.json: `{"status": "published", "prs": [<all of the run's PR numbers, bottom first>]}`, or `{"status": "blocked", "reason": "<one line: exactly why>"}` with the details in {{state}}/comment.md.
{{/resolve}}{{#resolve}}This is a resolve run, so it publishes to #{{pr}} and nowhere else:

1. Push the branch with `git push origin HEAD:{{headRef}}`. The new commits sit on top of the branch as it is on GitHub, so it's a fast-forward: never force it, and never amend or rewrite a commit to get it through. Don't open a pull request, and don't push any other branch.
2. If GitHub refuses the push, don't work around it. Finish `blocked` with GitHub's own message as the reason. A merge can bring in the base's changes under `.github/workflows/`, which this token may not be allowed to push.
{{^own}}3. Answer every thread from a respond phase, if there was one, the way a build run does: reply with what changed and the commit, or the evidence for leaving it, then resolve the thread with the `resolveReviewThread` GraphQL mutation. A thread that needs {{owner}} to decide gets a reply and stays open.
4. If a respond round changed anything, add it to **How this was made** in the PR body. Leave the rest of the body alone.
{{/own}}{{#own}}3. Leave the review threads, the description, the draft state and the reviewers as they are. They're {{author}}'s.
{{/own}}
The workflow comments on #{{pr}} with what was merged, so don't post that yourself.

Finish with {{state}}/outcome.json: `{"status": "published"}`, or `{"status": "blocked", "reason": "<one line: exactly why>"}` with the details in {{state}}/comment.md.
{{/resolve}}
