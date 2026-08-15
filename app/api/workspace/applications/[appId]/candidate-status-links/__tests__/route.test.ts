import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  issue: vi.fn(),
  list: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute:
    (options: any) => async (req: Request, context?: { params?: Record<string, string> }) =>
      options.handler(req, {
        user: { id: 'member-user', email: 'hr@example.com' },
        body: options.schema ? await req.json() : {},
        params: context?.params ?? {},
      }),
}))
vi.mock('@hire/services/workspaceService', () => ({
  requireMembership: mocks.requireMembership,
}))
vi.mock('@/modules/hire-status/validators/hireStatus', () => ({
  IssueCandidateStatusLinkSchema: { pick: () => ({}) },
}))
vi.mock('@/modules/hire-status/services/candidateStatusLinkService', () => ({
  issueCandidateStatusLink: mocks.issue,
  listCandidateStatusLinks: mocks.list,
}))

import { GET, POST } from '../route'

const APPLICATION_ID = '1'.repeat(24)
const LINK_ID = '2'.repeat(24)
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'

const memberLink = {
  id: LINK_ID,
  applicationId: APPLICATION_ID,
  active: true,
  expiresAt: new Date('2026-09-13T10:00:00.000Z'),
  revokedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue({
    workspace: { _id: { toString: () => 'workspace-1' } },
    membership: { _id: { toString: () => 'membership-1' }, name: 'Hiring manager' },
  })
  mocks.list.mockResolvedValue([memberLink])
  mocks.issue.mockResolvedValue({
    link: memberLink,
    statusUrl: `https://hire.example/candidate-status/${LINK_ID}#status=fragment-only-capability`,
    created: true,
  })
})

describe('candidate status-link member routes', () => {
  it('lists only the opaque lifecycle records for the authorized workspace application', async () => {
    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/applications/${APPLICATION_ID}/candidate-status-links`,
      ) as never,
      { params: { appId: APPLICATION_ID } },
    )

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-user',
      email: 'hr@example.com',
    })
    expect(mocks.list).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      applicationId: APPLICATION_ID,
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      candidateStatusLinks: [
        {
          ...memberLink,
          expiresAt: '2026-09-13T10:00:00.000Z',
        },
      ],
    })
  })

  it('derives tenant scope from membership and the path even if a foreign workspace is supplied in the URL', async () => {
    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/applications/${APPLICATION_ID}/candidate-status-links?workspaceId=foreign-workspace`,
      ) as never,
      { params: { appId: APPLICATION_ID } },
    )

    expect(mocks.list).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      applicationId: APPLICATION_ID,
    })
    await expect(response.json()).resolves.toEqual({
      candidateStatusLinks: [
        {
          ...memberLink,
          expiresAt: '2026-09-13T10:00:00.000Z',
        },
      ],
    })
  })

  it('issues one copy-once fragment URL without an email or delivery side effect', async () => {
    const response = await POST(
      new Request(
        `https://hire.example/api/workspace/applications/${APPLICATION_ID}/candidate-status-links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationId: OPERATION_ID,
            expiresInDays: 30,
          }),
        },
      ) as never,
      { params: { appId: APPLICATION_ID } },
    )
    const body = await response.json()

    expect(mocks.issue).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        memberId: 'membership-1',
        memberName: 'Hiring manager',
      },
      {
        applicationId: APPLICATION_ID,
        operationId: OPERATION_ID,
        expiresInDays: 30,
      },
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toMatchObject({
      candidateStatusLink: { id: LINK_ID, applicationId: APPLICATION_ID },
      statusUrl: expect.stringContaining(`#status=`),
      created: true,
    })
    expect(JSON.stringify(body)).not.toContain('candidateEmail')
    expect(JSON.stringify(body)).not.toContain('delivery')
  })

  it('never reconstructs a capability on an idempotent issue retry', async () => {
    mocks.issue.mockResolvedValueOnce({
      link: memberLink,
      statusUrl: null,
      created: false,
    })
    const response = await POST(
      new Request(
        `https://hire.example/api/workspace/applications/${APPLICATION_ID}/candidate-status-links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId: OPERATION_ID }),
        },
      ) as never,
      { params: { appId: APPLICATION_ID } },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      statusUrl: null,
      created: false,
    })
  })
})
