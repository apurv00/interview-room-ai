import { createHash } from 'node:crypto'
import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_WORKSPACE_SIGN_IN_SLUG_MIN_LENGTH = 2
export const HIRE_WORKSPACE_SIGN_IN_SLUG_MAX_LENGTH = 48
export const HIRE_WORKSPACE_SIGN_IN_SLUG_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_NAME =
  'uniq_hire_workspace_sign_in_slug'
export const HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_KEY = {
  signInSlug: 1,
} as const
export const HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_PARTIAL = {
  signInSlug: { $type: 'string' },
} as const

export const HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME =
  'uniq_hire_workspace_sign_in_reservation_workspace'
export const HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_KEY = {
  workspaceId: 1,
} as const
export const HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_PARTIAL = {
  state: 'active',
  workspaceId: { $type: 'objectId' },
} as const

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'apply',
  'auth',
  'hire',
  'login',
  'settings',
  'support',
  'system',
  'workspace',
  'www',
])

export type HireWorkspaceSignInSlugReservationState = 'active' | 'retired'

export interface IHireWorkspaceSignInSlug extends Document<string> {
  _id: string
  slug?: string
  workspaceId?: mongoose.Types.ObjectId
  state: HireWorkspaceSignInSlugReservationState
  retiredAt?: Date
  createdAt: Date
  updatedAt: Date
}

function isAllowedSignInSlug(value: string): boolean {
  return (
    value.length >= HIRE_WORKSPACE_SIGN_IN_SLUG_MIN_LENGTH &&
    value.length <= HIRE_WORKSPACE_SIGN_IN_SLUG_MAX_LENGTH &&
    HIRE_WORKSPACE_SIGN_IN_SLUG_PATTERN.test(value) &&
    !OBJECT_ID_PATTERN.test(value) &&
    !value.startsWith('xn--') &&
    !RESERVED_SLUGS.has(value)
  )
}

/** Parse an exact user-facing workspace slug without fuzzy company lookup. */
export function parseHireWorkspaceSignInSlug(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return isAllowedSignInSlug(normalized) ? normalized : null
}

function trimSlug(value: string): string {
  return value
    .slice(0, HIRE_WORKSPACE_SIGN_IN_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '')
}

/** Generate the readable portion of a slug from a company display name. */
export function hireWorkspaceSignInSlugBase(companyName: string): string {
  const normalized = trimSlug(
    companyName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-'),
  )
  const candidate = normalized.length >= HIRE_WORKSPACE_SIGN_IN_SLUG_MIN_LENGTH
    ? normalized
    : 'company'
  if (isAllowedSignInSlug(candidate)) return candidate
  return trimSlug(`company-${candidate}`)
}

function withSuffix(base: string, suffix: string): string {
  const maxBaseLength =
    HIRE_WORKSPACE_SIGN_IN_SLUG_MAX_LENGTH - suffix.length - 1
  const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/g, '') || 'company'
  return `${trimmedBase}-${suffix}`
}

/** Ordered candidates make collision handling deterministic and bounded. */
export function hireWorkspaceSignInSlugCandidates(
  companyName: string,
  workspaceId: string | mongoose.Types.ObjectId,
): readonly string[] {
  const id = workspaceId.toString().toLowerCase()
  const base = hireWorkspaceSignInSlugBase(companyName)
  return [
    base,
    withSuffix(base, id.slice(-8)),
    withSuffix(base, id.slice(-12)),
    withSuffix('workspace', id),
  ]
}

/** Hash is the permanent non-reusable coordinate after a workspace is purged. */
export function hireWorkspaceSignInSlugHash(slug: string): string {
  return createHash('sha256').update(slug).digest('hex')
}

const HireWorkspaceSignInSlugSchema =
  new Schema<IHireWorkspaceSignInSlug>(
    {
      _id: { type: String, required: true },
      slug: {
        type: String,
        minlength: HIRE_WORKSPACE_SIGN_IN_SLUG_MIN_LENGTH,
        maxlength: HIRE_WORKSPACE_SIGN_IN_SLUG_MAX_LENGTH,
        match: HIRE_WORKSPACE_SIGN_IN_SLUG_PATTERN,
        validate: {
          validator: (value: string) =>
            parseHireWorkspaceSignInSlug(value) === value,
          message: 'Invalid workspace sign-in slug',
        },
      },
      workspaceId: { type: Schema.Types.ObjectId },
      state: {
        type: String,
        enum: ['active', 'retired'],
        required: true,
        default: 'active',
      },
      retiredAt: { type: Date },
    },
    {
      timestamps: true,
      // The explicit preparer owns the workspace-reservation index. Runtime
      // creation still works before backfill because Mongo always enforces the
      // hashed `_id`, but model initialization must never race preflight.
      autoIndex: false,
    },
  )

HireWorkspaceSignInSlugSchema.index(
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_KEY,
  {
    name: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
    unique: true,
    partialFilterExpression: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_PARTIAL,
  },
)

export const HireWorkspaceSignInSlug: Model<IHireWorkspaceSignInSlug> =
  mongoose.models.HireWorkspaceSignInSlug ||
  mongoose.model<IHireWorkspaceSignInSlug>(
    'HireWorkspaceSignInSlug',
    HireWorkspaceSignInSlugSchema,
  )
