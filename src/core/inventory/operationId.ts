export function createOperationId(now = Date.now(), random = Math.random()): string {
  return `mobile-${now.toString(36)}-${random.toString(36).slice(2, 12)}`;
}
