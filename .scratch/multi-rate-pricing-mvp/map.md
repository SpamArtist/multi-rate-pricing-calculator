Label: wayfinder:map

## Destination

An implementation-ready MVP specification and a reviewed, runnable UI prototype for a EUR pricing-document web app. The spec must settle behavior, data ownership, API boundaries, calculations, and acceptance examples before the production build starts.

## Notes

- Primary users: small businesses preparing generic priced documents for customers; there are no formal quote or invoice types in this MVP.
- Stack: TypeScript, Node.js, React, Postgres, Drizzle. Money uses integer cents; quantities are whole numbers.
- Visual direction: simple, precise, composed, with Swiss editorial cues. Show dashboard and editor prototypes made with Impeccable before asking for a production UI direction to be confirmed.
- Consult `/Users/xbotpc/.agents/skills/grilling/SKILL.md` and `/Users/xbotpc/.agents/skills/domain-modeling/SKILL.md` for discussion tickets; `/Users/xbotpc/.agents/skills/prototype/SKILL.md` and `/Users/xbotpc/.agents/skills/impeccable/SKILL.md` for the prototype ticket.
- The map charts decisions. Production implementation, deploy, and payment/tax compliance work begin only after this destination is reached.

## Decisions so far

<!-- Closed ticket index. Answers live in ticket files. -->

## Not yet specified

- The final spec's schema and endpoint detail depends on the calculation, lifecycle, auth, and report decisions.
- Prototype review may reveal further navigation, dense-table, or form-behavior decisions before the UI direction can be fixed.

## Out of scope

- Tax compliance, tax jurisdiction logic, payment collection, and document delivery by email.
- Formal invoice numbering, payment terms, and separate quote/invoice document types.
- Hosted deployment and production operations for this planning effort.
