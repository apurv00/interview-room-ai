import { describe, it, expect, vi } from 'vitest'

const { mockPostingFindById, mockPostingUpdateOne, mockAppFindOne, mockAppUpdateOne, mockAppCreate, mockAppFindOneAndUpdate } = vi.hoisted(() => ({
  mockPostingFindById: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockAppFindOne: vi.fn(),
  mockAppUpdateOne: vi.fn(),
  mockAppCreate: vi.fn(),
  mockAppFindOneAndUpdate: vi.fn(),
}))
const { mockSessionFindById } = vi.hoisted(() => ({ mockSessionFindById: vi.fn() }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById, updateOne: mockPostingUpdateOne },
  JobApplication: { findOne: mockAppFindOne, updateOne: mockAppUpdateOne, create: mockAppCreate, findOneAndUpdate: mockAppFindOneAndUpdate },
  InterviewSession: { findById: mockSessionFindById },
}))

import { recordApplyClick, claimAtsRun, transitionStatus, reportBrokenLink, recordPracticeEvidence, saveTailoredVersion } from '../services/applicationService'

const NOW = new Date('2026-07-14T12:00:00Z')

function reset(posting: unknown = { title: 'SDE', company: 'PhonePe', locations: ['Pune'], provenance: [{ sourceId: 'jsearch' }], status: 'open' }) {
  for (const m of [mockPostingFindById, mockPostingUpdateOne, mockAppFindOne, mockAppUpdateOne, mockAppCreate, mockAppFindOneAndUpdate]) m.mockReset()
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

describe('transitionStatus (user claims — loose machine, §2)', () => {
  it('applied sets appliedAt + a user-source history entry, and reports the FROM status', async () => {
    reset()
    mockAppFindOneAndUpdate.mockResolvedValueOnce({ status: 'apply_clicked' })
    const r = await transitionStatus('u1', 'j1', 'applied', undefined, NOW)
    expect(r).toEqual({ ok: true, status: 'applied', from: 'apply_clicked' })
    const [, update] = mockAppFindOneAndUpdate.mock.calls[0]
    expect(update.$set).toEqual({ status: 'applied', appliedAt: NOW })
    expect(update.$push.statusHistory).toMatchObject({ status: 'applied', source: 'user' })
  })

  it('backward corrections and recoveries are allowed; machine-only apply_clicked is not settable', async () => {
    reset()
    mockAppFindOneAndUpdate.mockResolvedValue({ status: 'applied' })
    expect((await transitionStatus('u1', 'j1', 'saved', NOW)).ok).toBe(true) // backward correction
    expect((await transitionStatus('u1', 'j1', 'ghosted', undefined, NOW)).ok).toBe(true)
    expect((await transitionStatus('u1', 'j1', 'apply_clicked' as never, undefined, NOW)).ok).toBe(false)
    expect((await transitionStatus('u1', 'j1', 'nonsense' as never, undefined, NOW)).ok).toBe(false)
  })

  it('no application row → ok:false (route 404s)', async () => {
    reset()
    mockAppFindOneAndUpdate.mockResolvedValueOnce(null)
    expect((await transitionStatus('u1', 'j1', 'applied', undefined, NOW)).ok).toBe(false)
  })
})

describe('reportBrokenLink (§4b crowd healing)', () => {
  it('NO recorded click (missing row OR saved-only) → rejected, demotion never fires (Codex #522)', async () => {
    reset()
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 0 }) // covers both: no row, and a row without apply_clicked in history
    const r = await reportBrokenLink('u1', 'j1', 'https://dead.example/apply', NOW)
    expect(r).toEqual({ ok: false })
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    // the filter itself demands the machine fact
    expect(mockAppUpdateOne.mock.calls[0][0]).toMatchObject({ 'statusHistory.status': 'apply_clicked' })
  })

  it('records on the application AND increments the matching provenance rung', async () => {
    reset()
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1 })
    await reportBrokenLink('u1', 'j1', 'https://dead.example/apply', NOW)
    const [appFilter, appUpdate] = mockAppUpdateOne.mock.calls[0]
    expect(appFilter).toEqual({ userId: 'u1', jobPostingId: 'j1', 'statusHistory.status': 'apply_clicked' })
    expect(appUpdate.$push.brokenLinkReports).toMatchObject({ url: 'https://dead.example/apply', reportedAt: NOW })
    const [postFilter, postUpdate, postOpts] = mockPostingUpdateOne.mock.calls[0]
    expect(postFilter).toEqual({ _id: 'j1', 'provenance.applyUrl': 'https://dead.example/apply' })
    // ALL rungs carrying the dead URL take the report (arrayFilters, not $)
    expect(postUpdate).toEqual({ $inc: { 'provenance.$[elem].brokenReportCount': 1 } })
    expect(postOpts).toEqual({ arrayFilters: [{ 'elem.applyUrl': 'https://dead.example/apply' }] })
  })
})

describe('recordPracticeEvidence (Wave 4.3 — the evidence ticker source)', () => {
  function sessionChain(doc: unknown) {
    mockSessionFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) })
  }
  function appUpdateChain(doc: unknown) {
    mockAppFindOneAndUpdate.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) })
  }

  it('jobs-attributed session lands in practiceSessionIds via $addToSet (idempotent), count capped at 3', async () => {
    reset()
    mockSessionFindById.mockReset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: 'j1', applicationId: 'app1' } })
    appUpdateChain({ practiceSessionIds: ['a', 'b', 'c', 'd'] })
    const r = await recordPracticeEvidence('u1', 's1')
    expect(r).toEqual({ recorded: true, evidenceCount: 3 })
    const [filter, update] = mockAppFindOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({ _id: 'app1', userId: 'u1' }) // userId guard
    expect(update).toEqual({ $addToSet: { practiceSessionIds: 's1' } })
  })

  it('no applicationId falls back to the jobPostingId row; non-jobs / foreign sessions record nothing', async () => {
    reset()
    mockSessionFindById.mockReset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: 'j9' } })
    appUpdateChain({ practiceSessionIds: ['s1'] })
    const r = await recordPracticeEvidence('u1', 's1')
    expect(r).toEqual({ recorded: true, evidenceCount: 1 })
    expect(mockAppFindOneAndUpdate.mock.calls[0][0]).toEqual({ userId: 'u1', jobPostingId: 'j9' })

    // non-jobs session
    mockAppFindOneAndUpdate.mockClear()
    sessionChain({ _id: 's2', userId: 'u1', attribution: undefined })
    expect(await recordPracticeEvidence('u1', 's2')).toEqual({ recorded: false })
    // another user's session id must never attach
    sessionChain({ _id: 's3', userId: 'someone-else', attribution: { source: 'jobs', jobId: 'j1' } })
    expect(await recordPracticeEvidence('u1', 's3')).toEqual({ recorded: false })
    expect(mockAppFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('no application row to attach to → recorded:false (practiced without saving or clicking)', async () => {
    reset()
    mockSessionFindById.mockReset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: 'j1' } })
    appUpdateChain(null)
    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
  })
})

describe('saveTailoredVersion (§2 — latest-wins, never a cap seat)', () => {
  const { gzipSync } = require('zlib')
  const PAYLOAD = { tailoredText: 'TAILORED', sourceResumeId: 'r1', matchScore: 78, addedKeywords: ['sql'], missingKeywords: ['kafka'] }
  const PASTE_PAYLOAD = { tailoredText: 'TAILORED', sourceResumeId: undefined, matchScore: 78, addedKeywords: [], missingKeywords: [] }
  function postingChain(doc: unknown) {
    mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) })
  }

  it('existing row: $set tailoredVersion with jdHash bound to the posting JD', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'open', jdCompressed: gzipSync(Buffer.from('the jd body')) })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1 })
    const r = await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)
    expect(r).toEqual({ ok: true })
    const [filter, update] = mockAppUpdateOne.mock.calls[0]
    expect(filter).toEqual({ userId: 'u1', jobPostingId: 'j1' })
    expect(update.$set.tailoredVersion).toMatchObject({ tailoredText: 'TAILORED', matchScore: 78, createdAt: NOW })
    expect(update.$set.tailoredVersion.jdHash).toHaveLength(20)
    expect(mockAppCreate).not.toHaveBeenCalled()
  })

  it('no row: implicit save — creates at saved WITH the tailored version and pins the posting', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: ['Pune'], provenance: [{ sourceId: 'jsearch' }], status: 'open', jdCompressed: undefined })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })
    const r = await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)
    expect(r).toEqual({ ok: true })
    const created = mockAppCreate.mock.calls[0][0]
    expect(created.status).toBe('saved')
    expect(created.tailoredVersion.tailoredText).toBe('TAILORED')
    expect(mockPostingUpdateOne).toHaveBeenCalledWith({ _id: 'j1' }, { $set: { userReferenced: true }, $unset: { purgeAt: 1 } })
  })

  it('paste-sourced tailors (no sourceResumeId) create cleanly — empty string never reaches Mongoose (Codex P1 #526)', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'open' })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })
    const r = await saveTailoredVersion('u1', 'j1', PASTE_PAYLOAD, NOW)
    expect(r).toEqual({ ok: true })
    const created = mockAppCreate.mock.calls[0][0]
    expect(created.tailoredVersion.sourceResumeId).toBeUndefined() // absent, not ''
    expect('sourceResumeId' in created.tailoredVersion && created.tailoredVersion.sourceResumeId === '').toBe(false)
  })

  it('missing posting → ok:false; create race falls back to update', async () => {
    reset()
    postingChain(null)
    expect(await saveTailoredVersion('u1', 'gone', PAYLOAD, NOW)).toEqual({ ok: false })
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'open' })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 0 }).mockResolvedValueOnce({ matchedCount: 1 })
    mockAppCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
    expect(await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).toEqual({ ok: true })
  })
})
