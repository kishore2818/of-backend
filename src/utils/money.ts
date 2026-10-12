/**
 * Utilities for precise currency arithmetic using integer cents.
 */
export function toCents(amount: number | string): number {
  if (typeof amount === 'string') {
    const parsed = parseFloat(amount.trim());
    if (isNaN(parsed)) return 0;
    return Math.round(parsed * 100);
  }
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

export function formatMoney(amount: number): string {
  return amount.toFixed(2);
}

export function addMoney(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

export function subtractMoney(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}
