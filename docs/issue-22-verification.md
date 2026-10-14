# Issue 22 verification: print and narrow-screen review

## Result

Verified Variant B · Ledger detail in Chrome at 430px and under emulated print media. Print uses the existing detail DOM and browser `window.print()`; print clicks issued no network request and no print/PDF route exists.

## Print evidence

Playwright saved and reopened an incomplete draft with a blank first-line description. It stubbed `window.print()` to assert the Print control call, emulated print media, then checked the rendered DOM and screenshots. The click stayed on the same detail route and issued no network request. The print DOM retained title, customer, issue date, ordered lines, arithmetic, and five document totals. Status printed as `DRAFT`; app navigation, buttons, and line actions were hidden. Finalization then produced `FINALIZED`; reloaded API data matched the stored snapshot exactly, and print retained the same details and amounts.

API amount values matched calculation contract: subtotal 6497 cents, discount 1000, taxable 5497, tax 987, total 6484. Ordered line totals were 5946 and 538 cents.

- [Draft print screenshot](evidence/issue-22-draft-print.png)
- [Finalized print screenshot](evidence/issue-22-finalized-print.png)
- [Draft API response](evidence/issue-22-draft-document.json)
- [Finalized API snapshot](evidence/issue-22-finalized-document.json)

## 430px evidence

At 430 × 932, dashboard actions and the summary panel remained visible without horizontal overflow. In the editor, Playwright added two lines, edited all first-line inputs, removed the second line, and checked full arithmetic. Line total and all five document amounts stayed inside the viewport; line total aligned to the right edge of its input grid.

- [Dashboard screenshot](evidence/issue-22-dashboard-mobile.png)
- [Summary screenshot](evidence/issue-22-summary-mobile.png)
- [Editor screenshot](evidence/issue-22-editor-mobile.png)

## Prototype comparison

Reviewed selected Variant B desktop and mobile editor snapshots, plus desktop dashboard and summary snapshots under `prototype/dashboard-editor/snapshots/`. Mobile editor keeps two-column line inputs, full-width arithmetic, and right-aligned totals. Production screenshots above confirm the same responsive behavior without horizontal clipping.

## Checks

`npm run check` passed:

- TypeScript: passed.
- ESLint: passed.
- API: 10 files, 42 tests passed.
- DB: 1 file, 7 tests passed.
- Playwright UI: 16 tests passed, including both Issue 22 cases.

ESLint ignores generated `test-results/` output so the full check remains repeatable after Playwright runs.
