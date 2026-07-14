import { describe, it, expect, vi } from 'vitest'

const { mockPostingFindById, mockPostingUpdateOne, mockAppFindOne, mockAppUpdateOne, mockAppCreate } = vi.hoisted(() => ({
  mockPostingFindById: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockAppFindOne: vi.fn(),
  mockAppUpdateOne: vi.fn(),
  mockAppCreate: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById, updateOne: mockPostingUpdateOne },
  JobApplication: { findOne: mockAppFindOne, updateOne: mockAppUpdateOne, create: mockAppCreate },
}))

import { recordApplyClick, claimAtsRun } from '../services/applicationService'

const NOW = new Date('2026-07-14T12:00:00Z')

function reset(posting: unknown = { title: 'SDE', company: 'PhonePe', locations: ['Pune'], provenance: [{ sourceId: 'jsearch' }], status: 'open' }) {
  for (const m of [mockPostingFindById, mockPostingUpdateOne, mockAppFindOne, mockAppUpdateOne, mockAppCreate]) m.mockReset()
  mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(posting) }) })
  mockPostingUpdateOne.mockResolvedValue({})
  mockAppUpdateOne.mockResolvedValue({})
  mockAppCreate.mockResolvedValue({})
}

describe('recordApplyClick (machine fact — never conflated with the user claim)', () => {
  it('no row yet → creates at apply_clicked with the click snapshot AND pins the posting', async () => {
    reset()
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) })
    const r = await recordApplyClick('u1', 'j1', { tier: 'direct-ats', url: 'https://x/apply' }, NOW)
    expect(r).toEqual({ status: 'apply_clicked', created: true, transitioned: true })
    const created = mockAppCreate.mock.calls[0][0]
    expect(created.status).toBe('apply_clicked')
    expect(created.statusHistory[0]).toMatchObject({ status: 'apply_clicked', source: 'system' })
    expect(created.jobSnapshot.applyTierAtClick).toBe('direct-ats')
    expect(mockPostingUpdateOne).toHaveBeenCalledWith({ _id: 'j1' }, { $set: { userReferenced: true }, $unset: { purgeAt: 1 } })
  })

  it('saved → apply_clicked transitions with a system history entry, guarded against races', async () => {
    reset()
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status: 'saved' }) }) })
    const r = await recordApplyClick('u1', 'j1', { tier: 'employer' }, NOW)
    expect(r).toEqual({ status: 'apply_clicked', created: false, transitioned: true })
    const [filter, update] = mockAppUpdateOne.mock.calls[0]
    expect(filter.status).toBe('saved') // race guard: a concurrent forward move wins
    expect(update.$set.status).toBe('apply_clicked')
    expect(update.$push.statusHistory).toMatchObject({ status: 'apply_clicked', source: 'system' })
  })

  it('NEVER regresses a forward status — clicking again on applied/interview_scheduled is a no-op', async () => {
    for (const status of ['apply_clicked', 'applied', 'interview_scheduled', 'offer']) {
      reset()
      mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status }) }) })
      const r = await recordApplyClick('u1', 'j1', {}, NOW)
      expect(r).toEqual({ status, created: false, transitioned: false })
      expect(mockAppUpdateOne).not.toHaveBeenCalled()
      expect(mockAppCreate).not.toHaveBeenCalled()
    }
  })

  it('unique-index race on create reports the surviving row instead of throwing', async () => {
    reset()
    mockAppFindOne
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'saved' }) }) })
    mockAppCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
    const r = await recordApplyClick('u1', 'j1', {}, NOW)
    expect(r).toEqual({ status: 'saved', created: false, transitioned: false })
  })

  it('missing posting → null (route 404s); closed posting still records the click (link can outlive the row)', async () => {
    reset(null)
    expect(await recordApplyClick('u1', 'gone', {}, NOW)).toBeNull()
    reset({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'closed' })
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) })
    const r = await recordApplyClick('u1', 'j1', {}, NOW)
    expect(r?.status).toBe('apply_clicked') // a real click on a stale-but-rendered page is still a machine fact
  })
})

describe('claimAtsRun (atomic single-enqueue claim, Codex #521)', () => {
  it('the winner flips the marker (modifiedCount 1); the loser does not enqueue', async () => {
    reset()
    mockPostingUpdateOne.mockReset()
    mockAppUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 })
    const win = await claimAtsRun('u1', 'j1')
    expect(win.claimed).toBe(true)
    expect(win.claimedAt).toBeInstanceOf(Date)
    const [filter] = mockAppUpdateOne.mock.calls[0]
    expect(filter.$or).toBeDefined() // conditional claim, not unconditional set
    mockAppUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 })
    expect((await claimAtsRun('u1', 'j1')).claimed).toBe(false)
  })

  it('a stale (>3min) marker is reclaimable via the same conditional', async () => {
    reset()
    mockAppUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 })
    const now = new Date('2026-07-14T12:00:00Z')
    await claimAtsRun('u1', 'j1', now)
    const [filter] = mockAppUpdateOne.mock.calls[0]
    expect(filter.$or[1].atsRequestedAt.$lt).toEqual(new Date('2026-07-14T11:57:00Z'))
  })
})
