import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  candidateFind: vi.fn(),
  applicationFind: vi.fn(),
  jobFind: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))

vi.mock('../models', () => ({
  HireCandidate: { find: mocks.candidateFind },
  HireApplication: { find: mocks.applicationFind },
  HireJob: { find: mocks.jobFind },
}))

import {
  __workspaceCsv,
  buildWorkspaceCandidatesCsv,
} from '../services/workspaceCsvExportService'
import type { MembershipContext } from '../services/workspaceService'

const ctx = { workspace: { _id: 'ws-1' }, membership: { _id: 'member-1' } } as never as MembershipContext

function sortedLean(value: unknown[]) {
  return { sort: () => ({ lean: () => Promise.resolve(value) }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.candidateFind.mockReturnValue(
    sortedLean([
      {
        _id: { toString: () => 'candidate-1' },
        name: '=IMPORTXML("https://bad")',
        email: 'same-as-b2c@example.com',
        phone: '+91 99999 99999',
        source: 'manual',
        resumeFileName: 'resume,"final".pdf',
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-02T00:00:00Z'),
      },
    ]),
  )
  mocks.applicationFind.mockReturnValue(
    sortedLean([
      {
        candidateId: { toString: () => 'candidate-1' },
        jobId: { toString: () => 'job-1' },
        stage: 'shortlist',
        decisionNote: 'Strong, evidence-backed fit',
        updatedAt: new Date('2026-08-03T00:00:00Z'),
      },
    ]),
  )
  mocks.jobFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve([{ _id: { toString: () => 'job-1' }, title: 'Engineer' }]),
    }),
  })
})

describe('buildWorkspaceCandidatesCsv', () => {
  it('exports candidate/application status with workspace scope and spreadsheet safety', async () => {
    const csv = await buildWorkspaceCandidatesCsv(ctx)

    expect(mocks.candidateFind).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    expect(mocks.applicationFind).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    expect(mocks.jobFind).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    expect(csv).toContain('"same-as-b2c@example.com"')
    expect(csv).toContain('"shortlist"')
    expect(csv).toContain('"Engineer"')
    expect(csv).toContain('"\'=IMPORTXML(""https://bad"")"')
    expect(csv).toContain('"resume,""final"".pdf"')
  })

  it('quotes every field and neutralizes all spreadsheet formula prefixes', () => {
    expect(__workspaceCsv.safeCell('+SUM(1,1)')).toBe('"\'+SUM(1,1)"')
    expect(__workspaceCsv.safeCell('plain')).toBe('"plain"')
  })
})
