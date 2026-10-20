import { isCalendarDate } from '../shared/document-validation.js';

export function localToday(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localMonthRange(): { start: string; end: string } {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const monthString = String(month + 1).padStart(2, '0');
  const lastDay = new Date(year, month + 1, 0).getDate();
  return {
    start: `${year}-${monthString}-01`,
    end: `${year}-${monthString}-${String(lastDay).padStart(2, '0')}`,
  };
}

export function formatDate(value: string): string {
  if (!isCalendarDate(value)) return 'Date not set';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(year, month - 1, day));
}

const EURO_WHOLE_FORMATTER = new Intl.NumberFormat('en-IE', {
  style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const EURO_DECIMAL_SEPARATOR = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 1 })
  .formatToParts(1.1)
  .find(part => part.type === 'decimal')?.value ?? '.';

export function formatEuro(cents: number): string {
  const signed = BigInt(cents);
  const negative = signed < 0n;
  const absolute = negative ? -signed : signed;
  const wholeEuros = Number(absolute / 100n);
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '−' : ''}${EURO_WHOLE_FORMATTER.format(wholeEuros)}${EURO_DECIMAL_SEPARATOR}${fraction}`;
}
