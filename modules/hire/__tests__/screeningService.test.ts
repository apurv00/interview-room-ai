import { describe, expect, it } from 'vitest'
import {
  ScreeningPreviewError,
  ScreeningScopeError,
  buildInvitationBatchItemPlan,
  buildScreeningGateConfirmation,
  previewScreeningGate,
} from '../services/screeningService'

const WORKSPACE_A = '111111111111111111111111'
const WORKSPACE_B = '222222222222222222222222'
const JOB_A = '333333333333333333333333'
const ACTOR = '444444444444444444444444'

function application(
  applicationId: string,
  overrides: Partial<{
    workspaceId: string
    jobId: string
    candidateId: string
    createdAt: string
    score: number | null
    stale: boolean
    location: string | null
    experienceYears: number | null
  }> = {},
) {
  return {
    workspaceId: overrides.workspaceId ?? WORKSPACE_A,
    jobId: overrides.jobId ?? JOB_A,
    applicationId,
    candidateId: overrides.candidateId ?? `candidate-${applicationId}`,
    createdAt: overrides.createdAt ?? '2026-08-01T00:00:00.000Z',
    candidateInfo: {
      ...(overrides.location !== undefined ? { location: overrides.location } : {}),
      ...(overrides.experienceYears !== undefined
        ? { experienceYears: overrides.experienceYears }
        : {}),
    },
    ranking: {
      ...(overrides.score !== undefined ? { score: overrides.score } : {}),
      ...(overrides.stale !== undefined ? { stale: overrides.stale } : {}),
    },
  }
}

describe('previewScreeningGate', () => {
  it('orders fresh scores desc, then creation time asc, then application id asc', () => {
    const preview = previewScreeningGate({
      workspaceId: WORKSPACE_A,
      jobId: JOB_A,
      rule: { mode: 'top_n', topN: 3 },
      applications: [
        application('app-z', { score: 92, createdAt: '2026-08-03T00:00:00.000Z' }),
        application('app-b', { score: 92, createdAt: '2026-08-02T00:00:00.000Z' }),
        application('app-a', { score: 92, createdAt: '2026-08-02T00:00:00.000Z' }),
        application('app-low', { score: 91, createdAt: '2026-08-01T00:00:00.000Z' }),
      ],
      now: '2026-08-12T00:00:00.000Z',
    })

    expect(preview.rankedApplications.map((entry) => entry.applicationId)).toEqual([
      'app-a',
      'app-b',
      'app-z',
      'app-low',
    ])
    expect(preview.rankedApplications.map((entry) => entry.rank)).toEqual([1, 2, 3, 4])
    expect(preview.selectedApplicationIds).toEqual(['app-a', 'app-b', 'app-z'])
    expect(preview.cutLine).toEqual({
      mode: 'top_n',
      requestedTopN: 3,
      applicationId: 'app-z',
      rank: 3,
      score: 92,
    })
  })

  it('places stale and unscored applications below all fresh scores', () => {
    const preview = previewScreeningGate({
      workspaceId: WORKSPACE_A,
      jobId: JOB_A,
      rule: { mode: 'top_n', topN: 1 },
      applications: [
        application('stale-high', {
          score: 99,
          stale: true,
          createdAt: '2026-08-01T00:00:00.000Z',
        }),
        application('unscored', { score: null, createdAt: '2026-08-02T00:00:00.000Z' }),
        application('fresh-low', { score: 12, createdAt: '2026-08-03T00:00:00.000Z' }),
      ],
    })

    expect(preview.rankedApplications.map((entry) => [entry.applicationId, entry.scoreState])).toEqual([
      ['fresh-low', 'scored'],
      ['stale-high', 'stale'],
      ['unscored', 'unscored'],
    ])
    expect(preview.selectedApplicationIds).toEqual(['fresh-low'])
    expect(preview.rankedApplications[1]).toMatchObject({
      selectionReason: 'below_cut_line',
      selected: false,
    })

    const thresholdPreview = previewScreeningGate({
      workspaceId: WORKSPACE_A,
      jobId: JOB_A,
      rule: { mode: 'above_threshold', scoreThreshold: 80 },
      applications: preview.rankedApplications.map((entry) =>
        application(entry.applicationId, {
          candidateId: entry.candidateId,
          createdAt: entry.applicationCreatedAt.toISOString(),
          score: entry.score,
          stale: entry.scoreState === 'stale',
        }),
      ),
    })
    expect(thresholdPreview.selectedApplicationIds).toEqual([])
    expect(
      thresholdPreview.rankedApplications.find((entry) => entry.applicationId === 'stale-high'),
    ).toMatchObject({ selectionReason: 'stale_or_unscored' })
  })

  it('knocks out only known location/experience failures; unknown profile data remains eligible', () => {
    const preview = previewScreeningGate({
      workspaceId: WORKSPACE_A,
      jobId: JOB_A,
      rule: {
        mode: 'top_n',
        topN: 2,
        knockoutSettings: { location: ' Bengaluru, India ', experienceFloorYears: 5 },
      },
      applications: [
        application('unknown-profile', { score: 95 }),
        application('known-pass', {
          score: 90,
          location: 'bengaluru, india',
          experienceYears: 5,
        }),
        application('wrong-location', {
          score: 99,
          location: 'Pune, India',
          experienceYears: 10,
        }),
        application('too-little-experience', {
          score: 98,
          location: 'Bengaluru, India',
          experienceYears: 4,
        }),
      ],
    })

    expect(preview.eligibleCount).toBe(2)
    expect(preview.selectedApplicationIds).toEqual(['unknown-profile', 'known-pass'])
    expect(preview.rankedApplications.find((entry) => entry.applicationId === 'unknown-profile')).toMatchObject({
      rank: 1,
      knockoutReasons: [],
      automaticallySelected: true,
    })
    const wrongLocation = preview.rankedApplications.find(
      (entry) => entry.applicationId === 'wrong-location',
    )
    expect(wrongLocation?.rank).toBeUndefined()
    expect(wrongLocation).toMatchObject({
      knockoutReasons: ['location'],
      selected: false,
      selectionReason: 'knockout',
    })
    expect(
      preview.rankedApplications.find((entry) => entry.applicationId === 'too-little-experience'),
    ).toMatchObject({ knockoutReasons: ['experience'], selected: false })
  })

  it('records attributed include/exclude exceptions and creates confirmation-ready batch plans', () => {
    const preview = previewScreeningGate({
      workspaceId: WORKSPACE_A,
      jobId: JOB_A,
      rule: { mode: 'top_n', topN: 1, knockoutSettings: { experienceFloorYears: 5 } },
      applications: [
        application('auto-top', { score: 90, experienceYears: 8 }),
        application('manual-include', { score: 80, experienceYears: 2 }),
      ],
      exceptions: [
        {
          applicationId: 'auto-top',
          action: 'exclude',
          actorMemberId: ACTOR,
          actorName: 'Ava Recruiter',
          note: 'Already interviewing externally',
          at: '2026-08-12T10:00:00.000Z',
        },
        {
          applicationId: 'manual-include',
          action: 'include',
          actorMemberId: ACTOR,
          actorName: 'Ava Recruiter',
          note: 'Strong referral; screen despite the experience floor',
          at: '2026-08-12T10:01:00.000Z',
        },
      ],
    })

    expect(preview.selectedApplicationIds).toEqual(['manual-include'])
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        applicationId: 'auto-top',
        action: 'exclude',
        actorMemberId: ACTOR,
        actorName: 'Ava Recruiter',
        note: 'Already interviewing externally',
      }),
      expect.objectContaining({
        applicationId: 'manual-include',
        action: 'include',
        actorMemberId: ACTOR,
        note: 'Strong referral; screen despite the experience floor',
      }),
    ])
    expect(preview.rankedApplications.find((entry) => entry.applicationId === 'auto-top')).toMatchObject({
      automaticallySelected: true,
      selected: false,
      selectionReason: 'manual_exclude',
    })
    expect(
      preview.rankedApplications.find((entry) => entry.applicationId === 'manual-include'),
    ).toMatchObject({
      automaticallySelected: false,
      selected: true,
      selectionReason: 'manual_include',
    })

    const confirmation = buildScreeningGateConfirmation({
      preview,
      actor: { memberId: ACTOR, name: 'Ava Recruiter' },
      confirmedAt: '2026-08-12T10:02:00.000Z',
    })
    expect(confirmation).toMatchObject({
      workspaceId: WORKSPACE_A,
      jobId: JOB_A,
      status: 'confirmed',
      selectedCount: 1,
      confirmedByMemberId: ACTOR,
      confirmedByName: 'Ava Recruiter',
    })
    expect(buildInvitationBatchItemPlan(preview)).toEqual([
      expect.objectContaining({
        applicationId: 'manual-include',
        selectionReason: 'manual_include',
      }),
    ])
  })

  it('rejects cross-tenant DTOs before producing a preview', () => {
    expect(() =>
      previewScreeningGate({
        workspaceId: WORKSPACE_A,
        jobId: JOB_A,
        rule: { mode: 'top_n', topN: 1 },
        applications: [application('foreign', { workspaceId: WORKSPACE_B, score: 99 })],
      }),
    ).toThrow(ScreeningScopeError)

    const previewForeignJob = () =>
      previewScreeningGate({
        workspaceId: WORKSPACE_A,
        jobId: JOB_A,
        rule: { mode: 'top_n', topN: 1 },
        applications: [application('foreign-job', { jobId: 'other-job', score: 99 })],
      })
    expect(previewForeignJob).toThrow(ScreeningScopeError)
    try {
      previewForeignJob()
    } catch (error) {
      expect(error).toBeInstanceOf(ScreeningPreviewError)
      expect((error as ScreeningPreviewError).code).toBe('SCREENING_SCOPE_MISMATCH')
    }
  })

  it('requires a real actor and note for every exception', () => {
    expect(() =>
      previewScreeningGate({
        workspaceId: WORKSPACE_A,
        jobId: JOB_A,
        rule: { mode: 'top_n', topN: 1 },
        applications: [application('app-1', { score: 90 })],
        exceptions: [
          {
            applicationId: 'app-1',
            action: 'include',
            actorMemberId: ACTOR,
            actorName: 'Ava Recruiter',
            note: ' ',
          },
        ],
      }),
    ).toThrow(/exception note is required/)
  })
})
