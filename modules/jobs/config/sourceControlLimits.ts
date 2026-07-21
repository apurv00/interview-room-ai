/** Retained-corpus bound proven by the production-shaped replica-set smoke.
 * This includes active rows, owner-pinned archives, and tombstones. Raise only
 * together with the smoke row count/latency threshold and promotion gate. */
export const JOB_SOURCE_CONTROL_MAX_POSTINGS = 25_000
/** Operator warning threshold that preserves headroom for urgent legal action. */
export const JOB_SOURCE_CONTROL_WARN_POSTINGS = 20_000
export const JOB_SOURCE_CONTROL_MAX_REVOKE_MS = 45_000

/** Stable names are part of the legal lookup contract. Runtime code hints by
 * name so a key-identical sparse/partial/collated index can never be selected
 * (or make a key-pattern hint ambiguous). */
export const JOB_SOURCE_CONTROL_INDEX_NAMES = {
  sourceConfigSourceId: 'sourceId_1',
  auditOperationId: 'operationId_1',
  auditSourceRevision: 'sourceId_1_revision_1',
  postingSourceIds: 'sourceIds_1',
  postingProvenanceSourceId: 'provenance.sourceId_1',
} as const
