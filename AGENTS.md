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

## Generated evidence

- Write test screenshots, traces, PDFs, API response captures, and other run output to the test runner's ignored output directory or `.artifacts/`.
- Attach evidence to Playwright results or the relevant CI run when it needs to be shared. Keep verification notes in Git as text; do not link them to ignored local files.
- Commit visual fixtures or baselines only when tests or product documentation depend on those exact files. Store them with their source or fixture, never in `docs/evidence/`.
- Inspect staged paths before committing. Do not force-add generated evidence; `scripts/check-generated-evidence.sh` enforces the tracked-directory rule in CI.

## Agent skills

### Issue tracker

GitHub Issues is the canonical issue tracker and Wayfinder map. See `docs/agents/issue-tracker.md`.
