export type QuantityValidationResult =
  | { valid: true; quantity: number }
  | { valid: false; reason: string };

const POSITIVE_INTEGER = /^[1-9]\d*$/;

export function validateQuantity(value: string): QuantityValidationResult {
  const normalized = value.trim();
  if (!POSITIVE_INTEGER.test(normalized)) {
    return { valid: false, reason: 'Enter a whole number greater than zero.' };
  }
  const quantity = Number(normalized);
  if (!Number.isSafeInteger(quantity)) {
    return { valid: false, reason: 'Quantity is too large.' };
  }
  return { valid: true, quantity };
}
