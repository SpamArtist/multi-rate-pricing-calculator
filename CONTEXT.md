# Pricing Documents

The language for creating, finalizing, and summarizing priced customer documents.

## Language

**Document**:
A generic priced record prepared for a customer. It can serve a quoting or invoicing workflow without choosing a formal quote or invoice type.
_Avoid_: Quote, invoice (as document types)

**Customer**:
The person or organization named on a document.
_Avoid_: Client, account

**Line item**:
One priced item or service on a document, with a quantity and optional discount and tax.
_Avoid_: Row, charge

**Line subtotal**:
The quantity multiplied by unit price for a line item, before discount and tax.

**Line discount**:
A fixed monetary reduction applied once to a line subtotal.
_Avoid_: Percentage discount

**Taxable line amount**:
The line subtotal after its line discount; the amount to which that line's tax percentage applies.

**Line tax**:
The tax amount calculated from a taxable line amount and that line's tax percentage.

**Line total**:
The taxable line amount plus its line tax.

**Draft**:
A document that its owner can still change, even while incomplete.

**Finalized document**:
A document whose customer details, metadata, line items, and amounts are fixed as a snapshot.
_Avoid_: Published document

**Finalization**:
The irreversible transition of a valid draft into a finalized document.

**Duplication**:
Creating a new draft from an existing document, whether that document is a draft or finalized.

**Issue date**:
The calendar date assigned to a document for listing and reporting.

**Summary report**:
An aggregate view of documents whose issue dates fall in a selected range.
