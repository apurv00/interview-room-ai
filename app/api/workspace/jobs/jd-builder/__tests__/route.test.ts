import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  buildSmartJd: vi.fn(),
}))

vi.mock('../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (req: Request) => {
    const body = options.schema ? options.schema.parse(await req.json()) : {}
    return options.handler(req, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
      body,
    })
  },
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  BuildJobDescriptionSchema: { parse: (value: unknown) => value },
}))

vi.mock('@hire/services/jdBuilderService', () => ({
  buildSmartJd: mocks.buildSmartJd,
}))

import { POST } from '../route'

const body = {
  title: 'Platform Manager',
  level: 'manager',
  targetExperienceRange: { minYears: 5, maxYears: 9 },
  mustHaves: ['Production TypeScript'],
  niceToHaves: [],
  location: 'Remote',
  workMode: 'hybrid',
}

describe('POST /api/workspace/jobs/jd-builder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue({
      workspace: {
        _id: '111111111111111111111111',
        companyDescription: 'Canonical onboarding company description.',
        companyBlurb: 'Legacy description that must not win.',
      },
      membership: { _id: '222222222222222222222222', role: 'admin' },
    })
    mocks.buildSmartJd.mockResolvedValue({
      jdText: '# Platform Manager\n\nReviewed JD',
      requirements: [],
      contentHash: 'a'.repeat(64),
    })
  })

  it('derives company context from onboarding and sends the experience range to the AI builder', async () => {
    const response = await POST(
      new Request('https://hire.example/api/workspace/jobs/jd-builder', {
        method: 'POST',
        body: JSON.stringify(body),
      }) as never,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ jdText: '# Platform Manager\n\nReviewed JD' })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.buildSmartJd).toHaveBeenCalledWith({
      role: 'Platform Manager',
      level: 'manager',
      targetExperienceRange: { minYears: 5, maxYears: 9 },
      mustHaves: ['Production TypeScript'],
      niceToHaves: [],
      location: 'Remote',
      workMode: 'hybrid',
      companyBlurb: 'Canonical onboarding company description.',
      jdSource: 'ai_generated',
    })
  })

  it('refuses generation until a legacy workspace completes company onboarding', async () => {
    mocks.requireMembership.mockResolvedValueOnce({
      workspace: { _id: '111111111111111111111111' },
      membership: { _id: '222222222222222222222222', role: 'admin' },
    })

    await expect(
      POST(
        new Request('https://hire.example/api/workspace/jobs/jd-builder', {
          method: 'POST',
          body: JSON.stringify(body),
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_COMPANY_DESCRIPTION_REQUIRED' })
    expect(mocks.buildSmartJd).not.toHaveBeenCalled()
  })
})
