import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockAggregate,
  mockConnectDB,
  mockCountDocuments,
  mockCycleFind,
  mockGetConfig,
  mockGetServerSession,
  mockSourceFind,
} = vi.hoisted(() => ({
  mockAggregate: vi.fn(),
  mockConnectDB: vi.fn(),
  mockCountDocuments: vi.fn(),
  mockCycleFind: vi.fn(),
  mockGetConfig: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockSourceFind: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
}))
vi.mock('@shared/db/models', () => ({
  JobSourceConfig: { find: (...args: unknown[]) => mockSourceFind(...args) },
  JobIngestCycle: { find: (...args: unknown[]) => mockCycleFind(...args) },
  JobPosting: {
    aggregate: (...args: unknown[]) => mockAggregate(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
  JobsVerdictConfig: { getConfig: (...args: unknown[]) => mockGetConfig(...args) },
}))

import { GET } from '../route'

function leanRows(rows: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(rows) }),
  }
}

function sortedRows(rows: unknown[]) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue(leanRows(rows)),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: 'admin-1', role: 'platform_admin' } })
  mockConnectDB.mockResolvedValue(undefined)
  mockSourceFind.mockReturnValue(leanRows([]))
  mockCycleFind.mockReturnValue(sortedRows([]))
  mockAggregate
    .mockResolvedValueOnce([{ _id: 'open', n: 12 }, { _id: 'closed', n: 8 }])
    .mockResolvedValueOnce([])
  mockGetConfig.mockResolvedValue({ collectionEnabled: false, enforceEnabled: false })
})

describe('GET /api/cms/jobs-ingest — retained source-control capacity', () => {
  it('raises the warning at 20,000 retained rows and reports exact headroom', async () => {
    mockCountDocuments.mockImplementation((filter: Record<string, unknown>) => (
      Promise.resolve(Object.keys(filter).length === 0 ? 20_000 : 0)
    ))

    const response = await GET()
    const payload = await response.json()

    expect(payload.corpus).toEqual({
      open: 12,
      closed: 8,
      retained: 20_000,
      retainedWarningAt: 20_000,
      retainedLimit: 25_000,
      retainedHeadroom: 5_000,
      retainedWarning: true,
    })
  })

  it('reports a negative headroom when the retained corpus is already over limit', async () => {
    mockCountDocuments.mockImplementation((filter: Record<string, unknown>) => (
      Promise.resolve(Object.keys(filter).length === 0 ? 25_001 : 0)
    ))

    const response = await GET()
    const payload = await response.json()

    expect(payload.corpus).toMatchObject({
      retained: 25_001,
      retainedHeadroom: -1,
      retainedWarning: true,
    })
  })
})
