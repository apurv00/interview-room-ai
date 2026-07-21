import { describe, expect, it } from 'vitest'
import { JOBS_SOURCE_CONTROL_INDEX_DEFINITIONS } from '../../../scripts/prepare-jobs-source-control-indexes'
import { JobPosting } from '../models/JobPosting'
import { JobSourceControlAudit } from '../models/JobSourceControlAudit'

function keySignature(key: Record<string, unknown>): string {
  return Object.entries(key)
    .map(([field, direction]) => `${field}:${String(direction)}`)
    .join(',')
}

function schemaIndexKeys(model: typeof JobPosting | typeof JobSourceControlAudit): string[] {
  return model.schema.indexes().map(([key]) => keySignature(key))
}

describe('Jobs source-control explicit index ownership', () => {
  it('keeps all five rollout indexes explicit and the four new indexes out of schema automation', () => {
    expect(
      JOBS_SOURCE_CONTROL_INDEX_DEFINITIONS.map(({ target, name, key, unique }) => ({
        target,
        name,
        key,
        unique,
      })),
    ).toEqual([
      {
        target: 'source-configs',
        name: 'sourceId_1',
        key: { sourceId: 1 },
        unique: true,
      },
      {
        target: 'source-control-audits',
        name: 'operationId_1',
        key: { operationId: 1 },
        unique: true,
      },
      {
        target: 'source-control-audits',
        name: 'sourceId_1_revision_1',
        key: { sourceId: 1, revision: 1 },
        unique: true,
      },
      {
        target: 'postings',
        name: 'sourceIds_1',
        key: { sourceIds: 1 },
        unique: false,
      },
      {
        target: 'postings',
        name: 'provenance.sourceId_1',
        key: { 'provenance.sourceId': 1 },
        unique: false,
      },
    ])

    expect(schemaIndexKeys(JobPosting)).not.toContain('sourceIds:1')
    expect(schemaIndexKeys(JobPosting)).not.toContain('provenance.sourceId:1')
    expect(schemaIndexKeys(JobSourceControlAudit)).not.toContain('operationId:1')
    expect(schemaIndexKeys(JobSourceControlAudit)).not.toContain('sourceId:1,revision:1')
  })
})
