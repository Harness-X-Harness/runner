# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create issues with `gh issue create`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List issues with `gh issue list` and request structured JSON fields when filtering.
- Comment with `gh issue comment <number>`.
- Apply or remove labels with `gh issue edit <number>`.
- Close issues with `gh issue close <number>`.

Infer the repository from `git remote -v`; inside this clone, `gh` targets
`Harness-X-Harness/runner`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve an ambiguous reference before
acting on it.

## Publishing and dependencies

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket,
read the full issue and its comments.

Use GitHub's native issue dependencies. Add a blocking edge through the issue dependency API using the
blocker's numeric database ID, not its issue number or GraphQL node ID. If native dependencies are not
available, record `Blocked by: #<number>` in the dependent issue body.

An issue is on the frontier when it is open, has no open blockers, and has no assignee.
