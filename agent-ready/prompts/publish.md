## Publish phase

GH_TOKEN can now write to {{repo}}, for about an hour.

Push the branches and open the pull requests as drafts, using the titles and bodies in {{state}}/prs/:

- For a stack, run `gh stack submit --auto`, which opens drafts. Then `gh pr edit` each one with its title and body.
- For one branch, run `git push -u origin HEAD`, then `gh pr create --draft --title "..." --body-file <file>`.

Leave the `./screenshots/` references in the bodies as they are. The workflow uploads those files after this phase. Post any Phase 3 refutations as PR comments.

Finish with {{state}}/outcome.json: `{"status": "published", "prs": [<numbers, bottom of the stack first>]}`, or `{"status": "blocked"}` with the reason in {{state}}/comment.md.
