import React from 'react';
import { PrototypeIcon } from '../PrototypeIcon.js';
import { formatEuro } from '../formatting.js';
import type { EditableLineField, LinePreview, LineValues } from './model.js';

type LineItemProps = {
  line: LineValues;
  index: number;
  preview: LinePreview;
  errors: Partial<Record<EditableLineField, string>>;
  submitted: boolean;
  canEdit: boolean;
  canMutate: boolean;
  lineCount: number;
  onChange: (key: string, field: EditableLineField, value: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onRemove: (key: string) => void;
};

export function LineItem({ line, index, preview, errors, submitted, canEdit, canMutate, lineCount, onChange, onMove, onRemove }: LineItemProps): React.JSX.Element {
  const field = (name: Exclude<EditableLineField, 'description'>, label: string, inputMode: 'numeric' | 'decimal'): React.JSX.Element => {
    const error = errors[name]
      ?? (submitted ? preview.errors[name] : undefined);
    const inputId = `line-${line.key}-${name}`;
    const errorId = `${inputId}-error`;
    return (
      <div className="field" key={name}>
        <label htmlFor={inputId}>{label}</label>
        <input
          id={inputId}
          inputMode={inputMode}
          autoComplete="off"
          value={line[name]}
          disabled={!canMutate}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onChange={event => {
            const value = event.currentTarget.value;
            // Permit partial edits, but never whitespace, exponents, or repeated separators/signs.
            // Final validation still checks required values, precision, and range.
            const syntax = inputMode === 'numeric' ? /^[+-]?\d*$/ : /^[+-]?\d*(?:[.,]\d*)?$/;
            if (syntax.test(value)) onChange(line.key, name, value);
          }}
        />
        <span className="print-value">{line[name]}</span>
        {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
      </div>
    );
  };
  return (
    <article className="line-item" data-testid="line-item" key={line.key}>
      <div className="line-header">
        <span className="line-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="field line-description">
          <label className="visually-hidden" htmlFor={`line-${line.key}-description`}>Line description</label>
          <input
            id={`line-${line.key}-description`}
            placeholder="Item or service"
            value={line.description}
            disabled={!canMutate}
            aria-invalid={Boolean(errors.description)}
            aria-describedby={errors.description ? `line-${line.key}-description-error` : undefined}
            onChange={event => onChange(line.key, 'description', event.currentTarget.value)}
          />
          <span className="print-value">{line.description}</span>
          {errors.description && <p className="field-error" id={`line-${line.key}-description-error`} role="alert">{errors.description}</p>}
        </div>
      </div>
      <div className="line-fields">
        {field('quantity', 'Qty', 'numeric')}
        {field('unitPrice', 'Unit price €', 'decimal')}
        {field('discount', 'Discount €', 'decimal')}
        {field('taxRate', 'Tax %', 'decimal')}
        <div className="line-sum">
          <span>Line total</span>
          <strong>{preview.amounts ? formatEuro(preview.amounts.totalCents) : '—'}</strong>
        </div>
      </div>
      {canEdit && <div className="line-actions" aria-label={`Line ${index + 1} actions`}>
          <button
            className="line-action"
            type="button"
            aria-label={`Move line ${index + 1} up`}
            disabled={!canMutate || index === 0}
            onClick={() => onMove(line.key, -1)}
          >↑</button>
          <button
            className="line-action"
            type="button"
            aria-label={`Move line ${index + 1} down`}
            disabled={!canMutate || index === lineCount - 1}
            onClick={() => onMove(line.key, 1)}
          >↓</button>
          <button
            className="line-action remove-line"
            type="button"
            aria-label={`Remove line ${index + 1}`}
            disabled={!canMutate}
            onClick={() => onRemove(line.key)}
          ><PrototypeIcon name="trash" /></button>
      </div>}
      <p className="line-math">
        {preview.amounts
          ? `${formatEuro(preview.amounts.subtotalCents)} subtotal − ${formatEuro(preview.amounts.discountCents)} discount = ${formatEuro(preview.amounts.taxableCents)} taxable + ${formatEuro(preview.amounts.taxCents)} tax`
          : 'Enter valid numeric values to calculate line amounts.'}
      </p>
    </article>
  );
}
