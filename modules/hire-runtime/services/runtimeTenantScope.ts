import { HireRuntimeBinding } from '../models/HireRuntimeBinding'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i

/**
 * The unchanged engine calls this field `organizationId`; in the isolated
 * Hire runtime it always contains the owning Hire workspace id.
 */
export function requireRuntimeWorkspaceId(value: unknown): string {
  const candidate =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'toString' in value
        ? String(value)
        : ''
  if (!OBJECT_ID_PATTERN.test(candidate)) {
    throw new Error('Runtime workspace authority is unavailable')
  }
  return candidate.toLowerCase()
}

/**
 * The sole unscoped runtime-binding discovery operation. Scheduled work first
 * enumerates tenant ids, then performs every data-bearing query inside one of
 * those explicit workspace scopes.
 */
export async function enumerateRuntimeWorkspaceIds(): Promise<string[]> {
  const values = await HireRuntimeBinding.distinct('workspaceId', {
    workspaceId: { $exists: true },
  })
  return Array.from(
    new Set(values.map((value) => requireRuntimeWorkspaceId(value))),
  ).sort()
}
