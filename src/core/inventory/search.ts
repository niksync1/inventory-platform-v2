export function normalizeProductSearch(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80);
}
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}
export function mergeUniqueById<T extends { id: string }>(...groups: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) for (const item of group) merged.set(item.id, item);
  return [...merged.values()];
}
