# Resolve pull request #{{pr}}

{{^own}}#{{pr}} closes issue #{{number}}: {{title}}

{{body}}

{{comments}}{{/own}}{{#own}}{{author}} wrote #{{pr}} ({{title}}) and asked for this with a `/resolve` comment. There's no issue behind it, so the pull request is all there is to say what it means to do. Its description:

{{body}}
{{/own}}
## Resolve phase

{{^again}}`{{baseRef}}` moved, and #{{pr}} (`{{headRef}}`) now conflicts with it. Merge `{{baseRef}}` into the branch, resolve the conflicts the way the pull request meant, and get its gates passing again. Nothing gets built in this run, so issue-fix-stack's phases don't apply.{{/again}}{{#again}}`{{baseRef}}` moved again while the run worked, and #{{pr}} conflicts with it once more. Do the same again from where the branch is now.{{/again}}

GH_TOKEN is read-only in this phase. Commit locally, and don't push or post anything.

1. **Check out the branch.** {{^again}}The job set up `{{baseRef}}`, not the branch. Run `git fetch origin {{headRef}} {{baseRef}}`, then `git checkout -B {{headRef}} {{headSha}}`. That commit is the head the run checked, so use it even if the branch has moved since. Then refresh the dependencies the way the repo does (`mix deps.get`, `npm ci` and so on). If the branch needs a different Elixir, OTP or Node than `{{baseRef}}` does (compare `.tool-versions`, `mise.toml`, `mix.exs` and `.nvmrc` on the two), finish `blocked` and say which.{{/again}}{{#again}}Run `git fetch origin {{baseRef}}`. `{{headRef}}` is at `{{headSha}}`, where you pushed it.{{/again}}
2. **Merge.** Run `git merge {{baseSha}}`, which is `{{baseRef}}` as the run read it. Merge, don't rebase: the branch is pushed without force, and its review history stays as it is.
3. **Resolve.** Before changing a file, read what each side meant:
   - the conflicted files (`git diff --name-only --diff-filter=U`)
   - {{^own}}the issue above, and {{/own}}the pull request (`gh pr view {{pr}} --json title,body,commits` and `gh pr diff {{pr}}`)
   - what `{{baseRef}}` did to those files since the merge base (`git log --oneline $(git merge-base {{headSha}} {{baseSha}})..{{baseSha}} -- <files>`), and the pull request behind each of those commits where there is one (`gh api repos/{{repo}}/commits/<sha>/pulls`)
4. **Run the gates** the build would run: the ones the repo's CLAUDE.md or AGENTS.md names, and `mix precommit` where it exists. Fix what the merge broke.
5. **Read the whole diff** against `{{baseRef}}` once more (`git diff {{baseSha}} HEAD`). It should be the pull request as it was, plus what the merge needed, and nothing else. Commit the merge, and any fix after it as a commit of its own.

Rules for resolving:

- Keep what both sides meant. Change only what it takes to make the two work together. The pull request takes on no new work.
- Regenerate generated files (lock files, say) with the tool that writes them. Don't merge them by hand.
- Don't guess. If `{{baseRef}}` already does what the pull request does, or the two sides want different things (`{{baseRef}}` rewrote the function the pull request changes, say), finish `blocked`, naming the files and why. When `{{baseRef}}` already covers it, ask {{owner}} to close the pull request.{{#own}} There's no issue to check the intent against here, so be stricter: when the two sides disagree and the pull request doesn't make clear what {{author}} meant, block and ask.{{/own}}
- A check that fails the same way on `{{baseRef}}` isn't this run's to fix. This is the one place a resolve run differs from the system prompt's rule on CI: finish `blocked` and name the check.

Finish with {{state}}/outcome.json:

- `{"status": "ready", "files": ["<each file whose conflict you resolved>"]}` when the merge is committed and the gates pass.
- `{"status": "blocked", "reason": "<one line: exactly why>"}` when {{owner}} has to decide something or you can't go on. Put the details in {{state}}/comment.md: the files, what each side wants, and the exact question.

There's no `nothing-to-do` in a resolve run. A pull request that should be closed is `blocked`, with that as the reason.
