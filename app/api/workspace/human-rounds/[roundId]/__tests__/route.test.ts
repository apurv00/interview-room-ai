import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  revokeHumanInterviewKit: vi.fn(),
  submitMemberHumanRoundScorecard: vi.fn(),
}))

vi.mock('../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'member-user', email: 'hr@example.com' },
    body: options.schema ? await req.json() : {},
    params: context?.params ?? {},
  }),
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  revokeHumanInterviewKit: mocks.revokeHumanInterviewKit,
  submitMemberHumanRoundScorecard: mocks.submitMemberHumanRoundScorecard,
  SubmitHumanRoundScorecardSchema: {},
}))

import { POST as revoke } from '../revoke/route'
import { POST as submitScorecard } from '../scorecard/route'

const ROUND = '222222222222222222222222'
const humanRound = {
  _id: { toString: () => ROUND },
  mode: 'member_room',
  status: 'completed',
  openedAt: new Date('2026-08-13T00:00:00.000Z'),
  scorecardSubmittedAt: new Date('2026-08-13T01:00:00.000Z'),
  revokedAt: undefined,
  createdAt: new Date('2026-08-13T00:00:00.000Z'),
}

const scorecard = {
  dimensions: [
    { key: 'role_capability', rating: 4, evidence: 'Strong system design explanation.' },
    { key: 'problem_solving', rating: 4, evidence: 'Methodical incident diagnosis.' },
    { key: 'communication', rating: 5, evidence: 'Clear and concise answers.' },
    { key: 'collaboration', rating: 4, evidence: 'Good conflict-resolution example.' },
  ],
  recommendation: 'yes',
  overallComment: 'Recommend proceeding.',
}

describe('member human-round controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue({ workspace: { _id: 'workspace-1' } })
    mocks.revokeHumanInterviewKit.mockResolvedValue({ ...humanRound, status: 'revoked' })
    mocks.submitMemberHumanRoundScorecard.mockResolvedValue(humanRound)
  })

  it('routes the revoke command only to the human-round lifecycle service', async () => {
    const response = await revoke(
      new Request(`https://hire.example/api/workspace/human-rounds/${ROUND}/revoke`, { method: 'POST' }) as never,
      { params: { roundId: ROUND } },
    )

    expect(mocks.revokeHumanInterviewKit).toHaveBeenCalledWith(expect.anything(), ROUND)
    expect(await response.json()).toMatchObject({ humanRound: { status: 'revoked' } })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('submits the canonical scorecard to the authenticated member service', async () => {
    const response = await submitScorecard(
      new Request(`https://hire.example/api/workspace/human-rounds/${ROUND}/scorecard`, {
        method: 'POST',
        body: JSON.stringify(scorecard),
      }) as never,
      { params: { roundId: ROUND } },
    )

    expect(mocks.submitMemberHumanRoundScorecard).toHaveBeenCalledWith(
      expect.anything(),
      { humanRoundId: ROUND, ...scorecard },
    )
    expect(await response.json()).toMatchObject({ humanRound: { status: 'completed' } })
  })
})
