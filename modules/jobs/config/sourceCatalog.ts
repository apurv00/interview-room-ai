import { createHash } from 'node:crypto'
import type { IJobSourceConfig } from '@shared/db/models'
import { BOARD_REGISTRY } from './boardRegistry'

export interface JobSourceRequestBudget {
  perRunRequestCap: number
  dailyRequestCap: number
  monthlyRequestCap: number
}

export interface JobSourceDefinition {
  sourceId: string
  kind: IJobSourceConfig['kind']
  atsKind?: string
  slug?: string
  displayName: string
  minIndiaPostings?: number
  cadenceMinutes: number
  requestBudget: JobSourceRequestBudget
  credentialEnv?: 'RAPIDAPI_KEY'
}

const ATS_BUDGET: JobSourceRequestBudget = {
  perRunRequestCap: 12,
  dailyRequestCap: 50,
  monthlyRequestCap: 1_500,
}

/**
 * Deploy-reviewed source inventory. The CMS controls lifecycle and bounded
 * settings for these entries; it never invents adapters, provider URLs, or
 * credential names from operator input.
 */
const NON_BOARD_SOURCES: JobSourceDefinition[] = [
  {
    sourceId: 'jsearch',
    kind: 'aggregator-api',
    displayName: 'JSearch',
    cadenceMinutes: 1_440,
    requestBudget: { perRunRequestCap: 180, dailyRequestCap: 220, monthlyRequestCap: 5_000 },
    credentialEnv: 'RAPIDAPI_KEY',
  },
  {
    sourceId: 'apna',
    kind: 'sitemap-jsonld',
    displayName: 'Apna',
    cadenceMinutes: 1_440,
    requestBudget: { perRunRequestCap: 40, dailyRequestCap: 40, monthlyRequestCap: 1_000 },
  },
  {
    sourceId: 'unstop',
    kind: 'public-api',
    displayName: 'Unstop',
    cadenceMinutes: 1_440,
    requestBudget: { perRunRequestCap: 15, dailyRequestCap: 15, monthlyRequestCap: 400 },
  },
]

export const JOB_SOURCE_CATALOG: readonly JobSourceDefinition[] = Object.freeze([
  ...NON_BOARD_SOURCES,
  ...BOARD_REGISTRY.map((board): JobSourceDefinition => ({
    ...board,
    kind: 'ats-board',
    cadenceMinutes: 360,
    requestBudget: ATS_BUDGET,
  })),
])

const SOURCE_BY_ID = new Map(JOB_SOURCE_CATALOG.map((source) => [source.sourceId, source]))

export function jobSourceDefinition(sourceId: string): JobSourceDefinition | null {
  return SOURCE_BY_ID.get(sourceId) ?? null
}

/** Provider identity is deploy-reviewed code, never mutable CMS data. A row
 * with an unknown id or changed adapter coordinates is not authorized to
 * egress even when somebody toggles `enabled` directly in Mongo. */
export function sourceCatalogIdentityMatches(
  source: Pick<IJobSourceConfig, 'sourceId' | 'kind' | 'atsKind' | 'slug' | 'displayName'>,
): boolean {
  const definition = jobSourceDefinition(source.sourceId)
  return sourceCatalogRoutingMatches(source) && source.displayName === definition?.displayName
}

/** Routing identity is the minimum shape bootstrap may safely repair. The
 * human company identity is reset from code in the same bootstrap transaction. */
export function sourceCatalogRoutingMatches(
  source: Pick<IJobSourceConfig, 'sourceId' | 'kind' | 'atsKind' | 'slug'>,
): boolean {
  const definition = jobSourceDefinition(source.sourceId)
  return !!definition && source.kind === definition.kind &&
    (source.atsKind ?? null) === (definition.atsKind ?? null) &&
    (source.slug ?? null) === (definition.slug ?? null)
}

/** One fail-closed budget truth for CMS and every outbound worker. Missing,
 * malformed, or above-catalog persisted limits never fall back to a larger
 * allowance and never reach a provider. */
export function effectiveSourceRequestBudget(
  source: Pick<IJobSourceConfig, 'sourceId' | 'kind' | 'atsKind' | 'slug' | 'displayName' | 'requestBudget'>,
): JobSourceRequestBudget | null {
  const definition = jobSourceDefinition(source.sourceId)
  const budget = source.requestBudget
  if (!definition || !sourceCatalogIdentityMatches(source) || !budget) return null
  const values = [budget.perRunRequestCap, budget.dailyRequestCap, budget.monthlyRequestCap]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return null
  if (budget.perRunRequestCap > budget.dailyRequestCap || budget.dailyRequestCap > budget.monthlyRequestCap) {
    return null
  }
  if (
    budget.perRunRequestCap > definition.requestBudget.perRunRequestCap ||
    budget.dailyRequestCap > definition.requestBudget.dailyRequestCap ||
    budget.monthlyRequestCap > definition.requestBudget.monthlyRequestCap
  ) return null
  return {
    perRunRequestCap: budget.perRunRequestCap,
    dailyRequestCap: budget.dailyRequestCap,
    monthlyRequestCap: budget.monthlyRequestCap,
  }
}

export type SourcePolicySnapshot = Pick<
  IJobSourceConfig,
  | 'sourceId'
  | 'kind'
  | 'atsKind'
  | 'slug'
  | 'displayName'
  | 'cadenceMinutes'
  | 'requestBudget'
  | 'minIndiaPostings'
  | 'llmVerdictOptOut'
  | 'notes'
>

/** Canonical authority fingerprint for every CMS-mutable source policy field.
 * Notes are included deliberately: even though they do not affect provider
 * egress, excluding one mutable setting would make the audit snapshot an
 * incomplete representation of the operator-approved configuration. */
export function sourcePolicyHash(source: SourcePolicySnapshot): string | null {
  const requestBudget = effectiveSourceRequestBudget(source)
  if (!requestBudget) return null
  if (!Number.isSafeInteger(source.cadenceMinutes) || source.cadenceMinutes < 15 || source.cadenceMinutes > 10_080) {
    return null
  }
  if (
    source.minIndiaPostings != null &&
    (!Number.isSafeInteger(source.minIndiaPostings) || source.minIndiaPostings < 0 || source.minIndiaPostings > 100_000)
  ) return null
  if (typeof source.llmVerdictOptOut !== 'boolean') return null
  if (source.notes != null && (typeof source.notes !== 'string' || source.notes.length > 2_000)) return null

  const canonical = {
    sourceId: source.sourceId,
    cadenceMinutes: source.cadenceMinutes,
    requestBudget,
    minIndiaPostings: source.minIndiaPostings ?? null,
    llmVerdictOptOut: source.llmVerdictOptOut,
    notes: source.notes ?? null,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export type SourceCredentialState = 'not-required' | 'missing' | 'configured'

/** Presence is configuration health only; a successful validation is the
 * separate proof that a configured credential is accepted by the provider. */
export function sourceCredentialStatus(
  source: Pick<JobSourceDefinition, 'credentialEnv'>,
  env: NodeJS.ProcessEnv = process.env,
): SourceCredentialState {
  if (!source.credentialEnv) return 'not-required'
  return env[source.credentialEnv]?.trim() ? 'configured' : 'missing'
}

export function sourceSeed(source: JobSourceDefinition): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    ...(source.atsKind ? { atsKind: source.atsKind } : {}),
    ...(source.slug ? { slug: source.slug } : {}),
    displayName: source.displayName,
    ...(source.minIndiaPostings != null ? { minIndiaPostings: source.minIndiaPostings } : {}),
    enabled: false,
    health: 'active',
    controlRevision: 0,
    operationalRevision: 0,
    ingestWriteSeq: 0,
    cadenceMinutes: source.cadenceMinutes,
    requestBudget: source.requestBudget,
    llmVerdictOptOut: false,
  }
}
