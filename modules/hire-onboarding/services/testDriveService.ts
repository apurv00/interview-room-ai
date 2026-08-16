import crypto from 'crypto'
import mongoose from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
  HireJob,
  HireJobRequirementVersion,
  HireRound,
  revokeRound,
  sendAiRound,
  connectHireControlDB,
  withActiveHireWorkspaceWriteTransaction,
  type MembershipContext,
} from '@hire-onboarding-boundary'
import {
  HireOnboardingTestDrive,
  HIRE_ONBOARDING_TEST_DRIVE_COLLECTION,
  type IHireOnboardingTestDrive,
} from '../models'
import type {
  HireOnboardingTestDriveAuditView,
  HireOnboardingTestDriveCoordinate,
  HireOnboardingTestDriveView,
} from '../types'
import {
  StartHireOnboardingTestDriveSchema,
  type StartHireOnboardingTestDrivePayload,
} from '../validators/hireOnboarding'
import { kickHireOnboardingTestDriveCleanup } from './testDriveLifecycleService'
import { ensureHireSystemDepartment } from '@hire-departments'

export const HIRE_ONBOARDING_TEST_DRIVE_RETENTION_DAYS = 14

const TEST_DRIVE_LABEL = 'Interview yourself' as const
const TEST_DRIVE_JOB_TITLE = 'Practice interview — Interview yourself'
const TEST_DRIVE_CANDIDATE_NAME = 'Practice candidate — Interview yourself'
const TEST_DRIVE_JOB_DESCRIPTION = [
  'This is a clearly labelled IPG Hire practice interview for the current workspace member.',
  'It is not a live role and must be excluded from operational and reporting aggregates.',
  'Use the interview to experience the standard candidate consent, recording disclosure, and AI round flow.',
].join('\n\n')
const TEST_DRIVE_REQUIREMENTS = [
  {
    id: 'practice-communication',
    text: 'Explain a work example clearly, including context, actions, and outcome.',
    importance: 'must_have' as const,
  },
  {
    id: 'practice-reflection',
    text: 'Reflect on a lesson learned and identify a practical next step.',
    importance: 'nice_to_have' as const,
  },
]
const TEST_DRIVE_INPUT = {
  role: 'Practice interview',
  level: 'Test drive',
  mustHaves: [TEST_DRIVE_REQUIREMENTS[0].text],
  niceToHaves: [TEST_DRIVE_REQUIREMENTS[1].text],
  location: 'Remote',
  workMode: 'remote' as const,
}
const TEST_DRIVE_REQUIREMENT_HASH = sha256(
  JSON.stringify({
    input: TEST_DRIVE_INPUT,
    proseJd: TEST_DRIVE_JOB_DESCRIPTION,
    requirements: TEST_DRIVE_REQUIREMENTS,
  }),
)

type StartResult = {
  testDrive: HireOnboardingTestDriveView
  /** Present only on the original successful POST response. */
  inviteUrl: string | null
  created: boolean
  emailSent: boolean | null
}

type ProvisionedDrive = {
  testDrive: IHireOnboardingTestDrive
  newlyProvisioned: boolean
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function toId(value: { toString(): string } | string): string {
  return value.toString()
}

function memberActorName(ctx: MembershipContext): string {
  const name = ctx.membership.name?.trim()
  return name && name.length <= 120 ? name : 'Workspace member'
}

function currentMemberEmail(ctx: MembershipContext): string {
  const email = ctx.membership.email?.trim().toLowerCase()
  if (!email || email.length > 254) {
    throw new AppError(
      'A current member email is required to start the practice interview',
      409,
      'TEST_DRIVE_MEMBER_EMAIL_UNAVAILABLE',
    )
  }
  return email
}

function validateStartInput(input: StartHireOnboardingTestDrivePayload): StartHireOnboardingTestDrivePayload {
  const parsed = StartHireOnboardingTestDriveSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('Invalid test-drive request', 400, 'INVALID_TEST_DRIVE_INPUT')
  }
  return parsed.data
}

function testDriveCleanupAfter(now: Date): Date {
  return new Date(now.getTime() + HIRE_ONBOARDING_TEST_DRIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
}

export function toHireOnboardingTestDriveView(
  testDrive: IHireOnboardingTestDrive,
): HireOnboardingTestDriveView {
  return {
    id: toId(testDrive._id),
    label: TEST_DRIVE_LABEL,
    state: testDrive.state,
    jobId: toId(testDrive.jobId),
    candidateId: toId(testDrive.candidateId),
    applicationId: toId(testDrive.applicationId),
    roundId: testDrive.roundId ? toId(testDrive.roundId) : null,
    issuedAt: testDrive.createdAt,
    cleanupAfter: testDrive.cleanupAfter,
    removedAt: testDrive.removedAt ?? null,
  }
}

/**
 * Narrow source-projection input for the later audit read model. It deliberately
 * excludes candidate email, invite capability, token/hash, and delivery detail.
 */
export function toHireOnboardingTestDriveAuditView(
  testDrive: IHireOnboardingTestDrive,
): HireOnboardingTestDriveAuditView {
  return {
    ...toHireOnboardingTestDriveView(testDrive),
    workspaceId: toId(testDrive.workspaceId),
    issuedByMemberId: toId(testDrive.issuedByMemberId),
    issuedByName: testDrive.issuedByName,
    removedByMemberId: testDrive.removedByMemberId
      ? toId(testDrive.removedByMemberId)
      : null,
    removedByName: testDrive.removedByName ?? null,
  }
}

/**
 * Explicit aggregate-boundary helper for operations/reports. Apply it before
 * grouping/counting any Hire graph stream. All retained test-drive records
 * match, including a member-removed record, so synthetic history never enters
 * an aggregate during the interval before lifecycle cleanup deletes its graph.
 */
export function buildHireOnboardingTestDriveExclusionStages(input: {
  coordinate: HireOnboardingTestDriveCoordinate
  sourceIdField?: string
  workspaceIdField?: string
}): Array<Record<string, unknown>> {
  const sourceIdField = input.sourceIdField ?? '_id'
  const workspaceIdField = input.workspaceIdField ?? 'workspaceId'
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(sourceIdField) || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(workspaceIdField)) {
    throw new AppError('Invalid aggregate source field', 500, 'INVALID_TEST_DRIVE_AGGREGATE_FIELD')
  }

  return [
    {
      $lookup: {
        from: HIRE_ONBOARDING_TEST_DRIVE_COLLECTION,
        let: {
          testDriveWorkspaceId: `$${workspaceIdField}`,
          testDriveCoordinateId: `$${sourceIdField}`,
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$workspaceId', '$$testDriveWorkspaceId'] },
                  { $eq: [`$${input.coordinate}`, '$$testDriveCoordinateId'] },
                  { $eq: ['$excludeFromAggregates', true] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: '__hireOnboardingTestDrive',
      },
    },
    { $match: { '__hireOnboardingTestDrive.0': { $exists: false } } },
    { $unset: '__hireOnboardingTestDrive' },
  ]
}

async function findDriveForOperation(
  ctx: MembershipContext,
  operationId: string,
): Promise<IHireOnboardingTestDrive | null> {
  return HireOnboardingTestDrive.findOne({
    workspaceId: ctx.workspace._id,
    issuedByMemberId: ctx.membership._id,
    operationId,
  })
}

async function findActiveDriveForMember(
  ctx: MembershipContext,
): Promise<IHireOnboardingTestDrive | null> {
  return HireOnboardingTestDrive.findOne({
    workspaceId: ctx.workspace._id,
    issuedByMemberId: ctx.membership._id,
    active: true,
  }).sort({ createdAt: -1 })
}

function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: number }).code === 11000
}

async function provisionTestDrive(
  ctx: MembershipContext,
  operationId: string,
): Promise<ProvisionedDrive> {
  const actorName = memberActorName(ctx)
  const memberEmail = currentMemberEmail(ctx)

  try {
    return await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        const operationMatch = await HireOnboardingTestDrive.findOne({
          workspaceId: ctx.workspace._id,
          issuedByMemberId: ctx.membership._id,
          operationId,
        }).session(session)
        if (operationMatch) {
          return { testDrive: operationMatch, newlyProvisioned: false }
        }

        const activeMatch = await HireOnboardingTestDrive.findOne({
          workspaceId: ctx.workspace._id,
          issuedByMemberId: ctx.membership._id,
          active: true,
        }).session(session)
        if (activeMatch) {
          return { testDrive: activeMatch, newlyProvisioned: false }
        }

        // Deliberately never call the normal add-or-merge pipeline. The
        // preflight plus candidate's workspace-email unique index make an
        // existing member email a hard stop rather than an attachment point.
        const existingCandidate = await HireCandidate.exists({
          workspaceId: ctx.workspace._id,
          email: memberEmail,
        }).session(session)
        if (existingCandidate) {
          throw new AppError(
            'Your member email already belongs to a candidate in this workspace. Test drive setup stopped without attaching to that candidate.',
            409,
            'TEST_DRIVE_MEMBER_EMAIL_ALREADY_EXISTS',
          )
        }

        const now = new Date()
        const jobId = new mongoose.Types.ObjectId()
        const candidateId = new mongoose.Types.ObjectId()
        const applicationId = new mongoose.Types.ObjectId()
        const requirementVersionId = new mongoose.Types.ObjectId()
        // The practice graph is still a real HireJob for the purpose of
        // exercising the candidate flow. Keep the mandatory department
        // invariant without exposing this non-reportable system department to
        // ordinary job creation or department selection.
        const onboardingDepartment = await ensureHireSystemDepartment({
          workspaceId: ctx.workspace._id,
          kind: 'onboarding',
          session,
        })

        await HireJob.create(
          [
            {
              _id: jobId,
              workspaceId: ctx.workspace._id,
              departmentId: onboardingDepartment._id,
              title: TEST_DRIVE_JOB_TITLE,
              jdText: TEST_DRIVE_JOB_DESCRIPTION,
              status: 'open',
              activeRequirementVersionId: requirementVersionId,
              activeRequirementVersion: 1,
              events: [],
              createdByMemberId: ctx.membership._id,
              createdByName: actorName,
            },
          ],
          { session },
        )
        await HireJobRequirementVersion.create(
          [
            {
              _id: requirementVersionId,
              workspaceId: ctx.workspace._id,
              jobId,
              version: 1,
              state: 'active',
              input: TEST_DRIVE_INPUT,
              proseJd: TEST_DRIVE_JOB_DESCRIPTION,
              requirements: TEST_DRIVE_REQUIREMENTS,
              contentHash: TEST_DRIVE_REQUIREMENT_HASH,
              createdByMemberId: ctx.membership._id,
              createdByName: actorName,
            },
          ],
          { session },
        )
        await HireCandidate.create(
          [
            {
              _id: candidateId,
              workspaceId: ctx.workspace._id,
              name: TEST_DRIVE_CANDIDATE_NAME,
              // Existing AI invitation delivery uses this candidate email;
              // because it is the authenticated member's email, no third
              // party can receive a practice invite.
              email: memberEmail,
              source: 'manual',
              sourceHistory: ['manual'],
              createdByMemberId: ctx.membership._id,
              createdByName: actorName,
            },
          ],
          { session },
        )
        await HireApplication.create(
          [
            {
              _id: applicationId,
              workspaceId: ctx.workspace._id,
              jobId,
              candidateId,
              stage: 'new',
              events: [
                {
                  type: 'created',
                  actorMemberId: ctx.membership._id,
                  actorName,
                  note: 'Practice test drive — excluded from operations and reporting aggregates.',
                  operationId,
                  at: now,
                },
              ],
              createdByMemberId: ctx.membership._id,
              createdByName: actorName,
            },
          ],
          { session },
        )
        const [testDrive] = await HireOnboardingTestDrive.create(
          [
            {
              workspaceId: ctx.workspace._id,
              issuedByMemberId: ctx.membership._id,
              issuedByName: actorName,
              operationId,
              label: TEST_DRIVE_LABEL,
              state: 'provisioning',
              active: true,
              excludeFromAggregates: true,
              jobId,
              candidateId,
              applicationId,
              cleanupAfter: testDriveCleanupAfter(now),
            },
          ],
          { session },
        )

        return { testDrive, newlyProvisioned: true }
      },
    )
  } catch (error) {
    if (!isDuplicateKey(error)) throw error

    // A concurrent retry may win either durable uniqueness constraint. Never
    // manufacture another graph or reissue a raw capability in that case.
    const existing =
      (await findDriveForOperation(ctx, operationId)) ??
      (await findActiveDriveForMember(ctx))
    if (existing) return { testDrive: existing, newlyProvisioned: false }

    // The remaining plausible duplicate is the workspace-candidate email key;
    // surface the intentional fail-closed policy, not a database detail.
    throw new AppError(
      'Your member email already belongs to a candidate in this workspace. Test drive setup stopped without attaching to that candidate.',
      409,
      'TEST_DRIVE_MEMBER_EMAIL_ALREADY_EXISTS',
    )
  }
}

async function recordExistingRound(
  ctx: MembershipContext,
  testDrive: IHireOnboardingTestDrive,
  roundId: mongoose.Types.ObjectId,
): Promise<IHireOnboardingTestDrive> {
  const updated = await HireOnboardingTestDrive.findOneAndUpdate(
    {
      _id: testDrive._id,
      workspaceId: ctx.workspace._id,
      issuedByMemberId: ctx.membership._id,
      state: { $ne: 'removed' },
    },
    {
      $set: {
        state: 'ready',
        roundId,
        // Timestamp only. This model never receives the raw link/token.
        inviteReleasedAt: new Date(),
      },
    },
    { new: true },
  )
  if (!updated) throw new NotFoundError('Test drive')
  return updated
}

async function existingRoundForTestDrive(
  ctx: MembershipContext,
  testDrive: IHireOnboardingTestDrive,
) {
  if (testDrive.roundId) {
    return HireRound.findOne({
      _id: testDrive.roundId,
      workspaceId: ctx.workspace._id,
      applicationId: testDrive.applicationId,
    })
  }
  return HireRound.findOne({
    workspaceId: ctx.workspace._id,
    applicationId: testDrive.applicationId,
    kind: 'ai',
  }).sort({ createdAt: -1 })
}

async function readyWithoutRawCapability(
  ctx: MembershipContext,
  testDrive: IHireOnboardingTestDrive,
): Promise<StartResult> {
  const knownRound = await existingRoundForTestDrive(ctx, testDrive)
  const ready = knownRound && !testDrive.roundId
    ? await recordExistingRound(ctx, testDrive, knownRound._id)
    : testDrive

  return {
    testDrive: toHireOnboardingTestDriveView(ready),
    inviteUrl: null,
    created: false,
    emailSent: null,
  }
}

/**
 * Provision the test graph and send the normal AI invite using the existing
 * Hire round service. A raw URL is permitted only in the original successful
 * response; any operation retry/recovery returns an opaque DTO instead.
 */
export async function startHireOnboardingTestDrive(
  ctx: MembershipContext,
  input: StartHireOnboardingTestDrivePayload,
): Promise<StartResult> {
  const payload = validateStartInput(input)
  await connectHireControlDB()
  const provisioned = await provisionTestDrive(ctx, payload.operationId)

  if (!provisioned.newlyProvisioned) {
    // A preceding request owns the only opportunity to receive the raw URL.
    // If it crashed before the round was made, this retry may safely finish the
    // send below, but must discard the returned capability.
    const existingRound = await existingRoundForTestDrive(ctx, provisioned.testDrive)
    if (existingRound || provisioned.testDrive.roundId || provisioned.testDrive.state === 'removed') {
      return readyWithoutRawCapability(ctx, provisioned.testDrive)
    }

    const resumed = await sendAiRound(ctx, {
      applicationId: toId(provisioned.testDrive.applicationId),
      experience: '3-6',
      duration: 10,
    })
    const ready = await recordExistingRound(ctx, provisioned.testDrive, resumed.round._id)
    return {
      testDrive: toHireOnboardingTestDriveView(ready),
      inviteUrl: null,
      created: false,
      emailSent: null,
    }
  }

  try {
    const sent = await sendAiRound(ctx, {
      applicationId: toId(provisioned.testDrive.applicationId),
      experience: '3-6',
      duration: 10,
    })
    const ready = await recordExistingRound(ctx, provisioned.testDrive, sent.round._id)
    return {
      testDrive: toHireOnboardingTestDriveView(ready),
      inviteUrl: sent.inviteUrl,
      created: true,
      emailSent: sent.emailSent,
    }
  } catch (error) {
    // A first request can race a recovery after the durable round exists. The
    // safe response is the same opaque state; never retrieve/reconstruct it.
    if (error instanceof AppError && error.code === 'ROUND_IN_FLIGHT') {
      const existingRound = await existingRoundForTestDrive(ctx, provisioned.testDrive)
      if (existingRound) return readyWithoutRawCapability(ctx, provisioned.testDrive)
    }
    throw error
  }
}

/** Return only the caller's current live practice graph. */
export async function getHireOnboardingTestDrive(
  ctx: MembershipContext,
): Promise<HireOnboardingTestDriveView | null> {
  await connectHireControlDB()
  const testDrive = await findActiveDriveForMember(ctx)
  return testDrive ? toHireOnboardingTestDriveView(testDrive) : null
}

/**
 * Member-authorized cleanup command. It uses the ordinary member round revoke
 * service when a practice invite is still live, then preserves the marker as
 * an aggregate exclusion until the future lifecycle purge removes all four
 * synthetic coordinate rows together.
 */
export async function removeHireOnboardingTestDrive(
  ctx: MembershipContext,
): Promise<HireOnboardingTestDriveView> {
  await connectHireControlDB()
  const testDrive = await findActiveDriveForMember(ctx)
  if (!testDrive) throw new NotFoundError('Test drive')

  const round = await existingRoundForTestDrive(ctx, testDrive)
  if (round && !round.revokedAt && !['completed', 'revoked'].includes(round.status)) {
    // Intentional boundary: this module neither imports nor alters engine/runtime
    // code; the established Hire revoke service owns any runtime handoff.
    await revokeRound(ctx, toId(round._id))
  }

  const actorName = memberActorName(ctx)
  const removed = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const updated = await HireOnboardingTestDrive.findOneAndUpdate(
        {
          _id: testDrive._id,
          workspaceId: ctx.workspace._id,
          issuedByMemberId: ctx.membership._id,
          active: true,
        },
        {
          $set: {
            state: 'removed',
            active: false,
            removedAt: new Date(),
            removedByMemberId: ctx.membership._id,
            removedByName: actorName,
            // A member removal makes the graph immediately eligible for the
            // lifecycle worker; the durable marker remains until that worker
            // has safely removed the coordinate rows in dependency order.
            cleanupAfter: new Date(),
          },
        },
        { new: true, session },
      )
      if (!updated) throw new NotFoundError('Test drive')
      return updated
    },
  )
  // This is deliberately after the marker transaction commits. A failed
  // Inngest send cannot resurrect or expose anything; hourly recovery sees
  // the same due marker if this wakeup is unavailable.
  await kickHireOnboardingTestDriveCleanup({
    workspaceId: ctx.workspace._id.toString(),
    testDriveId: removed._id.toString(),
  })
  return toHireOnboardingTestDriveView(removed)
}
