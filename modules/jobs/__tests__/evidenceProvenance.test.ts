import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  captureModelConfigSnapshot: vi.fn(),
}))

vi.mock('@shared/services/scoringProvenance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/services/scoringProvenance')>()
  return {
    ...actual,
    captureModelConfigSnapshot: mocks.captureModelConfigSnapshot,
  }
})

import {
  modelConfigSnapshotOf,
  type ModelConfigSnapshot,
} from '@shared/services/scoringProvenance'
import type { ResolvedModel } from '@shared/services/modelRouter'
import type { TaskSlot } from '@shared/services/taskSlots'
import {
  currentEvidenceProvenance,
  EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
} from '../services/evidenceProvenance'

const resolvedFor = (taskSlot: TaskSlot, model = `${taskSlot}-model`): ResolvedModel => ({
  model,
  provider: 'openai',
  maxTokens: taskSlot === 'jobs.evidence-attribution' ? 1400 : 500,
  reasoningEffort: 'low',
  useToonInput: false,
})

const snapshotFor = (
  taskSlot: TaskSlot,
  options: { model?: string; authoritative?: boolean } = {},
): ModelConfigSnapshot => modelConfigSnapshotOf(
  taskSlot,
  resolvedFor(taskSlot, options.model),
  {
    source: options.authoritative === false ? 'cold-defaults-synthetic' : 'L3-Mongo',
    authoritative: options.authoritative !== false,
  },
)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.captureModelConfigSnapshot.mockImplementation((taskSlot: TaskSlot) =>
    Promise.resolve(snapshotFor(taskSlot)),
  )
})

describe('current evidence provenance allowlist', () => {
  it('contains only exact primary scorer/attribution contracts and their versioned retries', async () => {
    const first = await currentEvidenceProvenance()
    const second = await currentEvidenceProvenance()

    expect(first).toEqual(second)
    expect(first.epoch).toMatch(/^[a-f0-9]{64}$/)
    expect(first.scoring).toHaveLength(4)
    expect(first.attribution).toHaveLength(2)
    expect([...first.scoring, ...first.attribution].every((execution) =>
      execution.usedFallback === false && execution.attemptKind === 'primary'
    )).toBe(true)
    expect(new Set(first.scoring.map((execution) => execution.fingerprint)).size).toBe(4)
    expect(new Set(first.attribution.map((execution) => execution.fingerprint)).size).toBe(2)
    expect(first.attribution.every((execution) =>
      execution.taskSlot === 'jobs.evidence-attribution' &&
      execution.contractVersion === EVIDENCE_ATTRIBUTION_CONTRACT_VERSION
    )).toBe(true)
    expect(mocks.captureModelConfigSnapshot).toHaveBeenCalledWith(
      'interview.evaluate-answer',
      { waitForAuthoritative: true },
    )
  })

  it('refuses an A-to-B config cutover between the two allowlist reads', async () => {
    let calls = 0
    mocks.captureModelConfigSnapshot.mockImplementation((taskSlot: TaskSlot) => {
      const secondPass = calls++ >= 4
      return Promise.resolve(snapshotFor(taskSlot, {
        ...(secondPass && taskSlot === 'interview.evaluate-answer'
          ? { model: 'cutover-model' }
          : {}),
      }))
    })

    await expect(currentEvidenceProvenance()).rejects.toThrow(
      'model config changed while building evidence provenance allowlist',
    )
  })

  it('refuses a synthetic snapshot even when both reads return the same defaults', async () => {
    mocks.captureModelConfigSnapshot.mockImplementation((taskSlot: TaskSlot) =>
      Promise.resolve(snapshotFor(taskSlot, { authoritative: false })),
    )

    await expect(currentEvidenceProvenance()).rejects.toThrow(
      'model config changed while building evidence provenance allowlist',
    )
  })
})
