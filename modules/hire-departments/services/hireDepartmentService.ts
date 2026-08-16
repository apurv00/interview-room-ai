import mongoose, { type ClientSession } from 'mongoose'
import { AppError, ForbiddenError, NotFoundError } from '@shared/errors'
import {
  connectHireControlDB,
  withActiveHireWorkspaceWriteTransaction,
  type MembershipContext,
} from '../boundary'
import {
  HIRE_SYSTEM_DEPARTMENT_NAMES,
  HireDepartment,
  type HireSystemDepartmentKind,
  type IHireDepartment,
} from '../models'
import {
  AssignHireDepartmentSchema,
  CreateHireDepartmentSchema,
  UpdateHireDepartmentSchema,
  type CreateHireDepartmentPayload,
  type UpdateHireDepartmentPayload,
} from '../validators/hireDepartments'
import type {
  EnsureSystemHireDepartmentInput,
  HireAssignableDepartmentView,
  HireDepartmentAssignmentInput,
  HireDepartmentView,
} from '../types'
import {
  toHireAssignableDepartmentView,
  toHireDepartmentView,
} from '../types'

const OBJECT_ID = /^[a-f0-9]{24}$/i

export function normalizeHireDepartmentName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function asObjectId(
  value: string | { toString(): string },
  field: 'workspace' | 'department' | 'member',
): mongoose.Types.ObjectId {
  const raw = typeof value === 'string' ? value : value.toString()
  if (!OBJECT_ID.test(raw)) {
    throw new AppError(`Invalid ${field} id`, 400, `INVALID_${field.toUpperCase()}_ID`)
  }
  return new mongoose.Types.ObjectId(raw)
}

function actorName(ctx: MembershipContext): string {
  return ctx.membership.name?.trim() || ctx.membership.email
}

function assertAdmin(ctx: MembershipContext): void {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can manage departments')
  }
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 11000,
  )
}

function assertStandardNameIsNotReserved(name: string): void {
  const normalizedName = normalizeHireDepartmentName(name)
  if (
    Object.values(HIRE_SYSTEM_DEPARTMENT_NAMES)
      .map(normalizeHireDepartmentName)
      .includes(normalizedName)
  ) {
    throw new AppError(
      'That department name is reserved for a system-managed catalog entry',
      409,
      'DEPARTMENT_SYSTEM_NAME_RESERVED',
    )
  }
}

function withSession<T>(
  query: { session(session: ClientSession): Promise<T> } | Promise<T>,
  session: ClientSession | undefined,
): Promise<T> {
  if (session && 'session' in query) return query.session(session)
  return query as Promise<T>
}

function assertSystemKind(kind: string): asserts kind is HireSystemDepartmentKind {
  if (kind !== 'legacy' && kind !== 'onboarding') {
    throw new AppError('Only a system department kind may be ensured', 500, 'INVALID_SYSTEM_DEPARTMENT')
  }
}

/**
 * Resolve the only kind of department a real requisition can use. The query
 * includes workspace, state, and kind, so a foreign, archived, or synthetic
 * department is indistinguishable to the caller and cannot become a job ref.
 */
export async function assertAssignableHireDepartment(
  input: HireDepartmentAssignmentInput,
): Promise<IHireDepartment> {
  const parsed = AssignHireDepartmentSchema.safeParse({
    departmentId: typeof input.departmentId === 'string'
      ? input.departmentId
      : input.departmentId.toString(),
  })
  if (!parsed.success) {
    throw new AppError('Invalid department id', 400, 'INVALID_DEPARTMENT_ID')
  }
  const workspaceId = asObjectId(input.workspaceId, 'workspace')
  const departmentId = asObjectId(parsed.data.departmentId, 'department')
  const department = await withSession(
    HireDepartment.findOne({
      _id: departmentId,
      workspaceId,
      kind: 'standard',
      status: 'active',
    }),
    input.session,
  )
  if (!department) {
    throw new AppError(
      'Select an active department in this workspace',
      409,
      'DEPARTMENT_NOT_ASSIGNABLE',
    )
  }
  return department
}

/** Narrow read for member-authorized job detail/list composition. */
export async function getHireDepartment(input: {
  workspaceId: string | { toString(): string }
  departmentId: string | { toString(): string }
  session?: ClientSession
}): Promise<IHireDepartment> {
  const workspaceId = asObjectId(input.workspaceId, 'workspace')
  const departmentId = asObjectId(input.departmentId, 'department')
  const department = await withSession(
    HireDepartment.findOne({ _id: departmentId, workspaceId }),
    input.session,
  )
  if (!department) throw new NotFoundError('Department')
  return department
}

/**
 * Finds a system catalog row only inside the caller's transaction. This is
 * used by migration and onboarding code; it is never a job-authoring choice.
 */
export async function getSystemHireDepartment(input: {
  workspaceId: string | { toString(): string }
  kind: HireSystemDepartmentKind
  session?: ClientSession
}): Promise<IHireDepartment | null> {
  assertSystemKind(input.kind)
  return withSession(
    HireDepartment.findOne({
      workspaceId: asObjectId(input.workspaceId, 'workspace'),
      kind: input.kind,
      systemKey: input.kind,
    }),
    input.session,
  )
}

/**
 * Idempotently provisions one hidden system row per workspace/kind. It relies
 * on the partial `{ workspaceId, systemKey }` unique index and must be invoked
 * under the owning caller's existing transaction.
 */
export async function ensureHireSystemDepartment(
  input: EnsureSystemHireDepartmentInput,
): Promise<IHireDepartment> {
  assertSystemKind(input.kind)
  const workspaceId = asObjectId(input.workspaceId, 'workspace')
  const actorMemberId = input.actor?.memberId
    ? asObjectId(input.actor.memberId, 'member')
    : undefined
  const name = HIRE_SYSTEM_DEPARTMENT_NAMES[input.kind]
  try {
    const department = await HireDepartment.findOneAndUpdate(
      { workspaceId, systemKey: input.kind },
      {
        $set: { status: 'active' },
        $setOnInsert: {
          workspaceId,
          name,
          normalizedName: normalizeHireDepartmentName(name),
          kind: input.kind,
          systemKey: input.kind,
          ...(actorMemberId ? { createdByMemberId: actorMemberId } : {}),
          ...(input.actor?.name ? { createdByName: input.actor.name.slice(0, 120) } : {}),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, session: input.session },
    )
    if (!department) throw new Error('System department upsert returned no document')
    return department
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    // A concurrent transaction may have materialized the same system row.
    const existing = await getSystemHireDepartment({
      workspaceId,
      kind: input.kind,
      session: input.session,
    })
    if (existing) return existing
    throw error
  }
}

/** Active standard departments only: safe for every authenticated HR member. */
export async function listAssignableHireDepartments(
  ctx: MembershipContext,
): Promise<HireAssignableDepartmentView[]> {
  await connectHireControlDB()
  const departments = await HireDepartment.find({
    workspaceId: ctx.workspace._id,
    kind: 'standard',
    status: 'active',
  })
    .sort({ name: 1, _id: 1 })
    .select('_id name')
  return departments.map(toHireAssignableDepartmentView)
}

/**
 * Admin catalog view. `legacy` stays visible so owners can track migration
 * cleanup; onboarding stays absent because it is synthetic product machinery.
 */
export async function listHireDepartmentsForManagement(
  ctx: MembershipContext,
): Promise<HireDepartmentView[]> {
  assertAdmin(ctx)
  await connectHireControlDB()
  const departments = await HireDepartment.find({
    workspaceId: ctx.workspace._id,
    kind: { $in: ['standard', 'legacy'] },
  }).sort({ status: 1, name: 1, _id: 1 })
  return departments.map(toHireDepartmentView)
}

/**
 * Safe catalog response for every workspace member. Archived and legacy rows
 * remain visible as historical job labels, but only active standard rows are
 * assignable (enforced again by the job command). Onboarding is never
 * returned, so a synthetic practice row cannot enter ordinary tracking UI.
 */
export async function listHireDepartments(
  ctx: MembershipContext,
): Promise<HireDepartmentView[]> {
  await connectHireControlDB()
  const departments = await HireDepartment.find({
    workspaceId: ctx.workspace._id,
    kind: { $in: ['standard', 'legacy'] as const },
  }).sort({ status: 1, name: 1, _id: 1 })
  return departments.map(toHireDepartmentView)
}

export async function createHireDepartment(
  ctx: MembershipContext,
  input: CreateHireDepartmentPayload,
): Promise<IHireDepartment> {
  assertAdmin(ctx)
  const parsed = CreateHireDepartmentSchema.parse(input)
  assertStandardNameIsNotReserved(parsed.name)
  const normalizedName = normalizeHireDepartmentName(parsed.name)

  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      try {
        const departments = await HireDepartment.create(
          [
            {
              workspaceId: ctx.workspace._id,
              name: parsed.name,
              normalizedName,
              kind: 'standard',
              status: 'active',
              createdByMemberId: ctx.membership._id,
              createdByName: actorName(ctx),
            },
          ],
          { session },
        )
        return departments[0]
      } catch (error) {
        if (!isDuplicateKey(error)) throw error
        throw new AppError(
          'A department with that name already exists in this workspace',
          409,
          'DEPARTMENT_NAME_CONFLICT',
        )
      }
    },
  )
}

export async function archiveHireDepartment(
  ctx: MembershipContext,
  departmentId: string,
): Promise<IHireDepartment> {
  assertAdmin(ctx)
  const parsed = AssignHireDepartmentSchema.parse({ departmentId })
  const targetId = asObjectId(parsed.departmentId, 'department')
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const activeStandardCount = await HireDepartment.countDocuments({
        workspaceId: ctx.workspace._id,
        kind: 'standard',
        status: 'active',
      }).session(session)
      if (activeStandardCount <= 1) {
        throw new AppError(
          'Create another active department before archiving the last one',
          409,
          'DEPARTMENT_LAST_ACTIVE',
        )
      }
      const department = await HireDepartment.findOneAndUpdate(
        {
          _id: targetId,
          workspaceId: ctx.workspace._id,
          kind: 'standard',
          status: 'active',
        },
        {
          $set: {
            status: 'archived',
            archivedAt: new Date(),
            archivedByMemberId: ctx.membership._id,
            archivedByName: actorName(ctx),
          },
        },
        { new: true, runValidators: true, session },
      )
      if (!department) {
        throw new AppError(
          'Only an active standard department in this workspace can be archived',
          409,
          'DEPARTMENT_NOT_ARCHIVABLE',
        )
      }
      return department
    },
  )
}

export async function restoreHireDepartment(
  ctx: MembershipContext,
  departmentId: string,
): Promise<IHireDepartment> {
  assertAdmin(ctx)
  const parsed = AssignHireDepartmentSchema.parse({ departmentId })
  const targetId = asObjectId(parsed.departmentId, 'department')
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const department = await HireDepartment.findOneAndUpdate(
        {
          _id: targetId,
          workspaceId: ctx.workspace._id,
          kind: 'standard',
          status: 'archived',
        },
        {
          $set: { status: 'active' },
          $unset: { archivedAt: 1, archivedByMemberId: 1, archivedByName: 1 },
        },
        { new: true, runValidators: true, session },
      )
      if (!department) {
        throw new AppError(
          'Only an archived standard department in this workspace can be restored',
          409,
          'DEPARTMENT_NOT_RESTORABLE',
        )
      }
      return department
    },
  )
}

/** Single lifecycle command used by the administrative catalog route. */
export async function updateHireDepartment(
  ctx: MembershipContext,
  departmentId: string,
  input: UpdateHireDepartmentPayload,
): Promise<IHireDepartment> {
  const parsed = UpdateHireDepartmentSchema.parse(input)
  return parsed.action === 'archive'
    ? archiveHireDepartment(ctx, departmentId)
    : restoreHireDepartment(ctx, departmentId)
}
