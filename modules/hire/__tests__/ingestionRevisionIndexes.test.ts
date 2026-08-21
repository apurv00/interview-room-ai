import { describe, expect, it } from 'vitest'
import { HireMultimodalAnalysis } from '@modules/hire-multimodal/models/HireMultimodalAnalysis'
import { HireMultimodalAnalysisIngestionEvent } from '@modules/hire-multimodal/models/HireMultimodalAnalysisIngestionEvent'
import { HireRuntimeMultimodalAnalysisOutbox } from '@modules/hire-runtime/models/HireRuntimeMultimodalAnalysisOutbox'
import { HireEngineIngestionEvent } from '../models/HireEngineIngestionEvent'
import { HireMediaAsset } from '../models/HireMediaAsset'

function hasUniqueIndex(
  indexes: ReturnType<typeof HireEngineIngestionEvent.schema.indexes>,
  expected: Record<string, 1 | -1>,
): boolean {
  return indexes.some(
    ([key, options]) =>
      JSON.stringify(key) === JSON.stringify(expected) &&
      options.unique === true,
  )
}

describe('attempt-aware ingestion index declarations', () => {
  it('declares attempt in every result and analysis ledger identity', () => {
    expect(
      hasUniqueIndex(HireEngineIngestionEvent.schema.indexes(), {
        roundId: 1,
        runtimeSessionId: 1,
        attempt: 1,
        revision: 1,
      }),
    ).toBe(true)
    expect(
      hasUniqueIndex(HireMultimodalAnalysisIngestionEvent.schema.indexes(), {
        workspaceId: 1,
        roundId: 1,
        runtimeSessionId: 1,
        attempt: 1,
        revision: 1,
      }),
    ).toBe(true)
    expect(
      hasUniqueIndex(HireRuntimeMultimodalAnalysisOutbox.schema.indexes(), {
        workspaceId: 1,
        roundId: 1,
        runtimeSessionId: 1,
        attempt: 1,
        revision: 1,
      }),
    ).toBe(true)
    expect(
      hasUniqueIndex(HireMultimodalAnalysis.schema.indexes(), {
        workspaceId: 1,
        applicationId: 1,
        roundId: 1,
        attemptId: 1,
        runtimeSessionId: 1,
        revision: 1,
      }),
    ).toBe(true)
  })

  it('declares one durable generation per exact media checkpoint', () => {
    expect(
      hasUniqueIndex(HireMediaAsset.schema.indexes(), {
        ingestionCheckpointKey: 1,
        ingestionCheckpointGeneration: 1,
      }),
    ).toBe(true)
  })
})
