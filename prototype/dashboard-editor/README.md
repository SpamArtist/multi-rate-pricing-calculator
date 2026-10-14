# Dashboard and editor prototype

Throwaway layout study for [Dashboard and editor prototype](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/7). Run `npm run prototype`, then open `http://127.0.0.1:4173/`. Switch variants with bottom controls, arrow keys, or `?variant=A`, `B`, `C`.

- **A · Workbench:** persistent document rail, central editor, right arithmetic inspector.
- **B · Ledger:** title-first dashboard table, report in a collapsible right sidebar, compact row editor. Open editors from documents; no separate Editor navigation.
- **C · Document view:** quiet document list and page-like editor with contextual controls.

Sample data and changes live only in memory. Variant switches preserve current sample state. Reload resets it. New documents stay unsaved until saved as a draft or finalized; only saved documents appear in the dashboard and can be duplicated. Document names can be edited before finalization. Duplicating a document shows a link to open the new draft in the current session. The design decision belongs in the issue, not this code.
