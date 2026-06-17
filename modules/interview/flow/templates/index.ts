import type { FlowTemplate, TemplateKey } from '../types'
import { makeTemplateKey } from '../types'

// ─── Backend ────────────────────────────────────────────────────────────────
import { TEMPLATES as BACKEND_BEH } from './backend-behavioral'
import { TEMPLATES as BACKEND_TECH } from './backend-technical'
import { TEMPLATES as BACKEND_CASE } from './backend-case-study'
import { TEMPLATES as BACKEND_CODE } from './backend-coding'
import { TEMPLATES as BACKEND_SYS } from './backend-system-design'

// ─── Frontend ───────────────────────────────────────────────────────────────
import { TEMPLATES as FRONTEND_BEH } from './frontend-behavioral'
import { TEMPLATES as FRONTEND_TECH } from './frontend-technical'
import { TEMPLATES as FRONTEND_CASE } from './frontend-case-study'
import { TEMPLATES as FRONTEND_CODE } from './frontend-coding'
import { TEMPLATES as FRONTEND_SYS } from './frontend-system-design'

// ─── PM ─────────────────────────────────────────────────────────────────────
import { TEMPLATES as PM_BEH } from './pm-behavioral'
import { TEMPLATES as PM_TECH } from './pm-technical'
import { TEMPLATES as PM_CASE } from './pm-case-study'

// ─── Data Science ───────────────────────────────────────────────────────────
import { TEMPLATES as DS_BEH } from './data-science-behavioral'
import { TEMPLATES as DS_TECH } from './data-science-technical'
import { TEMPLATES as DS_CASE } from './data-science-case-study'
import { TEMPLATES as DS_CODE } from './data-science-coding'
import { TEMPLATES as DS_SYS } from './data-science-system-design'

// ─── SDET ───────────────────────────────────────────────────────────────────
import { TEMPLATES as SDET_BEH } from './sdet-behavioral'
import { TEMPLATES as SDET_TECH } from './sdet-technical'
import { TEMPLATES as SDET_CASE } from './sdet-case-study'
import { TEMPLATES as SDET_CODE } from './sdet-coding'
import { TEMPLATES as SDET_SYS } from './sdet-system-design'

// ─── DevOps ─────────────────────────────────────────────────────────────────
import { TEMPLATES as DEVOPS_BEH } from './devops-behavioral'
import { TEMPLATES as DEVOPS_TECH } from './devops-technical'
import { TEMPLATES as DEVOPS_CODE } from './devops-coding'
import { TEMPLATES as DEVOPS_SYS } from './devops-system-design'

// ─── Finance ────────────────────────────────────────────────────────────────
import { TEMPLATES as FINANCE_BEH } from './finance-behavioral'
import { TEMPLATES as FINANCE_TECH } from './finance-technical'
import { TEMPLATES as FINANCE_CASE } from './finance-case-study'

// ─── Marketing ──────────────────────────────────────────────────────────────
import { TEMPLATES as MKT_BEH } from './marketing-behavioral'
import { TEMPLATES as MKT_TECH } from './marketing-technical'
import { TEMPLATES as MKT_CASE } from './marketing-case-study'

// ─── Sales ──────────────────────────────────────────────────────────────────
import { TEMPLATES as SALES_BEH } from './sales-behavioral'
import { TEMPLATES as SALES_TECH } from './sales-technical'
import { TEMPLATES as SALES_CASE } from './sales-case-study'

// ─── Strategy / Consulting ──────────────────────────────────────────────────
import { TEMPLATES as STRATEGY_BEH } from './strategy-behavioral'
import { TEMPLATES as STRATEGY_TECH } from './strategy-technical'
import { TEMPLATES as STRATEGY_CASE } from './strategy-case-study'

// ─── Operations ─────────────────────────────────────────────────────────────
import { TEMPLATES as OPS_BEH } from './operations-behavioral'
import { TEMPLATES as OPS_TECH } from './operations-technical'
import { TEMPLATES as OPS_CASE } from './operations-case-study'

// ─── Product Analyst ────────────────────────────────────────────────────────
import { TEMPLATES as PA_BEH } from './product-analyst-behavioral'
import { TEMPLATES as PA_TECH } from './product-analyst-technical'
import { TEMPLATES as PA_CASE } from './product-analyst-case-study'

// ─── UI Designer ────────────────────────────────────────────────────────────
import { TEMPLATES as UID_BEH } from './ui-designer-behavioral'
import { TEMPLATES as UID_TECH } from './ui-designer-technical'
import { TEMPLATES as UID_CASE } from './ui-designer-case-study'

// ─── Product Designer ───────────────────────────────────────────────────────
import { TEMPLATES as PD_BEH } from './product-designer-behavioral'
import { TEMPLATES as PD_TECH } from './product-designer-technical'
import { TEMPLATES as PD_CASE } from './product-designer-case-study'

// ─── Full-stack ─────────────────────────────────────────────────────────────
import { TEMPLATES as FS_BEH } from './fullstack-behavioral'
import { TEMPLATES as FS_TECH } from './fullstack-technical'
import { TEMPLATES as FS_SYS } from './fullstack-system-design'
import { TEMPLATES as FS_CODE } from './fullstack-coding'

// ─── Mobile ─────────────────────────────────────────────────────────────────
import { TEMPLATES as MOB_BEH } from './mobile-behavioral'
import { TEMPLATES as MOB_TECH } from './mobile-technical'
import { TEMPLATES as MOB_SYS } from './mobile-system-design'
import { TEMPLATES as MOB_CODE } from './mobile-coding'

// ─── ML Engineer ────────────────────────────────────────────────────────────
import { TEMPLATES as MLE_BEH } from './ml-engineer-behavioral'
import { TEMPLATES as MLE_TECH } from './ml-engineer-technical'
import { TEMPLATES as MLE_CASE } from './ml-engineer-case-study'
import { TEMPLATES as MLE_SYS } from './ml-engineer-system-design'
import { TEMPLATES as MLE_CODE } from './ml-engineer-coding'

// ─── Data Analyst ───────────────────────────────────────────────────────────
import { TEMPLATES as DA_BEH } from './data-analyst-behavioral'
import { TEMPLATES as DA_TECH } from './data-analyst-technical'
import { TEMPLATES as DA_CASE } from './data-analyst-case-study'
import { TEMPLATES as DA_SYS } from './data-analyst-system-design'
import { TEMPLATES as DA_CODE } from './data-analyst-coding'

// ─── Mechanical ─────────────────────────────────────────────────────────────
import { TEMPLATES as MECH_BEH } from './mechanical-behavioral'
import { TEMPLATES as MECH_TECH } from './mechanical-technical'

// ─── Civil ──────────────────────────────────────────────────────────────────
import { TEMPLATES as CIVIL_BEH } from './civil-behavioral'
import { TEMPLATES as CIVIL_TECH } from './civil-technical'

// ─── Electrical ─────────────────────────────────────────────────────────────
import { TEMPLATES as ELEC_BEH } from './electrical-behavioral'
import { TEMPLATES as ELEC_TECH } from './electrical-technical'

// ─── Electronics ────────────────────────────────────────────────────────────
import { TEMPLATES as ECE_BEH } from './electronics-behavioral'
import { TEMPLATES as ECE_TECH } from './electronics-technical'

// ─── Design ─────────────────────────────────────────────────────────────────
import { TEMPLATES as DESIGN_BEH } from './design-behavioral'
import { TEMPLATES as DESIGN_TECH } from './design-technical'
import { TEMPLATES as DESIGN_CASE } from './design-case-study'

// ─── Business ───────────────────────────────────────────────────────────────
import { TEMPLATES as BIZ_BEH } from './business-behavioral'
import { TEMPLATES as BIZ_TECH } from './business-technical'
import { TEMPLATES as BIZ_CASE } from './business-case-study'

// ─── General ────────────────────────────────────────────────────────────────
import { TEMPLATES as GEN_BEH } from './general-behavioral'
import { TEMPLATES as GEN_TECH } from './general-technical'
import { TEMPLATES as GEN_CASE } from './general-case-study'
import { TEMPLATES as GEN_CODE } from './general-coding'
import { TEMPLATES as GEN_SYS } from './general-system-design'

const allTemplates: FlowTemplate[] = [
  ...BACKEND_BEH, ...BACKEND_TECH, ...BACKEND_CASE, ...BACKEND_CODE, ...BACKEND_SYS,
  ...FRONTEND_BEH, ...FRONTEND_TECH, ...FRONTEND_CASE, ...FRONTEND_CODE, ...FRONTEND_SYS,
  ...PM_BEH, ...PM_TECH, ...PM_CASE,
  ...DS_BEH, ...DS_TECH, ...DS_CASE, ...DS_CODE, ...DS_SYS,
  ...SDET_BEH, ...SDET_TECH, ...SDET_CASE, ...SDET_CODE, ...SDET_SYS,
  ...DEVOPS_BEH, ...DEVOPS_TECH, ...DEVOPS_CODE, ...DEVOPS_SYS,
  ...FINANCE_BEH, ...FINANCE_TECH, ...FINANCE_CASE,
  ...MKT_BEH, ...MKT_TECH, ...MKT_CASE,
  ...SALES_BEH, ...SALES_TECH, ...SALES_CASE,
  ...STRATEGY_BEH, ...STRATEGY_TECH, ...STRATEGY_CASE,
  ...OPS_BEH, ...OPS_TECH, ...OPS_CASE,
  ...PA_BEH, ...PA_TECH, ...PA_CASE,
  ...UID_BEH, ...UID_TECH, ...UID_CASE,
  ...PD_BEH, ...PD_TECH, ...PD_CASE,
  ...FS_BEH, ...FS_TECH, ...FS_SYS, ...FS_CODE,
  ...MOB_BEH, ...MOB_TECH, ...MOB_SYS, ...MOB_CODE,
  ...MLE_BEH, ...MLE_TECH, ...MLE_CASE, ...MLE_SYS, ...MLE_CODE,
  ...DA_BEH, ...DA_TECH, ...DA_CASE, ...DA_SYS, ...DA_CODE,
  ...MECH_BEH, ...MECH_TECH,
  ...CIVIL_BEH, ...CIVIL_TECH,
  ...ELEC_BEH, ...ELEC_TECH,
  ...ECE_BEH, ...ECE_TECH,
  ...DESIGN_BEH, ...DESIGN_TECH, ...DESIGN_CASE,
  ...BIZ_BEH, ...BIZ_TECH, ...BIZ_CASE,
  ...GEN_BEH, ...GEN_TECH, ...GEN_CASE, ...GEN_CODE, ...GEN_SYS,
]

export const TEMPLATE_REGISTRY: Map<TemplateKey, FlowTemplate> = new Map()

for (const t of allTemplates) {
  const key = makeTemplateKey(t.domain, t.depth, t.experience)
  TEMPLATE_REGISTRY.set(key, t)
}
