## Git Workflow (Mandatory)

- After every successful issue completion, create commit(s) automatically without waiting for me to ask.
- Use small, task-scoped commits.
- [$caveman](/Users/xbotpc/.agents/skills/caveman/SKILL.md) ultra to write commits
- Stage only files changed for the current task; never include unrelated files.
- Unrelated modified or untracked files are not a blocker for committing task changes.
- If unrelated modified files exist, exclude them from commit.
- Never use `git add .` or `git commit -a`.
- Write description about the changes and implementation decisions in few words.
- Use `git commit -m "<type>: <summary>" -m "<body>"` so title and description are always present.
- The commit body must include a `Decision Summary` section.
- The `Decision Summary` section may cover:
  1. Problem observed
  2. Root cause
  3. Solution chosen
  4. Verification performed (tests/checks run)
- Keep commit description details focused only on files included in that commit.
- If any detail is uncertain, state assumptions explicitly in the commit description.
- Do not ask for permission for `git add` or `git commit` to create a commit.

## Test files and prototypes

- Files created by tests (screenshots, traces, PDFs, API captures) go in ignored `test-results/` or `.artifacts/`. Attach them to the test result or CI run when needed; do not commit them or link to them from tracked docs.
- Files that tests read as inputs may be committed under `tests/fixtures/`. Create them independently from product requirements; do not copy or derive them from `prototype/`.
- `prototype/` is for design review only. Tests must never read, serve, import, execute, or compare against prototype files.
- Check staged paths before committing. CI runs `scripts/check-generated-evidence.sh` and `scripts/check-test-isolation.sh`.

## Agent skills

### Issue tracker

GitHub Issues is the canonical issue tracker and Wayfinder map. See `docs/agents/issue-tracker.md`.
