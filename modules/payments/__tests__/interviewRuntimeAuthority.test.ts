import mongoose, { type ClientSession } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  INTERVIEW_RUNTIME_AUTHORITY_KINDS,
  InterviewRuntime,
} from '../models/InterviewRuntime'
import {
  createAuthoritativeInterviewRuntimeInSession,
} from '../services/authoritativeInterviewRuntimeService'
import {
  startConsumerInterviewSession,
  type ConsumerInterviewStartStore,
  type ConsumerInterviewStartTransactionRunner,
} from '../services/consumerInterviewStartService'

describe('consumer interview runtime authority', () => {
  it('exposes only consumer usage authority and no organization linkage', () => {
    expect(INTERVIEW_RUNTIME_AUTHORITY_KINDS).toEqual(['consumer_usage'])
    expect(InterviewRuntime.schema.path('organizationId')).toBeUndefined()
    expect(InterviewRuntime.schema.path('inviteAuthorityId')).toBeUndefined()
    expect(InterviewRuntime.schema.path('recruiterUserId')).toBeUndefined()
    expect(
      InterviewRuntime.schema.indexes().map(([, options]) => options.name),
    ).not.toContain('interview_runtime_org_state_v1')
  })

  it('rejects the retired organization-invite authority before persistence', async () => {
    const userId = new mongoose.Types.ObjectId()
    const sessionId = new mongoose.Types.ObjectId()

    await expect(createAuthoritativeInterviewRuntimeInSession(
      {
        userId: userId.toHexString(),
        sessionId: sessionId.toHexString(),
        authorityKind: 'organization_invite',
      },
      {
        session: {} as ClientSession,
        claimedUserId: userId,
        claimedSessionId: sessionId,
      },
      { writesReady: true },
    )).rejects.toMatchObject({ code: 'authority_conflict' })
  })

  it('keeps workspace-bound sessions outside consumer payment authority', async () => {
    const userId = new mongoose.Types.ObjectId()
    const sessionId = new mongoose.Types.ObjectId()
    const store: ConsumerInterviewStartStore = {
      async load() {
        return {
          session: {
            id: sessionId.toHexString(),
            userId: userId.toHexString(),
            organizationId: new mongoose.Types.ObjectId().toHexString(),
            status: 'created',
            config: {},
          },
          runtime: null,
          usage: null,
          paidUnlock: null,
        }
      },
    }
    const transactionRunner: ConsumerInterviewStartTransactionRunner = {
      async run(input, work) {
        return work(
          { inTransaction: () => true } as ClientSession,
          new mongoose.Types.ObjectId(input.userId),
          new mongoose.Types.ObjectId(input.sessionId),
        )
      },
    }
    const secretEnv = 'PR8_INTERVIEW_AUTHORITY_HMAC_V1_SECRET_BASE64'
    const priorSecret = process.env[secretEnv]
    process.env[secretEnv] = Buffer.alloc(32, 7).toString('base64')
    try {
      await expect(startConsumerInterviewSession(
        {
          userId: userId.toHexString(),
          sessionId: sessionId.toHexString(),
        },
        {
          ready: true,
          store,
          transactionRunner,
        },
      )).rejects.toMatchObject({ code: 'not_found_or_ineligible' })
    } finally {
      if (priorSecret === undefined) delete process.env[secretEnv]
      else process.env[secretEnv] = priorSecret
    }
  })
})
