export interface SourceControlIndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  expireAfterSeconds?: number
  partialFilterExpression?: unknown
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

export function hasExactIndexKey(
  index: SourceControlIndexDescription,
  expectedKey: Array<readonly [string, number]>,
): boolean {
  const actualKey = Object.entries(index.key ?? {})
  return actualKey.length === expectedKey.length && actualKey.every(
    ([field, direction], position) => (
      field === expectedKey[position][0] && direction === expectedKey[position][1]
    ),
  )
}

/** Legal-control indexes must cover the whole collection with ordinary simple
 * semantics. Matching keys alone are unsafe when a partial/sparse/hidden or
 * collated index can omit/reorder rows while the revoke query forces a hint. */
export function hasSafeExactIndex(
  index: SourceControlIndexDescription,
  expectedKey: Array<readonly [string, number]>,
  expectedUnique: boolean,
): boolean {
  return (
    Boolean(index.unique) === expectedUnique &&
    index.expireAfterSeconds === undefined &&
    index.partialFilterExpression === undefined &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation === undefined &&
    hasExactIndexKey(index, expectedKey)
  )
}

/** A key-pattern hint is ambiguous when Mongo permits a second same-key index
 * with different options. Legal lookups therefore require one and only one
 * same-key index, with the stable name used by runtime hints. */
export function hasSingleSafeNamedIndex(
  indexes: SourceControlIndexDescription[],
  expectedKey: Array<readonly [string, number]>,
  expectedUnique: boolean,
  expectedName: string,
): boolean {
  const matchingKeys = indexes.filter((index) => hasExactIndexKey(index, expectedKey))
  return matchingKeys.length === 1 &&
    matchingKeys[0].name === expectedName &&
    hasSafeExactIndex(matchingKeys[0], expectedKey, expectedUnique)
}
