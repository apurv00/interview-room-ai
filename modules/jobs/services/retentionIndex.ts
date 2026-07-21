import { JobPosting } from '@shared/db/models'

export const JOB_RETENTION_TTL_INDEX_NAME = 'purgeAt_1'

export interface RetentionIndexDescription {
  name?: string
  key?: Record<string, unknown>
  expireAfterSeconds?: unknown
  sparse?: unknown
  hidden?: unknown
  partialFilterExpression?: unknown
  collation?: unknown
  unique?: unknown
}

export interface RetentionTtlIndexStatus {
  ready: boolean
  matchingName?: string
  keyIdentical: RetentionIndexDescription[]
  /** Present during preparation so operators can prove historical TTL values
   * were cleared before the destructive index becomes active. */
  purgeAtRows?: number
}

function isPurgeAtKey(index: RetentionIndexDescription): boolean {
  const entries = Object.entries(index.key ?? {})
  return entries.length === 1 && entries[0][0] === 'purgeAt' && entries[0][1] === 1
}

function isExactRetentionTtl(index: RetentionIndexDescription): boolean {
  return (
    isPurgeAtKey(index) &&
    index.expireAfterSeconds === 0 &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.unique !== true &&
    index.partialFilterExpression === undefined &&
    index.collation === undefined
  )
}

export function retentionTtlIndexStatusOf(
  indexes: RetentionIndexDescription[],
): RetentionTtlIndexStatus {
  const keyIdentical = indexes.filter(isPurgeAtKey)
  const exact = keyIdentical.filter(isExactRetentionTtl)
  return {
    ready: keyIdentical.length === 1 && exact.length === 1,
    matchingName: exact[0]?.name,
    keyIdentical,
  }
}

export function assertRetentionTtlIndex(
  indexes: RetentionIndexDescription[],
): RetentionTtlIndexStatus {
  const status = retentionTtlIndexStatusOf(indexes)
  if (!status.ready) {
    const detail = status.keyIdentical.length === 0
      ? 'missing'
      : `${status.keyIdentical.length} key-identical incompatible index(es)`
    throw new Error(
      `Jobs retention TTL index is ${detail}; require exactly one {purgeAt:1} index with expireAfterSeconds:0`,
    )
  }
  return status
}

export async function readRetentionIndexes(): Promise<RetentionIndexDescription[]> {
  try {
    return await JobPosting.collection.indexes() as RetentionIndexDescription[]
  } catch (error) {
    if ((error as { codeName?: string }).codeName === 'NamespaceNotFound') return []
    throw error
  }
}

export async function assertDeployedRetentionTtlIndex(): Promise<RetentionTtlIndexStatus> {
  return assertRetentionTtlIndex(await readRetentionIndexes())
}

/** Non-dropping preparation. A conflicting key-identical index is surfaced
 * for operator action; this command never replaces or deletes an index. */
export async function prepareRetentionTtlIndex(
  apply: boolean,
): Promise<RetentionTtlIndexStatus> {
  const before = retentionTtlIndexStatusOf(await readRetentionIndexes())
  const purgeAtRows = await JobPosting.countDocuments({ purgeAt: { $exists: true } })
  if (before.ready) return { ...before, purgeAtRows }
  if (before.keyIdentical.length > 0) return assertRetentionTtlIndex(before.keyIdentical)

  const preparation = { ...before, purgeAtRows }
  if (!apply) return preparation
  if (purgeAtRows > 0) {
    throw new Error(
      `Refusing to create Jobs retention TTL index while ${purgeAtRows} posting(s) still carry purgeAt; run repair:jobs-retention -- --apply first`,
    )
  }

  await JobPosting.collection.createIndex(
    { purgeAt: 1 },
    { name: JOB_RETENTION_TTL_INDEX_NAME, expireAfterSeconds: 0 },
  )
  return { ...await assertDeployedRetentionTtlIndex(), purgeAtRows: 0 }
}
