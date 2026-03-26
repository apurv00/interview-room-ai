import type { DomainDepthOverride } from './types'
import { frontendOverrides } from './frontend'
import { backendOverrides } from './backend'
import { sdetOverrides } from './sdet'
import { devopsOverrides } from './devops'
import { dataScienceOverrides } from './dataScience'
import { pmOverrides } from './pm'
import { designOverrides } from './design'
import { businessOverrides } from './business'
import { marketingOverrides } from './marketing'
import { financeOverrides } from './finance'
import { salesOverrides } from './sales'

export type { DomainDepthOverride } from './types'

/**
 * Domain x Depth specialization matrix.
 * Keyed by "domainSlug:depthSlug" (e.g. "sales:technical").
 * 11 domains x 4 depths = 44 combinations.
 */
export const DOMAIN_DEPTH_OVERRIDES: Record<string, DomainDepthOverride> = {
  ...frontendOverrides,
  ...backendOverrides,
  ...sdetOverrides,
  ...devopsOverrides,
  ...dataScienceOverrides,
  ...pmOverrides,
  ...designOverrides,
  ...businessOverrides,
  ...marketingOverrides,
  ...financeOverrides,
  ...salesOverrides,
}
