// B2B / Hire module barrel export
export {
  getHireUser,
  isRecruiter,
  isOrgAdmin,
  getDashboardData,
  listCandidates,
  createInvite,
  listPendingInvites,
  createOrg,
  getOrg,
  updateOrgSettings,
  listTemplates,
  createTemplate,
} from './services/hireService'
export type { HireUser, DashboardStats, CandidateListItem } from './services/hireService'
export {
  CreateOrgSchema,
  UpdateOrgSchema,
  CreateTemplateSchema,
  InviteSchema,
} from './validators/hire'
