import { AppError, ForbiddenError, NotFoundError } from '@shared/errors'
import {
  HireWorkspace,
  activeHireWorkspaceLifecycleFilter,
  connectHireControlDB,
  type IHireWorkspace,
  type HireWorkspaceLogoContentType,
  type MembershipContext,
} from '../boundary'
import {
  HIRE_WORKSPACE_LOGO_MAX_BYTES,
  hireWorkspaceBrandingStorage,
  hireWorkspaceLogoKey,
  type HireWorkspaceBrandingStoragePort,
} from './workspaceBrandingStorage'

const DATA_URL_PREFIX = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/

export interface HireWorkspaceLogoUploadInput {
  /** A browser FileReader data URL; decoded and validated server-side. */
  dataUrl: string
}

export interface HireWorkspaceLogoView {
  bytes: Buffer
  contentType: HireWorkspaceLogoContentType
  updatedAt: Date
}

function requireWorkspaceAdmin(ctx: MembershipContext): void {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can change company branding')
  }
}

function detectedContentType(bytes: Buffer): HireWorkspaceLogoContentType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** Decode only a bounded base64 image and bind its claimed MIME type to bytes. */
export function decodeHireWorkspaceLogoDataUrl(input: string): {
  bytes: Buffer
  contentType: HireWorkspaceLogoContentType
} {
  const match = DATA_URL_PREFIX.exec(input)
  if (!match) throw new AppError('Upload a PNG, JPEG, or WebP company logo', 400, 'INVALID_COMPANY_LOGO')
  const encoded = match[2]
  // Check before decoding so a giant valid base64 string cannot allocate an
  // unbounded Buffer in the request process.
  if (encoded.length > Math.ceil((HIRE_WORKSPACE_LOGO_MAX_BYTES * 4) / 3) + 4) {
    throw new AppError('Company logo must be 512 KB or smaller', 413, 'COMPANY_LOGO_TOO_LARGE')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > HIRE_WORKSPACE_LOGO_MAX_BYTES ||
    bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
  ) throw new AppError('Company logo must be a valid image under 512 KB', 400, 'INVALID_COMPANY_LOGO')
  const contentType = detectedContentType(bytes)
  if (!contentType || contentType !== match[1]) {
    throw new AppError('Company logo file type does not match its contents', 400, 'INVALID_COMPANY_LOGO')
  }
  return { bytes, contentType }
}

export async function uploadHireWorkspaceLogo(
  ctx: MembershipContext,
  input: HireWorkspaceLogoUploadInput,
  options: { storage?: HireWorkspaceBrandingStoragePort; now?: Date } = {},
): Promise<IHireWorkspace> {
  requireWorkspaceAdmin(ctx)
  const logo = decodeHireWorkspaceLogoDataUrl(input.dataUrl)
  const workspaceId = ctx.workspace._id.toString()
  const storage = options.storage ?? hireWorkspaceBrandingStorage
  const now = options.now ?? new Date()
  await connectHireControlDB()
  const activeBeforeUpload = await HireWorkspace.exists({
    _id: ctx.workspace._id,
    ...activeHireWorkspaceLifecycleFilter(),
  })
  if (!activeBeforeUpload) throw new NotFoundError('Workspace')

  const key = hireWorkspaceLogoKey(workspaceId)
  await storage.upload({ key, body: logo.bytes, contentType: logo.contentType })
  const workspace = await HireWorkspace.findOneAndUpdate(
    { _id: ctx.workspace._id, ...activeHireWorkspaceLifecycleFilter() },
    { $set: { companyLogo: { contentType: logo.contentType, byteSize: logo.bytes.byteLength, updatedAt: now } } },
    { new: true },
  )
  if (workspace) return workspace
  // The deterministic key remains an exact cleanup coordinate for a pending
  // workspace purge. Eagerly remove a logo whose metadata update lost the
  // lifecycle race; the hard purge is still a durable fallback.
  await storage.delete({ key }).catch(() => undefined)
  throw new NotFoundError('Workspace')
}

export async function readHireWorkspaceLogo(
  ctx: MembershipContext,
  options: { storage?: HireWorkspaceBrandingStoragePort } = {},
): Promise<HireWorkspaceLogoView | null> {
  const workspaceId = ctx.workspace._id.toString()
  const storage = options.storage ?? hireWorkspaceBrandingStorage
  await connectHireControlDB()
  const workspace = await HireWorkspace.findOne({
    _id: ctx.workspace._id,
    ...activeHireWorkspaceLifecycleFilter(),
  }).select('companyLogo')
  if (!workspace) throw new NotFoundError('Workspace')
  if (!workspace.companyLogo) return null

  const bytes = await storage.download({ key: hireWorkspaceLogoKey(workspaceId) })
  // Do not release bytes fetched just before a deletion transition.
  const stillActive = await HireWorkspace.exists({
    _id: ctx.workspace._id,
    ...activeHireWorkspaceLifecycleFilter(),
  })
  if (!stillActive) throw new NotFoundError('Workspace')
  return { bytes, contentType: workspace.companyLogo.contentType, updatedAt: workspace.companyLogo.updatedAt }
}
