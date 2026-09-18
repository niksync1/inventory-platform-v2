export function createTenantRequestId(now = Date.now(), random = Math.random()): string {
  return `tenant-${now.toString(36)}-${random.toString(36).slice(2, 12)}`;
}
