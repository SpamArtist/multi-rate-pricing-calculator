import React from 'react';
import { PrototypeIcon } from '../PrototypeIcon.js';
import { formatDate, formatEuro } from '../formatting.js';
import { navigate } from '../routing.js';
import { LineItem } from './LineItem.js';
import { useDocumentEditor } from './useDocumentEditor.js';
import type { DocumentEditorProps } from './useDocumentEditor.types.js';

export function DocumentEditor(props: DocumentEditorProps): React.JSX.Element {
  const {
    document, documentId, values, lines, loading, loadError, message, duplicateCopyId, submitted, pending,
    linePreviews, titleError, dateError, customerError, lineItemsError, serverLineErrors,
    canEdit, canMutate, statusLabel, amounts, successMessage,
    changeField, changeLine, moveLine, removeLine, addLine, saveDraft, duplicateDocument, deleteDraft,
  } = useDocumentEditor(props);

  if (loading || !values) {
    return (
      <main className="ledger-page" aria-live="polite">
        {loadError ? <p className="request-error" role="alert">{loadError}</p> : <p>Loading document…</p>}
        <button className="back-link" type="button" onClick={() => navigate('/documents')}><PrototypeIcon name="back" />All documents</button>
      </main>
    );
  }

  return (
    <>
    {message && successMessage && <p className="document-notice" role="status">
      {message}
      {duplicateCopyId && message === 'Draft duplicated.' && <> <a href={`#/documents/${encodeURIComponent(duplicateCopyId)}`}>Open copy →</a></>}
    </p>}
    <main className="ledger-page" data-testid="document-editor">
      <button className="back-link" type="button" onClick={() => navigate('/documents')}><PrototypeIcon name="back" />All documents</button>
      <form className="document-form" noValidate onSubmit={event => { event.preventDefault(); void saveDraft(); }}>
        <header className="editor-heading">
          <div className="editor-title">
            <span className="section-label">{statusLabel}</span>
            <h1>{values.title.trim() || 'Untitled document'}</h1>
            <p>Issue date {formatDate(values.issueDate)}</p>
          </div>
          <div className="editor-actions">
            <span className={`status-badge ${document?.status ?? 'unsaved'}`}>
              {!document ? 'Unsaved' : document.status === 'draft' ? 'Draft' : 'Finalized'}
            </span>
            {canEdit && !documentId && <button className="secondary-button" type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save as draft'}
            </button>}
            {document && <button
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={() => void duplicateDocument()}
            ><PrototypeIcon name="copy" />{pending ? 'Working…' : 'Duplicate'}</button>}
            {document?.status === 'draft' && <button
              className="secondary-button danger-button"
              type="button"
              disabled={!canMutate}
              onClick={() => void deleteDraft()}
            >{pending ? 'Deleting…' : 'Delete draft'}</button>}
            <button className="secondary-button print-button" type="button" onClick={() => window.print()}><PrototypeIcon name="print" />Print</button>
          </div>
        </header>

        {loadError && <p className="request-error" role="alert">{loadError}</p>}
        {message && !successMessage && <p className="request-error" role="alert">{message}</p>}

        <section className="metadata editor-section" aria-labelledby="metadata-heading">
          <div className="section-heading">
            <h2 id="metadata-heading">Document details</h2>
            <span>01</span>
          </div>
          <div className="metadata-fields">
            <div className="field">
              <label htmlFor="document-title">Document name</label>
              <input
                id="document-title"
                name="title"
                autoComplete="off"
                value={values.title}
                disabled={!canMutate}
                aria-invalid={Boolean(titleError)}
                aria-describedby={titleError ? 'document-title-error' : undefined}
                onChange={event => changeField('title', event.currentTarget.value)}
              />
              <span className="print-value">{values.title}</span>
              {titleError && <p className="field-error" id="document-title-error" role="alert">{titleError}</p>}
            </div>
            <div className="field">
              <label htmlFor="customer-name">Customer name</label>
              <input
                id="customer-name"
                name="customerName"
                autoComplete="off"
                value={values.customerName}
                disabled={!canMutate}
                aria-invalid={Boolean(customerError)}
                aria-describedby={customerError ? 'customer-name-error' : undefined}
                onChange={event => changeField('customerName', event.currentTarget.value)}
              />
              <span className="print-value">{values.customerName}</span>
              {customerError && <p className="field-error" id="customer-name-error" role="alert">{customerError}</p>}
            </div>
            <div className="field">
              <label htmlFor="issue-date">Issue date</label>
              <input
                id="issue-date"
                name="issueDate"
                type="date"
                value={values.issueDate}
                disabled={!canMutate}
                aria-invalid={Boolean(dateError)}
                aria-describedby={dateError ? 'issue-date-error' : undefined}
                onChange={event => changeField('issueDate', event.currentTarget.value)}
              />
              <span className="print-value">{values.issueDate ? formatDate(values.issueDate) : ''}</span>
              {dateError && <p className="field-error" id="issue-date-error" role="alert">{dateError}</p>}
            </div>
          </div>
        </section>

        <section className="line-section editor-section" aria-labelledby="line-items-heading">
          <div className="section-heading">
            <h2 id="line-items-heading">Line items</h2>
            <span>02</span>
          </div>
          {lines.length === 0 && <p className="empty-lines">No line items yet. Drafts can be saved without lines.</p>}
          {lineItemsError && <p className="field-error" role="alert">{lineItemsError}</p>}
          {lines.map((line, index) => (
            <LineItem
              key={line.key}
              line={line}
              index={index}
              preview={linePreviews[index]}
              errors={serverLineErrors[line.key] ?? {}}
              submitted={submitted}
              canEdit={canEdit}
              canMutate={canMutate}
              lineCount={lines.length}
              onChange={changeLine}
              onMove={moveLine}
              onRemove={removeLine}
            />
          ))}
          {canEdit && <button className="add-line" type="button" disabled={!canMutate} onClick={addLine}><PrototypeIcon name="plus" />Add line item</button>}
        </section>

        <section className="breakdown editor-section" aria-labelledby="arithmetic-heading">
          <div className="section-heading">
            <h2 id="arithmetic-heading">Arithmetic</h2>
            <span>03</span>
          </div>
          <dl className="amount-list">
            <div><dt>Line subtotals</dt><dd>{amounts ? formatEuro(amounts.subtotalCents) : '—'}</dd></div>
            <div><dt>Line discounts</dt><dd>−{amounts ? formatEuro(amounts.discountCents) : '—'}</dd></div>
            <div><dt>Taxable amount</dt><dd>{amounts ? formatEuro(amounts.taxableCents) : '—'}</dd></div>
            <div><dt>Sum of line taxes</dt><dd>{amounts ? formatEuro(amounts.taxCents) : '—'}</dd></div>
          </dl>
          <div className="grand-total"><span>Document total</span><strong>{amounts ? formatEuro(amounts.totalCents) : '—'}</strong></div>
          <p className="calculation-note">Tax is rounded for each line, then summed.</p>
          {canEdit && <div className="document-save-actions">
            {documentId && <button className="secondary-button" type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save changes'}
            </button>}
            <button
              className="primary-button"
              type="button"
              disabled={pending}
              onClick={() => void saveDraft(true)}
              aria-describedby="finalize-note"
            >{pending ? 'Finalizing…' : 'Finalize document'}<PrototypeIcon name="arrow" /></button>
            <p className="finalize-note" id="finalize-note">Finalization fixes this document permanently.</p>
          </div>}
          {!canEdit && <p className="snapshot-note">Finalized documents are fixed snapshots.</p>}
        </section>
      </form>
    </main>
    </>
  );
}
