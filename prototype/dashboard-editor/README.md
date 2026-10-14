# Dashboard and editor prototype

Throwaway layout study for [Dashboard and editor prototype](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/7). Run `npm run prototype`, then open `http://127.0.0.1:4173/`. Switch variants with bottom controls, arrow keys, or `?variant=A`, `B`, `C`.

- **A · Workbench:** persistent document rail, central editor, right arithmetic inspector.
- **B · Ledger:** wide dashboard table, full-width form editor, summary band.
- **C · Document view:** quiet document list and page-like editor with contextual controls.

Sample data and changes live only in memory. Variant switches preserve current sample state. Reload resets it. The design decision belongs in the issue, not this code.
