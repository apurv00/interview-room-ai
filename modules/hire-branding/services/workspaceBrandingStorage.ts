import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  HIRE_WORKSPACE_LOGO_CONTENT_TYPES,
  type HireWorkspaceLogoContentType,
} from '../../hire/models/HireWorkspace'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const WORKSPACE_LOGO_KEY = /^hire-workspace-branding\/([a-f0-9]{24})\/logo$/i

/** Keep the dashboard identity image intentionally small and non-sensitive. */
export const HIRE_WORKSPACE_LOGO_MAX_BYTES = 512 * 1024

export interface HireWorkspaceBrandingStoragePort {
  upload(input: {
    key: string
    body: Buffer | Uint8Array
    contentType: HireWorkspaceLogoContentType
  }): Promise<void>
  download(input: { key: string }): Promise<Buffer>
  delete(input: { key: string }): Promise<void>
}

export class InvalidHireWorkspaceBrandingKeyError extends Error {
  constructor() {
    super('Hire workspace branding key is outside the authorized scope')
  }
}

function r2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are not configured')
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
}

function bucket(): string {
  const value = process.env.R2_BUCKET_NAME
  if (!value) throw new Error('R2_BUCKET_NAME is not configured')
  return value
}

function assertWorkspaceId(workspaceId: string): void {
  if (!OBJECT_ID.test(workspaceId)) throw new InvalidHireWorkspaceBrandingKeyError()
}

export function hireWorkspaceLogoKey(workspaceId: string): string {
  assertWorkspaceId(workspaceId)
  return `hire-workspace-branding/${workspaceId}/logo`
}

export function parseHireWorkspaceLogoKey(key: string): { workspaceId: string } | null {
  if (!key || key.length > 1000 || key.includes('%') || key.includes('\\')) return null
  const match = WORKSPACE_LOGO_KEY.exec(key)
  return match ? { workspaceId: match[1] } : null
}

export function assertHireWorkspaceLogoKeyScope(key: string, workspaceId: string): void {
  assertWorkspaceId(workspaceId)
  const parsed = parseHireWorkspaceLogoKey(key)
  if (!parsed || parsed.workspaceId !== workspaceId) {
    throw new InvalidHireWorkspaceBrandingKeyError()
  }
}

function assertLogoBytes(body: Buffer | Uint8Array): void {
  if (!body.byteLength || body.byteLength > HIRE_WORKSPACE_LOGO_MAX_BYTES) {
    throw new Error('Hire workspace logo size is outside the allowed range')
  }
}

function assertLogoContentType(contentType: string): asserts contentType is HireWorkspaceLogoContentType {
  if (!(HIRE_WORKSPACE_LOGO_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw new Error('Hire workspace logo content type is not allowed')
  }
}

/**
 * A deterministic, workspace-scoped key means a replacement overwrites the
 * prior logo instead of leaving a second private object to clean up. The
 * workspace hard-purge always deletes this exact key, even if a request races
 * a lifecycle transition before metadata can be persisted.
 */
export const hireWorkspaceBrandingStorage: HireWorkspaceBrandingStoragePort = {
  async upload({ key, body, contentType }) {
    if (!parseHireWorkspaceLogoKey(key)) throw new InvalidHireWorkspaceBrandingKeyError()
    assertLogoBytes(body)
    assertLogoContentType(contentType)
    await r2Client().send(new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'private, no-store',
      ContentDisposition: 'inline',
    }))
  },

  async download({ key }) {
    if (!parseHireWorkspaceLogoKey(key)) throw new InvalidHireWorkspaceBrandingKeyError()
    const response = await r2Client().send(new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseCacheControl: 'private, no-store',
    }))
    if (!response.Body) throw new Error('Hire workspace logo object is unavailable')
    const body = Buffer.from(await response.Body.transformToByteArray())
    assertLogoBytes(body)
    return body
  },

  async delete({ key }) {
    if (!parseHireWorkspaceLogoKey(key)) throw new InvalidHireWorkspaceBrandingKeyError()
    await r2Client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
  },
}

export function isHireWorkspaceBrandingStorageConfigured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME,
  )
}
