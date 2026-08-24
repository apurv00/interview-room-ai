/**
 * Versioned, presentation-safe Hire packaging catalog.
 *
 * This catalog is commercial metadata only. It is deliberately not an
 * authorization source: current Hire capabilities remain available while the
 * commercial model runs in shadow mode.
 */

export const HIRE_COMMERCIAL_CATALOG_VERSION = 'hire-commercial-v1' as const

/**
 * Versioned measurement epoch for the read-only shadow projection. Counts are
 * derived from authoritative interview results; no per-candidate commercial
 * receipt is created.
 */
export const HIRE_COMMERCIAL_SHADOW_MEASUREMENT_STARTED_AT =
  '2026-08-23T00:00:00.000Z' as const

export const HIRE_COMMERCIAL_MODULE_IDS = [
  'core',
  'screen',
  'decide',
  'operate',
] as const

export type HireCommercialModuleId =
  (typeof HIRE_COMMERCIAL_MODULE_IDS)[number]

export interface HireCommercialCatalogModule {
  id: HireCommercialModuleId
  name: string
  summary: string
  capabilities: readonly string[]
}

export const HIRE_COMMERCIAL_CATALOG: readonly HireCommercialCatalogModule[] =
  [
    {
      id: 'core',
      name: 'Core',
      summary: 'The shared hiring workspace and system of record.',
      capabilities: [
        'Workspace and team administration',
        'Jobs, candidates, and applications',
        'Departments and candidate status links',
      ],
    },
    {
      id: 'screen',
      name: 'Screen',
      summary: 'Structured intake and evidence-backed screening workflows.',
      capabilities: [
        'Bulk intake and screening criteria',
        'AI interview invitations and recovery',
        'Recorded assessment evidence',
      ],
    },
    {
      id: 'decide',
      name: 'Decide',
      summary: 'Human-owned decisions supported by reviewable evidence.',
      capabilities: [
        'Human scorecards and decision huddles',
        'Candidate comparison',
        'Share packets and assessment exports',
      ],
    },
    {
      id: 'operate',
      name: 'Operate',
      summary: 'Operational visibility for a consistent hiring process.',
      capabilities: [
        'Workspace overview and job health',
        'Audit trail and reports',
        'Operational summaries',
      ],
    },
  ] as const
