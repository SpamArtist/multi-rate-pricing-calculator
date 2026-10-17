const initialDocs = [
  { id: 'PD-1048', name: 'Brand workshop', saved: true, customer: 'Alpen Studio', date: '2026-10-14', status: 'draft', lines: [
    { id: 1, name: 'Brand workshop', quantity: 3, price: 1999, discount: 1000, tax: 1900 },
    { id: 2, name: 'Print-ready files', quantity: 2, price: 250, discount: 0, tax: 750 }
  ] },
  { id: 'PD-1047', name: 'Menu system', saved: true, customer: 'Northline Coffee', date: '2026-10-11', status: 'finalized', lines: [
    { id: 3, name: 'Menu system', quantity: 1, price: 140000, discount: 10000, tax: 1900 },
    { id: 4, name: 'Seasonal insert', quantity: 2, price: 12500, discount: 0, tax: 1900 }
  ] },
  { id: 'PD-1046', name: 'Consultation', saved: true, customer: 'Mira & Co.', date: '2026-10-08', status: 'draft', lines: [
    { id: 5, name: 'Consultation', quantity: 4, price: 9500, discount: 0, tax: 1900 }
  ] },
  { id: 'PD-1045', name: 'Room photography', saved: true, customer: 'Berg Hotel', date: '2026-09-30', status: 'finalized', lines: [
    { id: 6, name: 'Room photography', quantity: 2, price: 37500, discount: 5000, tax: 1900 }
  ] },
  { id: 'PD-1044', name: 'Product catalog', saved: true, customer: 'Atelier Form', date: '2026-09-22', status: 'finalized', lines: [
    { id: 7, name: 'Product catalog', quantity: 1, price: 225000, discount: 25000, tax: 750 }
  ] }
];

const state = {
  docs: structuredClone(initialDocs),
  currentId: 'PD-1048',
  view: 'dashboard',
  search: '',
  status: 'all',
  listStart: '',
  listEnd: '',
  sort: 'desc',
  reportStart: '2026-10-01',
  reportEnd: '2026-10-31',
  summaryOpen: false,
  notice: '',
  noticeTargetId: null,
  nextId: 1049,
  nextLineId: 8
};

const variants = {
  A: 'Workbench',
  B: 'Ledger',
  C: 'Document view'
};
const linkedId = location.hash.startsWith('#document=') ? decodeURIComponent(location.hash.slice('#document='.length)) : null;
if (linkedId && state.docs.some(item => item.id === linkedId)) {
  state.currentId = linkedId;
  state.view = 'editor';
} else if (linkedId) {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}
const app = document.querySelector('#app');
const euros = cents => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const dateLabel = date => date ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)) : 'No issue date';
const localToday = () => { const today = new Date(); return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`; };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const doc = () => state.docs.find(item => item.id === state.currentId) ?? state.docs[0];
const variant = () => variants[new URL(location.href).searchParams.get('variant')] ? new URL(location.href).searchParams.get('variant') : 'A';
const lineCalc = line => {
  const subtotal = line.quantity * line.price;
  const taxable = subtotal - line.discount;
  const tax = Math.floor((taxable * line.tax + 5000) / 10000);
  return { subtotal, discount: line.discount, taxable, tax, total: taxable + tax };
};
const totals = document => document.lines.reduce((sum, line) => {
  const amounts = lineCalc(line);
  for (const key of Object.keys(sum)) sum[key] += amounts[key];
  return sum;
}, { subtotal: 0, discount: 0, taxable: 0, tax: 0, total: 0 });
const filteredDocs = () => state.docs.filter(item => {
  const search = state.search.trim().toLocaleLowerCase();
  return item.saved && (!search || item.customer.toLocaleLowerCase().includes(search)) &&
    (state.status === 'all' || item.status === state.status) &&
    (!state.listStart || item.date >= state.listStart) &&
    (!state.listEnd || item.date <= state.listEnd);
}).sort((a, b) => state.sort === 'desc' ? b.date.localeCompare(a.date) || b.id.localeCompare(a.id) : a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
const reportDocs = () => state.docs.filter(item => item.status === 'finalized' && item.date >= state.reportStart && item.date <= state.reportEnd);
const reportTotals = () => reportDocs().reduce((sum, item) => {
  const amount = totals(item);
  for (const key of Object.keys(sum)) sum[key] += amount[key];
  return sum;
}, { subtotal: 0, discount: 0, taxable: 0, tax: 0, total: 0 });

function icon(name) {
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    file: '<path d="M6 3h9l4 4v14H6zM15 3v5h4M9 12h7M9 16h7"/>',
    chart: '<path d="M4 20h16M7 16V9m5 7V4m5 12v-5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7M10 11v5m4-5v5"/>'
  };
  return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

const badge = (status, saved = true) => `<span class="badge ${status}"><span class="badge-dot"></span>${saved ? status === 'draft' ? 'Draft' : 'Finalized' : 'Unsaved'}</span>`;
const title = () => `<div class="brand-mark" aria-hidden="true">P<span>.</span></div><strong class="brand-name">Priced</strong>`;
const navButton = (view, label, glyph) => `<button type="button" data-action="view" data-view="${view}" class="nav-link ${state.view === view ? 'active' : ''}">${icon(glyph)}<span>${label}</span></button>`;
const newButton = () => `<button type="button" class="button primary" data-action="new">${icon('plus')}<span>New document</span></button>`;
const notice = () => state.notice ? `<p class="notice" role="status">${safe(state.notice)}${state.noticeTargetId ? ` <a href="#document=${safe(state.noticeTargetId)}" data-action="open" data-id="${safe(state.noticeTargetId)}">Open copy</a>` : ''}</p>` : '';

function filters(compact = false) {
  return `<form class="filters ${compact ? 'compact' : ''}" id="filters" autocomplete="off">
    <label class="search-field"><span class="sr-only">Search customers</span>${icon('search')}<input name="search" type="search" placeholder="Search customers" value="${safe(state.search)}"></label>
    <label><span class="sr-only">Document status</span><select name="status"><option value="all" ${state.status === 'all' ? 'selected' : ''}>All statuses</option><option value="draft" ${state.status === 'draft' ? 'selected' : ''}>Draft</option><option value="finalized" ${state.status === 'finalized' ? 'selected' : ''}>Finalized</option></select></label>
    <label><span class="sr-only">Sort by issue date</span><select name="sort"><option value="desc" ${state.sort === 'desc' ? 'selected' : ''}>Newest first</option><option value="asc" ${state.sort === 'asc' ? 'selected' : ''}>Oldest first</option></select></label>
    <label class="date-filter"><span>From</span><input name="listStart" type="date" value="${state.listStart}"></label><label class="date-filter"><span>To</span><input name="listEnd" type="date" value="${state.listEnd}"></label>
  </form>${state.listStart && state.listEnd && state.listStart > state.listEnd ? '<p class="field-error">List end date must be on or after start date.</p>' : ''}`;
}

function report() {
  const invalid = state.reportEnd < state.reportStart;
  const values = invalid ? { subtotal: 0, discount: 0, taxable: 0, tax: 0, total: 0 } : reportTotals();
  const count = invalid ? '—' : reportDocs().length;
  return `<section class="report" aria-label="Summary report">
    <div class="report-heading"><div><span class="section-label">Summary report</span><h2>Issue date totals</h2></div>${icon('chart')}</div>
    <div class="report-dates"><label>From<input name="reportStart" type="date" value="${state.reportStart}"></label><label>To<input name="reportEnd" type="date" value="${state.reportEnd}"></label></div>
    ${invalid ? '<p class="field-error">End date must be on or after start date.</p>' : `<p class="report-note">Finalized documents only · independent of list filters</p>`}
    <div class="report-major"><span>Total</span><strong>${invalid ? '—' : euros(values.total)}</strong></div>
    <dl class="amount-list"><div><dt>Documents</dt><dd>${count}</dd></div><div><dt>Subtotal</dt><dd>${euros(values.subtotal)}</dd></div><div><dt>Discounts</dt><dd>−${euros(values.discount)}</dd></div><div><dt>Taxable</dt><dd>${euros(values.taxable)}</dd></div><div><dt>Tax</dt><dd>${euros(values.tax)}</dd></div></dl>
  </section>`;
}

function documentRows(type = 'list') {
  const found = state.listStart && state.listEnd && state.listStart > state.listEnd ? [] : filteredDocs();
  if (!found.length) return `<div class="empty-list">No documents match these filters. <button type="button" class="text-button" data-action="clear-filters">Clear filters</button></div>`;
  if (type === 'table') return `<div class="table-scroll"><table class="document-table"><thead><tr><th>Title</th><th>Customer</th><th>Issue date</th><th>Status</th><th class="number">Total</th><th><span class="sr-only">Open</span></th></tr></thead><tbody>${found.map(item => `<tr><td><a class="table-link" href="#document=${safe(item.id)}" data-action="open" data-id="${safe(item.id)}" aria-label="Open ${safe(item.name || 'Untitled document')}">${safe(item.name || 'Untitled document')}</a></td><td>${safe(item.customer || 'Unnamed customer')}</td><td>${dateLabel(item.date)}</td><td>${badge(item.status, item.saved)}</td><td class="number">${euros(totals(item).total)}</td><td><span aria-hidden="true">${icon('arrow')}</span></td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="document-list ${type}">${found.map(item => `<button type="button" class="document-entry ${state.currentId === item.id ? 'selected' : ''}" data-action="open" data-id="${item.id}"><span class="entry-top"><strong>${safe(item.name || item.customer || 'Untitled document')}</strong><span>${euros(totals(item).total)}</span></span><span class="entry-bottom"><span>${item.id} · ${dateLabel(item.date)}</span>${badge(item.status, item.saved)}</span></button>`).join('')}</div>`;
}

function editorHeading() {
  const current = doc();
  return `<div class="editor-heading"><div><span class="section-label">${variant() === 'B' ? '' : `${current.id} · `}${!current.saved ? 'Unsaved document' : current.status === 'draft' ? 'Editable draft' : 'Fixed snapshot'}</span><h1>${safe(current.name || 'Untitled document')}</h1><p>Issue date ${dateLabel(current.date)}</p></div><div class="editor-actions">${badge(current.status, current.saved)}${!current.saved ? '<button type="button" class="button secondary" data-action="save-draft">Save as draft</button>' : `<button type="button" class="button secondary" data-action="duplicate">${icon('copy')}<span>Duplicate</span></button>`}<button type="button" class="button secondary" data-action="print">${icon('print')}<span>Print</span></button></div></div>`;
}

function metadata() {
  const current = doc();
  const disabled = current.status === 'finalized' ? 'disabled' : '';
  return `<section class="metadata"><div class="section-heading"><h2>Document details</h2><span>01</span></div><div class="metadata-fields"><label>Document name<input name="documentName" value="${safe(current.name)}" placeholder="Enter document name" ${disabled}></label><label>Customer name<input name="customer" value="${safe(current.customer)}" placeholder="Enter customer" ${disabled}></label><label>Issue date<input name="date" type="date" value="${current.date}" ${disabled}></label></div></section>`;
}

function lineItems(style = 'grid') {
  const current = doc();
  const editable = current.status === 'draft';
  return `<section class="line-section ${style}"><div class="section-heading"><h2>Line items</h2><span>02</span></div>
    ${current.lines.map((line, index) => {
      const amount = lineCalc(line);
      const disabled = editable ? '' : 'disabled';
      const remove = editable ? `<button type="button" class="icon-action remove" data-action="remove-line" data-id="${line.id}" aria-label="Remove ${safe(line.name || 'line item')}">${icon('trash')}</button>` : '';
      return `<article class="line-item"><div class="line-header"><span class="line-index">${String(index + 1).padStart(2, '0')}</span><label class="description"><span class="sr-only">Line description</span><input data-line="${line.id}" name="name" value="${safe(line.name)}" placeholder="Item or service" ${disabled}></label>${style === 'ledger' ? '' : remove}</div>
        <div class="line-fields"><label>Qty<input data-line="${line.id}" name="quantity" type="number" min="1" step="1" value="${line.quantity}" ${disabled}></label><label>Unit price €<input data-line="${line.id}" name="price" type="number" min="0" step="0.01" value="${(line.price / 100).toFixed(2)}" ${disabled}></label><label>Discount €<input data-line="${line.id}" name="discount" type="number" min="0" step="0.01" value="${(line.discount / 100).toFixed(2)}" ${disabled}></label><label>Tax %<input data-line="${line.id}" name="tax" type="number" min="0" max="100" step="0.01" value="${(line.tax / 100).toFixed(2)}" ${disabled}></label><div class="line-sum"><span>Line total</span><strong>${euros(amount.total)}</strong></div></div>
        ${style === 'ledger' ? remove : ''}
        <p class="line-math">${euros(amount.subtotal)} subtotal − ${euros(amount.discount)} discount = ${euros(amount.taxable)} taxable + ${euros(amount.tax)} tax</p>
      </article>`;
    }).join('')}
    ${editable ? `<button type="button" class="add-line" data-action="add-line">${icon('plus')} Add line item</button>` : ''}
  </section>`;
}

function amountBreakdown(kind = 'panel') {
  const amount = totals(doc());
  return `<section class="breakdown ${kind}" aria-label="Document arithmetic"><div class="section-heading"><h2>Arithmetic</h2><span>03</span></div><dl class="amount-list"><div><dt>Line subtotals</dt><dd>${euros(amount.subtotal)}</dd></div><div><dt>Line discounts</dt><dd>−${euros(amount.discount)}</dd></div><div><dt>Taxable amount</dt><dd>${euros(amount.taxable)}</dd></div><div><dt>Sum of line taxes</dt><dd>${euros(amount.tax)}</dd></div></dl><div class="grand-total"><span>Document total</span><strong>${euros(amount.total)}</strong></div><p class="calculation-note">Tax is rounded for each line, then summed.</p>${doc().status === 'draft' ? `<button type="button" class="button primary wide" data-action="finalize">Finalize document ${icon('arrow')}</button><p class="finalize-note">Finalization fixes this document permanently.</p>` : '<p class="snapshot-note">Finalized snapshot. Duplicate to make changes.</p>'}</section>`;
}

function dashboardA() {
  const current = doc();
  return `<div class="a-dashboard"><div class="a-list-pane"><div class="pane-heading"><div><span class="section-label">Workspace</span><h1>Documents</h1></div><span class="count">${state.docs.filter(item => item.saved).length}</span></div>${filters(true)}${documentRows('rail')}<div class="rail-foot">25 per page in production · ${filteredDocs().length} shown here</div></div><div class="a-overview"><div class="overview-head"><div><span class="section-label">Selected document</span><h2>${safe(current.name || 'Untitled document')}</h2><p>${current.id} · ${dateLabel(current.date)}</p></div>${newButton()}</div><div class="a-selected-status">${badge(current.status, current.saved)}<button type="button" class="button secondary" data-action="open" data-id="${current.id}">Open document ${icon('arrow')}</button></div><div class="a-preview-heading"><h3>Line items</h3><span>${current.lines.length} items</span></div><div class="a-preview-lines">${current.lines.map(line => `<div><span>${safe(line.name || 'Unnamed item')}</span><span>${line.quantity} × ${euros(line.price)}</span><strong>${euros(lineCalc(line).total)}</strong></div>`).join('') || '<p>No line items yet.</p>'}</div><div class="a-preview-total"><span>Document total</span><strong>${euros(totals(current).total)}</strong></div></div><aside class="a-report-pane">${report()}</aside></div>`;
}
function editorA() {
  return `<div class="a-editor"><aside class="a-document-rail"><div class="rail-title"><span class="section-label">Documents</span><button type="button" class="icon-action" data-action="view" data-view="dashboard" aria-label="Back to dashboard">${icon('back')}</button></div>${documentRows('rail')}</aside><main class="a-editor-main">${editorHeading()}${metadata()}${lineItems()}</main><aside class="a-inspector">${amountBreakdown()}</aside></div>`;
}
function renderA() {
  return `<div class="shell variant-a"><header class="app-topbar"><div class="brand">${title()}</div><nav aria-label="Main navigation">${navButton('dashboard', 'Documents', 'file')}${navButton('editor', 'Editor', 'chart')}</nav><span class="prototype-tag">Layout A · Workbench</span><div class="profile">SA</div></header>${notice()}${state.view === 'dashboard' ? dashboardA() : editorA()}</div>`;
}

function dashboardB() {
  return `<div class="b-dashboard-shell ${state.summaryOpen ? 'summary-open' : ''}"><main class="b-dashboard"><div class="b-title"><div><span class="section-label">Pricing documents</span><h1>Documents</h1><p>Find and continue your customer work.</p></div><div class="b-title-actions"><button type="button" class="button secondary" data-action="toggle-summary" aria-controls="b-summary-sidebar" aria-expanded="${state.summaryOpen}">${icon('chart')}<span>Generate Summary</span></button>${newButton()}</div></div><div class="b-list-heading"><h2>All documents</h2><span>${filteredDocs().length} shown</span></div>${filters()}${documentRows('table')}<p class="pagination-note">Page 1 · 25 documents per page in production</p></main><aside class="b-summary-sidebar" id="b-summary-sidebar" aria-label="Summary report" ${state.summaryOpen ? '' : 'hidden'}><div class="b-summary-sidebar-head"><span>Generated summary</span><button type="button" class="icon-action" data-action="toggle-summary" aria-label="Close summary">×</button></div>${report()}</aside></div>`;
}
function editorB() {
  return `<main class="b-editor"><button type="button" class="back-link" data-action="view" data-view="dashboard">${icon('back')} All documents</button>${editorHeading()}<div class="b-editor-content">${metadata()}${lineItems('ledger')}${amountBreakdown('band')}</div></main>`;
}
function renderB() {
  return `<div class="shell variant-b"><header class="b-topbar"><div class="brand">${title()}</div><nav aria-label="Main navigation">${navButton('dashboard', 'Documents', 'file')}</nav><span class="prototype-tag">Layout B · Ledger</span><div class="profile">SA</div></header>${notice()}${state.view === 'dashboard' ? dashboardB() : editorB()}</div>`;
}

function dashboardC() {
  return `<div class="c-dashboard"><aside class="c-nav"><div class="brand">${title()}</div><nav aria-label="Main navigation">${navButton('dashboard', 'Documents', 'file')}${navButton('editor', 'Editor', 'chart')}</nav><div class="c-nav-foot">Pricing documents<br><span>Layout C · Document view</span></div></aside><main class="c-main"><div class="c-title"><span class="section-label">Workspace / Documents</span><div class="c-title-line"><h1>Documents</h1>${newButton()}</div></div><div class="c-dashboard-body"><section class="c-list"><h2>Find a document</h2>${filters()}${documentRows('cards')}<p class="pagination-note">${filteredDocs().length} shown · 25 per page in production</p></section><aside>${report()}</aside></div></main></div>`;
}
function editorC() {
  return `<div class="c-dashboard"><aside class="c-nav"><div class="brand">${title()}</div><nav aria-label="Main navigation">${navButton('dashboard', 'Documents', 'file')}${navButton('editor', 'Editor', 'chart')}</nav><div class="c-nav-foot">Pricing documents<br><span>Layout C · Document view</span></div></aside><main class="c-main c-editor-main"><button type="button" class="back-link" data-action="view" data-view="dashboard">${icon('back')} All documents</button><div class="c-editor-layout"><article class="document-page">${editorHeading()}${metadata()}${lineItems('page-lines')}<div class="page-total">${amountBreakdown('page')}</div></article><aside class="c-context"><div class="context-sticky"><span class="section-label">Current document</span><h2>${safe(doc().id)}</h2>${badge(doc().status, doc().saved)}<p>${doc().status === 'draft' ? 'Edit the document on the page. Totals update as you type.' : 'This document is fixed. Duplicate it to begin a new draft.'}</p><div class="context-actions">${doc().saved ? `<button type="button" class="button secondary" data-action="duplicate">${icon('copy')} Duplicate</button>` : '<button type="button" class="button secondary" data-action="save-draft">Save as draft</button>'}<button type="button" class="button secondary" data-action="print">${icon('print')} Print</button></div><div class="context-total"><span>Total</span><strong>${euros(totals(doc()).total)}</strong></div></div></aside></div></main></div>`;
}
function renderC() { return `<div class="shell variant-c">${notice()}${state.view === 'dashboard' ? dashboardC() : editorC()}</div>`; }

function render() {
  const choice = variant();
  app.innerHTML = choice === 'A' ? renderA() : choice === 'B' ? renderB() : renderC();
  document.querySelector('#variant-name').textContent = `${choice} · ${variants[choice]}`;
  document.body.dataset.variant = choice;
}

function setVariant(direction) {
  const keys = Object.keys(variants);
  const next = keys[(keys.indexOf(variant()) + direction + keys.length) % keys.length];
  const url = new URL(location.href);
  url.searchParams.set('variant', next);
  history.replaceState(null, '', url);
  render();
}

document.querySelector('#variant-prev').addEventListener('click', () => setVariant(-1));
document.querySelector('#variant-next').addEventListener('click', () => setVariant(1));
document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
  if (event.key === 'ArrowLeft') setVariant(-1);
  if (event.key === 'ArrowRight') setVariant(1);
});

app.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  if (control.tagName === 'A') event.preventDefault();
  const action = control.dataset.action;
  state.notice = '';
  state.noticeTargetId = null;
  if (action === 'view') {
    state.view = control.dataset.view;
    if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  if (action === 'open') {
    state.currentId = control.dataset.id;
    state.view = 'editor';
    if (control.tagName === 'A') history.pushState(null, '', control.getAttribute('href'));
    else if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  if (action === 'toggle-summary') state.summaryOpen = !state.summaryOpen;
  if (action === 'new') {
    const id = `PD-${state.nextId++}`;
    state.docs.unshift({ id, name: '', saved: false, customer: '', date: localToday(), status: 'draft', lines: [] });
    state.currentId = id; state.view = 'editor';
    if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  if (action === 'duplicate') {
    const source = doc();
    if (!source.saved) return;
    const copy = structuredClone(source);
    copy.id = `PD-${state.nextId++}`;
    copy.status = 'draft';
    copy.saved = true;
    copy.date = localToday();
    copy.lines.forEach(line => { line.id = state.nextLineId++; });
    state.docs.unshift(copy);
    state.notice = `Created an editable copy of “${source.name || 'Untitled document'}”.`;
    state.noticeTargetId = copy.id;
  }
  if (action === 'save-draft') {
    doc().saved = true;
    state.notice = `“${doc().name || 'Untitled document'}” saved as draft.`;
  }
  if (action === 'add-line') doc().lines.push({ id: state.nextLineId++, name: '', quantity: 1, price: 0, discount: 0, tax: 0 });
  if (action === 'remove-line') doc().lines = doc().lines.filter(line => String(line.id) !== control.dataset.id);
  if (action === 'finalize') {
    const current = doc();
    if (!current.customer.trim() || !current.date || !current.lines.length || current.lines.some(line => !line.name.trim())) state.notice = 'Add a customer, issue date, and named line item before finalizing.';
    else { current.status = 'finalized'; current.saved = true; state.notice = `“${current.name || 'Untitled document'}” finalized. Its details are now fixed.`; }
  }
  if (action === 'clear-filters') { state.search = ''; state.status = 'all'; state.listStart = ''; state.listEnd = ''; }
  if (action === 'print') { window.print(); return; }
  render();
});

app.addEventListener('input', event => {
  const target = event.target;
  if (target.name === 'search') {
    state.search = target.value;
    const position = target.selectionStart;
    render();
    const next = app.querySelector('[name="search"]');
    next.focus(); next.setSelectionRange(position, position);
    return;
  }
  if (target.dataset.line) {
    const line = doc().lines.find(item => String(item.id) === target.dataset.line);
    if (!line) return;
    const value = Number(target.value);
    if (target.name === 'name') line.name = target.value;
    if (target.name === 'quantity' && Number.isInteger(value) && value >= 1) line.quantity = value;
    if (target.name === 'price' && value >= 0) line.price = Math.round(value * 100);
    if (target.name === 'discount' && value >= 0 && Math.round(value * 100) <= line.quantity * line.price) line.discount = Math.round(value * 100);
    if (target.name === 'tax' && value >= 0 && value <= 100) line.tax = Math.round(value * 100);
    const focus = { line: target.dataset.line, name: target.name, start: target.selectionStart };
    render();
    const next = app.querySelector(`[data-line="${focus.line}"][name="${focus.name}"]`);
    next?.focus();
    if (focus.name === 'name') next?.setSelectionRange(focus.start, focus.start);
    return;
  }
  if (target.name === 'documentName') {
    doc().name = target.value;
    app.querySelector('.editor-heading h1').textContent = target.value || 'Untitled document';
  }
  if (target.name === 'customer') doc().customer = target.value;
  if (target.name === 'date') {
    doc().date = target.value;
    app.querySelector('.editor-heading p').textContent = `Issue date ${dateLabel(target.value)}`;
  }
  if (['reportStart', 'reportEnd', 'listStart', 'listEnd'].includes(target.name)) { state[target.name] = target.value; render(); }
});

app.addEventListener('change', event => {
  const target = event.target;
  if (['status', 'sort'].includes(target.name)) { state[target.name] = target.value; render(); }
  if (target.name === 'date') {
    doc().date = target.value;
    app.querySelector('.editor-heading p').textContent = `Issue date ${dateLabel(target.value)}`;
  }
});

render();
