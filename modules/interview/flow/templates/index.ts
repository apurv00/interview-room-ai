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
  ...DESIGN_BEH, ...DESIGN_TECH, ...DESIGN_CASE,
  ...BIZ_BEH, ...BIZ_TECH, ...BIZ_CASE,
  ...GEN_BEH, ...GEN_TECH, ...GEN_CASE, ...GEN_CODE, ...GEN_SYS,
]

export const TEMPLATE_REGISTRY: Map<TemplateKey, FlowTemplate> = new Map()

for (const t of allTemplates) {
  const key = makeTemplateKey(t.domain, t.depth, t.experience)
  TEMPLATE_REGISTRY.set(key, t)
}
