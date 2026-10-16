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
- Commit visual test fixtures only when production tests require those exact files; keep them under `tests/fixtures/`. Commit design references only when product documentation requires them; keep them with the design source. Tests must never use design references as fixtures. Never store either in `docs/evidence/`.
- Inspect staged paths before committing. Do not force-add generated evidence; `scripts/check-generated-evidence.sh` enforces the tracked-directory rule in CI.

## Test isolation

- Tests must not read, serve, import, execute, or compare against files in `prototype/`. Use production behavior and independent fixtures or contract values as test inputs. `scripts/check-test-isolation.sh` checks direct test references in CI.

## Agent skills

### Issue tracker

GitHub Issues is the canonical issue tracker and Wayfinder map. See `docs/agents/issue-tracker.md`.
