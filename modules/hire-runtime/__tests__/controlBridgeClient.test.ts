import { describe, expect, it } from 'vitest'
import { __controlBridgeClient } from '../services/controlBridgeClient'

describe('runtime control-bridge time budgets', () => {
  it('keeps handoff latency bounded while allowing checksum media ingestion to finish', () => {
    expect(__controlBridgeClient.HANDOFF_TIMEOUT_MS).toBe(15_000)
    expect(__controlBridgeClient.RESULT_INGESTION_TIMEOUT_MS).toBe(240_000)
    expect(__controlBridgeClient.RESULT_INGESTION_TIMEOUT_MS).toBeGreaterThan(
      __controlBridgeClient.HANDOFF_TIMEOUT_MS,
    )
    // The receiving result route and the publishing Inngest route both have
    // 300-second ceilings, leaving one minute for hashing and cleanup.
    expect(__controlBridgeClient.RESULT_INGESTION_TIMEOUT_MS).toBeLessThan(300_000)
  })
})
