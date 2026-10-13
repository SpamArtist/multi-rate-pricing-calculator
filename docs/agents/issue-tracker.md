# Issue tracker: GitHub

Issues and Wayfinder maps for this repo live in GitHub Issues. Use the `gh` CLI for all operations. The current MVP map is [Wayfinder: Multi-Rate Pricing Calculator MVP](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/1).

## Conventions

- Infer the repository from the `origin` remote: `SpamArtist/multi-rate-pricing-calculator`.
- Create, read, edit, comment on, and close issues with `gh issue`.
- Use `wayfinder:map` for maps and `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task` for decision tickets.
- Pull requests are not part of the issue triage queue.

## Wayfinding operations

- **Map:** one issue labelled `wayfinder:map`, containing Destination, Notes, Decisions so far, Not yet specified, and Out of scope.
- **Child ticket:** a GitHub sub-issue of the map. Create the issue first, get its database ID with `gh api repos/SpamArtist/multi-rate-pricing-calculator/issues/<number> --jq .id`, then attach it with `gh api --method POST repos/SpamArtist/multi-rate-pricing-calculator/issues/<map-number>/sub_issues -F sub_issue_id=<database-id>`.
- **Blocking:** use GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/SpamArtist/multi-rate-pricing-calculator/issues/<blocked-number>/dependencies/blocked_by -F issue_id=<blocker-database-id>`. The `issue_id` is the numeric database ID, not the issue number.
- **Frontier:** list the map's open sub-issues in order, then skip assigned tickets and those with open blockers. A closed blocker no longer gates the ticket.
- **Claim:** assign the ticket to the driving developer before starting work: `gh issue edit <number> --add-assignee @me`.
- **Resolve:** post the answer as an issue comment, close the ticket, then add one linked gist to the map's Decisions so far. Keep the detailed answer on the ticket.
