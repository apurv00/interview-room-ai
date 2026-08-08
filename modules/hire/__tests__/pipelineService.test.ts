import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockJob = { create: vi.fn(), find: vi.fn(), findOne: vi.fn(), findOneAndUpdate: vi.fn() }
const mockCandidate = { create: vi.fn(), find: vi.fn(), findOne: vi.fn() }
const mockApplication = {
  create: vi.fn(),
  find: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  aggregate: vi.fn(),
}
const mockRound = { find: vi.fn() }

vi.mock('../models', async () => {
  const actual =
    await vi.importActual<typeof import('../models')>('../models')
  return {
    HIRE_STAGES: actual.HIRE_STAGES,
    TERMINAL_STAGES: actual.TERMINAL_STAGES,
    HireJob: {
      create: (...a: unknown[]) => mockJob.create(...a),
      find: (...a: unknown[]) => mockJob.find(...a),
      findOne: (...a: unknown[]) => mockJob.findOne(...a),
      findOneAndUpdate: (...a: unknown[]) => mockJob.findOneAndUpdate(...a),
    },
    HireCandidate: {
      create: (...a: unknown[]) => mockCandidate.create(...a),
      find: (...a: unknown[]) => mockCandidate.find(...a),
      findOne: (...a: unknown[]) => mockCandidate.findOne(...a),
    },
    HireApplication: {
      create: (...a: unknown[]) => mockApplication.create(...a),
      find: (...a: unknown[]) => mockApplication.find(...a),
      findOne: (...a: unknown[]) => mockApplication.findOne(...a),
      findOneAndUpdate: (...a: unknown[]) => mockApplication.findOneAndUpdate(...a),
      updateOne: (...a: unknown[]) => mockApplication.updateOne(...a),
      aggregate: (...a: unknown[]) => mockApplication.aggregate(...a),
    },
    HireRound: { find: (...a: unknown[]) => mockRound.find(...a) },
  }
})

import {
  createJob,
  updateJobStatus,
  addCandidate,
  createApplication,
  moveStage,
} from '../services/pipelineService'
import type { MembershipContext } from '../services/workspaceService'

const CTX = {
  workspace: { _id: 'ws-A', name: 'Acme' },
  membership: { _id: 'm1', userId: 'u1', email: 'hr@acme.com', name: 'HR One', role: 'admin' },
} as unknown as MembershipContext

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createJob', () => {
  it('stamps workspaceId and the creating member', async () => {
    mockJob.create.mockResolvedValue({ _id: 'j1' })
    await createJob(CTX, { title: 'Backend Engineer', jdText: 'x'.repeat(60) })
    const doc = mockJob.create.mock.calls[0][0]
    expect(doc.workspaceId).toBe('ws-A')
    expect(doc.createdBy).toBe('u1')
    expect(doc.status).toBe('open')
  })
})

describe('updateJobStatus', () => {
  it('requires a note to close', async () => {
    await expect(
      updateJobStatus(CTX, 'j1', { status: 'closed' })
    ).rejects.toMatchObject({ code: 'CLOSE_NOTE_REQUIRED' })
    expect(mockJob.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('records who closed and scopes by workspace', async () => {
    mockJob.findOneAndUpdate.mockResolvedValue({ _id: 'j1', status: 'closed' })
    await updateJobStatus(CTX, 'j1', { status: 'closed', closeNote: 'Hired Jane.' })
    const [filter, update] = mockJob.findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({ _id: 'j1', workspaceId: 'ws-A' })
    expect(update.$set.closeNote).toBe('Hired Jane.')
    expect(update.$set.closedBy).toBe('u1')
    expect(update.$set.closedAt).toBeInstanceOf(Date)
  })
})

describe('addCandidate', () => {
  it('lowercases email and stamps workspace + source', async () => {
    mockCandidate.create.mockResolvedValue({ _id: 'c1' })
    await addCandidate(CTX, { name: 'Jane', email: 'Jane@Ex.com' })
    const doc = mockCandidate.create.mock.calls[0][0]
    expect(doc.email).toBe('jane@ex.com')
    expect(doc.workspaceId).toBe('ws-A')
    expect(doc.source).toBe('manual')
  })

  it('maps duplicate email to 409 CANDIDATE_EXISTS', async () => {
    mockCandidate.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))
    await expect(addCandidate(CTX, { name: 'J', email: 'j@x.com' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CANDIDATE_EXISTS',
    })
  })
})

describe('createApplication', () => {
  it('validates BOTH job and candidate inside the workspace (cross-tenant ids 404)', async () => {
    mockJob.findOne.mockResolvedValue({ _id: 'j1', status: 'open' })
    mockCandidate.findOne.mockResolvedValue(null) // foreign candidate id
    await expect(
      createApplication(CTX, { jobId: 'j1', candidateId: 'foreign' })
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(mockCandidate.findOne).toHaveBeenCalledWith({ _id: 'foreign', workspaceId: 'ws-A' })
    expect(mockApplication.create).not.toHaveBeenCalled()
  })

  it('refuses closed jobs and records the created event with the actor', async () => {
    mockJob.findOne.mockResolvedValue({ _id: 'j1', status: 'closed' })
    mockCandidate.findOne.mockResolvedValue({ _id: 'c1' })
    await expect(
      createApplication(CTX, { jobId: 'j1', candidateId: 'c1' })
    ).rejects.toMatchObject({ code: 'JOB_CLOSED' })

    mockJob.findOne.mockResolvedValue({ _id: 'j1', status: 'open' })
    mockApplication.create.mockResolvedValue({ _id: 'a1' })
    await createApplication(CTX, { jobId: 'j1', candidateId: 'c1' })
    const doc = mockApplication.create.mock.calls[0][0]
    expect(doc.events[0]).toMatchObject({ type: 'created', actorName: 'HR One', actorUserId: 'u1' })
    expect(doc.events[0].at).toBeInstanceOf(Date)
  })
})

describe('moveStage', () => {
  function armApp(stage: string) {
    mockApplication.findOne.mockResolvedValue({ _id: 'a1', stage })
  }

  it('advance moves exactly one step and records actor + timestamps', async () => {
    armApp('new')
    mockApplication.findOneAndUpdate.mockResolvedValue({ _id: 'a1', stage: 'screened' })
    await moveStage(CTX, 'a1', { action: 'advance' })
    const [filter, update] = mockApplication.findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({ _id: 'a1', workspaceId: 'ws-A', stage: 'new' })
    expect(update.$set.stage).toBe('screened')
    expect(update.$push.events).toMatchObject({
      type: 'stage_move',
      from: 'new',
      to: 'screened',
      actorUserId: 'u1',
      actorName: 'HR One',
    })
    expect(update.$push.events.at).toBeInstanceOf(Date)
  })

  it('marking Hired (advance from offer) requires a decision note', async () => {
    armApp('offer')
    await expect(moveStage(CTX, 'a1', { action: 'advance' })).rejects.toMatchObject({
      code: 'DECISION_NOTE_REQUIRED',
    })

    mockApplication.findOneAndUpdate.mockResolvedValue({ _id: 'a1', stage: 'hired' })
    await moveStage(CTX, 'a1', { action: 'advance', note: 'Strongest evidence.' })
    const [, update] = mockApplication.findOneAndUpdate.mock.calls[0]
    expect(update.$set.stage).toBe('hired')
    expect(update.$set.decisionNote).toBe('Strongest evidence.')
  })

  it('reject works from any non-terminal stage; terminal stages are frozen', async () => {
    armApp('shortlist')
    mockApplication.findOneAndUpdate.mockResolvedValue({ _id: 'a1', stage: 'rejected' })
    await moveStage(CTX, 'a1', { action: 'reject' })
    expect(mockApplication.findOneAndUpdate.mock.calls[0][1].$set.stage).toBe('rejected')

    armApp('hired')
    await expect(moveStage(CTX, 'a1', { action: 'reject' })).rejects.toMatchObject({
      code: 'STAGE_TERMINAL',
    })
  })

  it('a raced concurrent move surfaces as 409 STAGE_RACE, not a silent double-move', async () => {
    armApp('new')
    mockApplication.findOneAndUpdate.mockResolvedValue(null)
    await expect(moveStage(CTX, 'a1', { action: 'advance' })).rejects.toMatchObject({
      code: 'STAGE_RACE',
    })
  })

  it('never auto-advances to rejected via advance', async () => {
    armApp('rejected')
    await expect(moveStage(CTX, 'a1', { action: 'advance' })).rejects.toMatchObject({
      code: 'STAGE_TERMINAL',
    })
  })
})
