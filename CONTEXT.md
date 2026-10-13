# Pricing Documents

The language for creating, finalizing, and summarizing priced customer documents.

## Language

**Document**:
A generic priced record issued to a customer. It can serve a quoting or invoicing workflow without choosing a formal quote or invoice type.
_Avoid_: Quote, invoice (as document types)

**Customer**:
The person or organization named on a document.
_Avoid_: Client, account

**Line item**:
One priced item or service on a document, with a quantity and optional discount and tax.
_Avoid_: Row, charge

**Draft**:
A document that its owner can still change.

**Finalized document**:
A document whose metadata, line items, and amounts are fixed.
_Avoid_: Published document

**Issue date**:
The calendar date assigned to a document for listing and reporting.

**Summary report**:
An aggregate view of documents whose issue dates fall in a selected range.
