import type { ClientSession } from 'mongoose'
import type {
  HireDepartmentKind,
  HireDepartmentStatus,
  HireSystemDepartmentKind,
  IHireDepartment,
} from './models'

/** Explicit member-safe DTO; never expose member actor ids through catalog reads. */
export interface HireDepartmentView {
  id: string
  name: string
  kind: Exclude<HireDepartmentKind, 'onboarding'>
  status: HireDepartmentStatus
  archivedAt: Date | null
  assignable: boolean
}

/** The narrow choice list used by ordinary job authoring. */
export interface HireAssignableDepartmentView {
  id: string
  name: string
}

export interface HireDepartmentAssignmentInput {
  workspaceId: string | { toString(): string }
  departmentId: string | { toString(): string }
  session?: ClientSession
}

export interface EnsureSystemHireDepartmentInput {
  workspaceId: string | { toString(): string }
  kind: HireSystemDepartmentKind
  session: ClientSession
  actor?: {
    memberId?: string | { toString(): string }
    name?: string
  }
}

export function toHireDepartmentView(department: IHireDepartment): HireDepartmentView {
  // Callers never receive onboarding rows; this assertion keeps an accidental
  // broad query from making a synthetic-department label public.
  if (department.kind === 'onboarding') {
    throw new Error('Onboarding departments are not member-facing')
  }
  return {
    id: department._id.toString(),
    name: department.name,
    kind: department.kind,
    status: department.status,
    archivedAt: department.archivedAt ?? null,
    assignable: department.kind === 'standard' && department.status === 'active',
  }
}

export function toHireAssignableDepartmentView(
  department: IHireDepartment,
): HireAssignableDepartmentView {
  return { id: department._id.toString(), name: department.name }
}
