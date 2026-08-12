import mongoose from 'mongoose'
import {
  DailyChallengeAttempt,
  DrillAttempt,
  InterviewSession,
  JobApplication,
  JobPracticeEvidence,
  JobsEmailSend,
  LessonEngagement,
  MultimodalAnalysis,
  PathwayPlan,
  ProductEvent,
  ScoreTelemetry,
  ServedProblem,
  SessionSummary,
  StreakDay,
  UsageRecord,
  User,
  UserBadge,
  UserCompetencyState,
  WeaknessCluster,
  WizardSession,
  XpEvent,
} from '@shared/db/models'
import { SavedResume } from '@shared/db/models/SavedResume'
import { redis } from '@shared/redis'
import { tombstoneAccountUsageBuffers } from '@shared/services/usageBuffer'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import {
  abortRuntimeMultipartUploads,
  deleteRuntimePersonalObjects,
} from './runtimeMediaManifest'
import { runtimePrincipalEmail } from './runtimePrincipalService'
import { assertRuntimeWritesDrained } from './runtimeWriteFence'

interface RuntimePurgeSession {
  _id: { toString(): string }
  recordingR2Key?: string | null
  screenRecordingR2Key?: string | null
  audioRecordingR2Key?: string | null
  facialLandmarksR2Key?: string | null
  resumeR2Key?: string | null
  jdR2Key?: string | null
}

interface RuntimePurgeUser {
  resumeR2Key?: string | null
}

type DeleteManyModel = {
  modelName?: string
  deleteMany(filter: Record<string, unknown>): Promise<{
    acknowledged?: boolean
    deletedCount?: number
  }>
}

interface RuntimePrincipalCollection {
  model: DeleteManyModel
  organizationScoped: boolean
}

const RUNTIME_PRINCIPAL_COLLECTIONS: RuntimePrincipalCollection[] = [
  { model: MultimodalAnalysis, organizationScoped: false },
  { model: UsageRecord, organizationScoped: true },
  { model: ScoreTelemetry, organizationScoped: false },
  { model: WeaknessCluster, organizationScoped: false },
  { model: UserBadge, organizationScoped: false },
  { model: PathwayPlan, organizationScoped: false },
  { model: WizardSession, organizationScoped: false },
  { model: StreakDay, organizationScoped: false },
  { model: SessionSummary, organizationScoped: false },
  { model: XpEvent, organizationScoped: false },
  { model: DailyChallengeAttempt, organizationScoped: false },
  { model: DrillAttempt, organizationScoped: false },
  { model: UserCompetencyState, organizationScoped: false },
  { model: ServedProblem, organizationScoped: false },
  { model: SavedResume, organizationScoped: false },
  { model: LessonEngagement, organizationScoped: false },
  { model: ProductEvent, organizationScoped: false },
  { model: JobsEmailSend, organizationScoped: false },
  { model: JobPracticeEvidence, organizationScoped: false },
  { model: JobApplication, organizationScoped: false },
]

function referencedRuntimeObjects(input: {
  binding: IHireRuntimeBinding
  sessions: RuntimePurgeSession[]
  user: RuntimePurgeUser | null
}): Array<{ key: string; runtimeSessionId?: string }> {
  const objects: Array<{ key: string; runtimeSessionId?: string }> = []
  for (const session of input.sessions) {
    const runtimeSessionId = session._id.toString()
    for (const key of [
      session.recordingR2Key,
      session.screenRecordingR2Key,
      session.audioRecordingR2Key,
      session.facialLandmarksR2Key,
      session.resumeR2Key,
      session.jdR2Key,
    ]) {
      if (typeof key === 'string' && key.length > 0) {
        objects.push({ key, runtimeSessionId })
      }
    }
  }
  for (const capability of input.binding.issuedObjectCapabilities ?? []) {
    objects.push({
      key: capability.key,
      runtimeSessionId: capability.runtimeSessionId.toString(),
    })
  }
  for (const artifact of input.binding.pendingMediaManifest ?? []) {
    if (
      (artifact.kind === 'recording' || artifact.kind === 'audio') &&
      input.binding.runtimeSessionId
    ) {
      objects.push({
        key: artifact.sourceKey,
        runtimeSessionId: input.binding.runtimeSessionId.toString(),
      })
    }
  }
  if (typeof input.user?.resumeR2Key === 'string' && input.user.resumeR2Key.length > 0) {
    objects.push({ key: input.user.resumeR2Key })
  }
  return objects
}

async function deletePrincipalCollections(input: {
  principalId: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
}): Promise<void> {
  for (const collection of RUNTIME_PRINCIPAL_COLLECTIONS) {
    // principalId is generated once per HireRuntimeBinding and protected by a
    // unique index. Most unchanged-engine schemas have no organizationId path,
    // so adding one makes their real rows impossible to match. UsageRecord is
    // the sole derived model in this list that stores the workspace coordinate.
    const result = await collection.model.deleteMany({
      userId: input.principalId,
      ...(collection.organizationScoped
        ? { organizationId: input.workspaceId }
        : {}),
    })
    if (result.acknowledged !== true) {
      throw new Error(
        `${collection.model.modelName ?? 'Runtime collection'} purge was not acknowledged`,
      )
    }
  }
}

async function deleteRuntimeSessionCaches(sessionIds: string[]): Promise<void> {
  const keys = Array.from(new Set(sessionIds)).flatMap((sessionId) => [
    `jd:ctx:${sessionId}`,
    `resume:ctx:${sessionId}`,
    `session:cfg:${sessionId}`,
    `feedback:lock:${sessionId}`,
  ])
  if (keys.length > 0) await redis.del(...keys)
}

async function deleteRuntimeAuthRows(input: {
  principalId: mongoose.Types.ObjectId
  email: string
}): Promise<void> {
  const db = mongoose.connection.db
  if (!db) throw new Error('Runtime database handle is unavailable during privacy purge')
  for (const [collection, filter] of [
    ['accounts', { userId: input.principalId }],
    ['sessions', { userId: input.principalId }],
    ['verification_tokens', { identifier: input.email }],
    // Defensive legacy/runtime stragglers. Neither route is exposed by the
    // runtime allowlist, but a privacy acknowledgement must not rely on that
    // historical fact if a row already exists.
    ['waitlistentries', { email: input.email }],
    ['savedjobdescriptions', { userId: input.principalId }],
  ] as const) {
    // NextAuth adapter rows and these two legacy collections have no
    // organizationId path. Their authority is the globally unique synthetic
    // principal (or its round-derived synthetic email), after the canonical
    // HireRuntimeBinding authorization check at the start of the purge.
    const result = await db.collection(collection).deleteMany(filter)
    if (!result.acknowledged) {
      throw new Error(`Runtime ${collection} purge was not acknowledged`)
    }
  }
}

export async function purgeRuntimePrincipalData(input: {
  binding: IHireRuntimeBinding
  roundId: string
  now?: Date
}): Promise<Date> {
  const roundId = input.binding.roundId.toString().toLowerCase()
  const authorizedBinding =
    roundId === input.roundId.toLowerCase() &&
    await HireRuntimeBinding.exists({
      _id: input.binding._id,
      workspaceId: input.binding.workspaceId,
      applicationId: input.binding.applicationId,
      roundId: input.binding.roundId,
      principalId: input.binding.principalId,
      status: 'revoked',
      purgePersonalData: true,
    })
  if (!authorizedBinding) {
    throw new Error('Runtime binding is not authorized for this workspace purge')
  }

  const now = input.now ?? new Date()
  assertRuntimeWritesDrained(input.binding, now)
  const principalId = input.binding.principalId
  const workspaceId = input.binding.workspaceId
  const principalIdString = principalId.toString()
  const email = runtimePrincipalEmail(roundId)

  // The synthetic User row is the durable writer fence. Keep it until every
  // derived collection is empty; engine/core writes already reject deleting
  // users, and the runtime proxy has stopped issuing new write capabilities.
  const fenced = await User.updateOne(
    { _id: principalId, email, organizationId: workspaceId },
    { $set: { accountState: 'deleting', monthlyInterviewLimit: 0 } },
  )
  if (!fenced.acknowledged) throw new Error('Runtime principal fence was not acknowledged')

  const sessions = (await InterviewSession.find({
    userId: principalId,
    organizationId: workspaceId,
  })
    .select(
      '_id recordingR2Key screenRecordingR2Key audioRecordingR2Key facialLandmarksR2Key resumeR2Key jdR2Key',
    )
    .lean()) as RuntimePurgeSession[]
  const runtimeSessionIds = Array.from(new Set([
    ...sessions.map((session) => session._id.toString()),
    ...(input.binding.runtimeSessionId
      ? [input.binding.runtimeSessionId.toString()]
      : []),
  ]))
  await tombstoneAccountUsageBuffers(
    principalIdString,
    runtimeSessionIds,
  )
  // These unchanged-engine Redis entries are exact session capabilities.
  // Purge them before any durable inventory is removed so a Redis outage
  // leaves the deleting User and Mongo/R2 evidence intact for a safe retry.
  await deleteRuntimeSessionCaches(runtimeSessionIds)
  const user = (await User.findOne({
    _id: principalId,
    email,
    organizationId: workspaceId,
  })
    .select('resumeR2Key')
    .lean()) as RuntimePurgeUser | null

  await abortRuntimeMultipartUploads({
    principalId: principalIdString,
    uploads: (input.binding.issuedMultipartCapabilities ?? []).map((capability) => ({
      key: capability.key,
      runtimeSessionId: capability.runtimeSessionId.toString(),
      uploadId: capability.uploadId,
    })),
  })
  await deleteRuntimePersonalObjects({
    principalId: principalIdString,
    objects: referencedRuntimeObjects({ binding: input.binding, sessions, user }),
  })

  const deletedSessions = await InterviewSession.deleteMany({
    userId: principalId,
    organizationId: workspaceId,
  })
  if (!deletedSessions.acknowledged) {
    throw new Error('Runtime session purge was not acknowledged')
  }
  await deletePrincipalCollections({ principalId, workspaceId })
  await deleteRuntimeAuthRows({ principalId, email })

  const deletedUser = await User.deleteOne({
    _id: principalId,
    email,
    organizationId: workspaceId,
    accountState: 'deleting',
  })
  if (!deletedUser.acknowledged) {
    throw new Error('Runtime principal purge was not acknowledged')
  }
  if ((deletedUser.deletedCount ?? 0) === 0) {
    const stillExists = await User.exists({
      _id: principalId,
      email,
      organizationId: workspaceId,
    })
    if (stillExists) throw new Error('Runtime principal fence survived privacy purge')
  }
  return now
}

export const __runtimePersonalDataPurge = {
  RUNTIME_PRINCIPAL_COLLECTIONS,
  referencedRuntimeObjects,
  deletePrincipalCollections,
  deleteRuntimeSessionCaches,
}
