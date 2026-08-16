/**
 * Hire Department catalog. This stays intentionally separate from the broad
 * Hire command barrel: it owns catalog records and uses only the narrow
 * workspace-write bridge in `boundary.ts`.
 */
export * from './models'
export * from './types'
export * from './validators/hireDepartments'
export {
  archiveHireDepartment,
  assertAssignableHireDepartment,
  createHireDepartment,
  ensureHireSystemDepartment,
  getHireDepartment,
  getSystemHireDepartment,
  listAssignableHireDepartments,
  listHireDepartments,
  listHireDepartmentsForManagement,
  normalizeHireDepartmentName,
  restoreHireDepartment,
  updateHireDepartment,
} from './services/hireDepartmentService'
