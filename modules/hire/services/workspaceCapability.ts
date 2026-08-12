const OBJECT_ID = /^[a-f0-9]{24}$/i
const SECRET = /^[a-f0-9]{64}$/i

export interface WorkspaceCapability {
  workspaceId: string
  secret: string
}

export interface WorkspaceResourceCapability extends WorkspaceCapability {
  resourceId: string
}

/**
 * Capability wire format used by public Hire entry points. The workspace
 * coordinate is authenticated by the unguessable secret: moving a capability
 * to another workspace makes its scoped hash lookup fail.
 */
export function encodeWorkspaceCapability(
  workspaceId: string,
  secret: string,
): string {
  const normalizedWorkspaceId = workspaceId.toLowerCase()
  const normalizedSecret = secret.toLowerCase()
  if (!OBJECT_ID.test(normalizedWorkspaceId) || !SECRET.test(normalizedSecret)) {
    throw new Error('Invalid workspace capability coordinate')
  }
  return `${normalizedWorkspaceId}.${normalizedSecret}`
}

export function decodeWorkspaceCapability(raw: unknown): WorkspaceCapability | null {
  if (typeof raw !== 'string') return null
  const [workspaceId, secret, extra] = raw.trim().split('.')
  if (extra !== undefined || !OBJECT_ID.test(workspaceId) || !SECRET.test(secret)) {
    return null
  }
  return {
    workspaceId: workspaceId.toLowerCase(),
    secret: secret.toLowerCase(),
  }
}

export function encodeWorkspaceResourceCapability(
  workspaceId: string,
  resourceId: string,
  secret: string,
): string {
  const base = encodeWorkspaceCapability(workspaceId, secret)
  const normalizedResourceId = resourceId.toLowerCase()
  if (!OBJECT_ID.test(normalizedResourceId)) {
    throw new Error('Invalid workspace resource coordinate')
  }
  const [normalizedWorkspaceId, normalizedSecret] = base.split('.')
  return `${normalizedWorkspaceId}.${normalizedResourceId}.${normalizedSecret}`
}

export function decodeWorkspaceResourceCapability(
  raw: unknown,
): WorkspaceResourceCapability | null {
  if (typeof raw !== 'string') return null
  const [workspaceId, resourceId, secret, extra] = raw.trim().split('.')
  if (
    extra !== undefined ||
    !OBJECT_ID.test(workspaceId) ||
    !OBJECT_ID.test(resourceId) ||
    !SECRET.test(secret)
  ) {
    return null
  }
  return {
    workspaceId: workspaceId.toLowerCase(),
    resourceId: resourceId.toLowerCase(),
    secret: secret.toLowerCase(),
  }
}

export const __workspaceCapability = { OBJECT_ID, SECRET }
