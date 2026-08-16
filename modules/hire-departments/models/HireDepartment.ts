import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_DEPARTMENT_STATUSES = ['active', 'archived'] as const
export type HireDepartmentStatus = (typeof HIRE_DEPARTMENT_STATUSES)[number]

export const HIRE_DEPARTMENT_KINDS = ['standard', 'legacy', 'onboarding'] as const
export type HireDepartmentKind = (typeof HIRE_DEPARTMENT_KINDS)[number]

export const HIRE_SYSTEM_DEPARTMENT_KINDS = ['legacy', 'onboarding'] as const
export type HireSystemDepartmentKind = (typeof HIRE_SYSTEM_DEPARTMENT_KINDS)[number]

/**
 * These catalog rows are not user-selectable. `legacy` is the migration
 * landing place for pre-catalog jobs; `onboarding` scopes synthetic practice
 * jobs so they never masquerade as a real department in job authoring.
 */
export const HIRE_SYSTEM_DEPARTMENT_NAMES: Record<HireSystemDepartmentKind, string> = {
  legacy: 'Unclassified legacy jobs',
  onboarding: 'Practice and test drives',
}

export interface IHireDepartment extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  name: string
  normalizedName: string
  kind: HireDepartmentKind
  /** Present only on system-managed catalog rows. */
  systemKey?: HireSystemDepartmentKind
  status: HireDepartmentStatus
  archivedAt?: Date
  archivedByMemberId?: mongoose.Types.ObjectId
  archivedByName?: string
  createdByMemberId?: mongoose.Types.ObjectId
  createdByName?: string
  createdAt: Date
  updatedAt: Date
}

const HireDepartmentSchema = new Schema<IHireDepartment>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    // This is deliberately persisted rather than relying on a database
    // collation: it gives the migration and every control-plane command the
    // same exact workspace-local uniqueness coordinate.
    normalizedName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
      immutable: true,
    },
    kind: { type: String, enum: HIRE_DEPARTMENT_KINDS, required: true, immutable: true },
    systemKey: {
      type: String,
      enum: HIRE_SYSTEM_DEPARTMENT_KINDS,
      immutable: true,
    },
    status: {
      type: String,
      enum: HIRE_DEPARTMENT_STATUSES,
      default: 'active',
      required: true,
    },
    archivedAt: { type: Date },
    archivedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    archivedByName: { type: String, maxlength: 120 },
    createdByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    createdByName: { type: String, maxlength: 120 },
  },
  { timestamps: true },
)

HireDepartmentSchema.path('systemKey').validate(function validateSystemKey(
  value: HireSystemDepartmentKind | undefined,
) {
  if (this.kind === 'standard') return value === undefined
  return value === this.kind
}, 'System department key must match its immutable kind')

// One human-readable department name per workspace, including archived rows.
// Keeping archived names reserved prevents an old job/report from becoming
// ambiguous after a later department is created with the same display name.
HireDepartmentSchema.index({ workspaceId: 1, normalizedName: 1 }, { unique: true })
HireDepartmentSchema.index({ workspaceId: 1, status: 1, kind: 1, name: 1 })
// A compound sparse index would still index ordinary rows because workspaceId
// is always present. The partial predicate is what limits this uniqueness
// coordinate to durable migration/test-drive rows only.
HireDepartmentSchema.index(
  { workspaceId: 1, systemKey: 1 },
  {
    unique: true,
    partialFilterExpression: { systemKey: { $exists: true } },
  },
)

export const HireDepartment: Model<IHireDepartment> =
  mongoose.models.HireDepartment ||
  mongoose.model<IHireDepartment>('HireDepartment', HireDepartmentSchema)
