import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { AppError } from '@shared/errors'
import { logger } from '@shared/logger'
import { sendEmail } from '@shared/services/emailService'
import {
  HireMemberSession,
  HireMemberSetup,
  HireWorkspace,
  HireWorkspaceMember,
  normalizeHireMemberEmail,
  type IHireWorkspace,
  type IHireWorkspaceMember,
} from '../models'
import { buildMemberSetupEmail } from '../emails/memberSetupEmail'
import { connectHireControlDB } from './hireControlBoundary'

export const HIRE_MEMBER_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Host-ipg-hire-member' : 'ipg-hire-member'
export const HIRE_MEMBER_LEGACY_COOKIE = '__Secure-ipg-hire-member'
export const HIRE_MEMBER_SESSION_DAYS = 7
export const HIRE_MEMBER_SETUP_HOURS = 24
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{24}$/i
const RAW_CREDENTIAL_PATTERN = /^[a-f0-9]{64}$/i
const WORKSPACE_CREDENTIAL_PATTERN = /^([a-f0-9]{24})\.([a-f0-9]{64})$/i

function tokenHash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function publicHireUrl(): string {
  return (process.env.HIRE_PUBLIC_URL || 'https://hire.interviewprep.guru').replace(/\/$/, '')
}

function randomCredential(): string {
  return crypto.randomBytes(32).toString('hex')
}

export interface HireMemberCredentialParts {
  workspaceId: string
  rawSecret: string
}

/**
 * Member credentials are self-routing capabilities. The workspace coordinate
 * is not a secret; carrying it prevents any global token lookup. The random
 * secret remains the sole authentication factor and only its hash is stored.
 */
export function encodeHireMemberCredential(
  workspaceId: string | mongoose.Types.ObjectId,
  rawSecret: string,
): string {
  const normalizedWorkspaceId = workspaceId.toString().toLowerCase()
  if (!WORKSPACE_ID_PATTERN.test(normalizedWorkspaceId) || !RAW_CREDENTIAL_PATTERN.test(rawSecret)) {
    throw new Error('Invalid Hire member credential parts')
  }
  return `${normalizedWorkspaceId}.${rawSecret.toLowerCase()}`
}

export function parseHireMemberCredential(
  value: string | undefined,
): HireMemberCredentialParts | null {
  if (!value) return null
  const match = WORKSPACE_CREDENTIAL_PATTERN.exec(value)
  return match
    ? { workspaceId: match[1].toLowerCase(), rawSecret: match[2].toLowerCase() }
    : null
}

export interface MemberSetupResult {
  setupUrl: string
  emailSent: boolean
  expiresAt: Date
}

export async function issueMemberSetup(
  member: IHireWorkspaceMember,
  workspaceName: string
): Promise<MemberSetupResult> {
  await connectHireControlDB()
  const raw = randomCredential()
  const expiresAt = new Date(Date.now() + HIRE_MEMBER_SETUP_HOURS * 60 * 60 * 1000)
  const workspaceId = member.workspaceId.toString()
  const issuedAt = new Date()
  await HireMemberSetup.updateMany(
    {
      workspaceId,
      memberId: member._id,
      consumedAt: { $exists: false },
    },
    { $set: { consumedAt: issuedAt } },
  )
  const setup = await HireMemberSetup.create({
    workspaceId,
    memberId: member._id,
    tokenHash: tokenHash(raw),
    expiresAt,
  })
  const setupCredential = encodeHireMemberCredential(workspaceId, raw)
  // The secret lives in the URL fragment, which browsers do not send in HTTP
  // requests or referrers. The client removes it from history immediately.
  const setupUrl = `${publicHireUrl()}/hire-signin#setup=${encodeURIComponent(setupCredential)}`
  const email = buildMemberSetupEmail({
    memberName: member.name,
    workspaceName,
    workspaceId,
    setupUrl,
    expiryHours: HIRE_MEMBER_SETUP_HOURS,
  })
  const sent = await sendEmail({
    to: member.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
    idempotencyKey: `hire-member-setup-${setup._id.toString()}`,
  })
  if (!sent.ok) {
    logger.warn({ memberId: member._id.toString() }, 'hire: member setup email failed; copy link remains available')
  }
  return { setupUrl, emailSent: sent.ok, expiresAt }
}

export interface AuthenticatedHireMember {
  workspace: IHireWorkspace
  membership: IHireWorkspaceMember
  sessionCredential: string
  expiresAt: Date
}

async function createSessionForMember(
  member: IHireWorkspaceMember,
  mongoSession?: mongoose.ClientSession
): Promise<{ sessionCredential: string; expiresAt: Date }> {
  const rawSessionSecret = randomCredential()
  const workspaceId = member.workspaceId.toString()
  const expiresAt = new Date(Date.now() + HIRE_MEMBER_SESSION_DAYS * 24 * 60 * 60 * 1000)
  await HireMemberSession.create(
    [
      {
        workspaceId,
        memberId: member._id,
        tokenHash: tokenHash(rawSessionSecret),
        sessionVersion: member.sessionVersion,
        expiresAt,
        lastSeenAt: new Date(),
      },
    ],
    mongoSession ? { session: mongoSession } : undefined
  )
  return {
    sessionCredential: encodeHireMemberCredential(workspaceId, rawSessionSecret),
    expiresAt,
  }
}

export async function completeMemberSetup(
  setupCredential: string,
  password: string
): Promise<AuthenticatedHireMember> {
  const credential = parseHireMemberCredential(setupCredential)
  if (!credential) {
    throw new AppError('This setup link is invalid or expired', 410, 'SETUP_LINK_INVALID')
  }
  await connectHireControlDB()
  const passwordHash = await bcrypt.hash(password, 12)
  const session = await mongoose.startSession()
  let auth: AuthenticatedHireMember | null = null
  try {
    await session.withTransaction(async () => {
      const setup = await HireMemberSetup.findOne({
        workspaceId: credential.workspaceId,
        tokenHash: tokenHash(credential.rawSecret),
        consumedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      }).session(session)
      if (!setup) {
        throw new AppError('This setup link is invalid or expired', 410, 'SETUP_LINK_INVALID')
      }
      const workspace = await HireWorkspace.findOne({
        _id: credential.workspaceId,
        $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
      }).session(session)
      if (!workspace) throw new AppError('Workspace unavailable', 410, 'WORKSPACE_UNAVAILABLE')
      const currentMember = await HireWorkspaceMember.findOne({
        _id: setup.memberId,
        workspaceId: credential.workspaceId,
        authState: { $ne: 'removed' },
      }).session(session)
      if (!currentMember) {
        throw new AppError('This membership is no longer active', 410, 'MEMBERSHIP_REMOVED')
      }
      const completedAt = new Date()
      const member = await HireWorkspaceMember.findOneAndUpdate(
        {
          _id: currentMember._id,
          workspaceId: credential.workspaceId,
          authState: { $ne: 'removed' },
          sessionVersion: currentMember.sessionVersion,
        },
        {
          $set: {
            passwordHash,
            passwordSetAt: completedAt,
            authState: 'active',
          },
          $inc: { sessionVersion: 1 },
        },
        { new: true, session },
      )
      if (!member) {
        throw new AppError('Membership access changed; use a fresh setup link', 409, 'SETUP_RACE')
      }
      const consumed = await HireMemberSetup.updateOne(
        {
          _id: setup._id,
          workspaceId: credential.workspaceId,
          consumedAt: { $exists: false },
        },
        { $set: { consumedAt: completedAt } },
        { session },
      )
      if (consumed.modifiedCount !== 1) {
        throw new AppError('This setup link is invalid or expired', 410, 'SETUP_LINK_INVALID')
      }
      const issued = await createSessionForMember(member, session)
      auth = { workspace, membership: member, ...issued }
    })
  } finally {
    await session.endSession()
  }
  if (!auth) throw new AppError('Could not set up this account', 500, 'SETUP_FAILED')
  return auth
}

export async function authenticateHireMember(
  workspaceId: string,
  email: string,
  password: string
): Promise<AuthenticatedHireMember> {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new AppError('Workspace, email, or password is incorrect', 401, 'INVALID_CREDENTIALS')
  }
  await connectHireControlDB()
  const member = await HireWorkspaceMember.findOne({
    workspaceId,
    normalizedEmail: normalizeHireMemberEmail(email),
    authState: 'active',
  }).select('+passwordHash')
  if (!member?.passwordHash || !(await bcrypt.compare(password, member.passwordHash))) {
    throw new AppError('Workspace, email, or password is incorrect', 401, 'INVALID_CREDENTIALS')
  }
  const workspace = await HireWorkspace.findOne({ _id: workspaceId })
  if (!workspace) throw new AppError('Workspace unavailable', 410, 'WORKSPACE_UNAVAILABLE')
  const issued = await createSessionForMember(member)
  return { workspace, membership: member, ...issued }
}

export async function resolveHireMemberSession(
  sessionCredential: string | undefined
): Promise<{ workspace: IHireWorkspace; membership: IHireWorkspaceMember } | null> {
  const credential = parseHireMemberCredential(sessionCredential)
  if (!credential) return null
  await connectHireControlDB()
  const now = new Date()
  const session = await HireMemberSession.findOne({
    workspaceId: credential.workspaceId,
    tokenHash: tokenHash(credential.rawSecret),
    revokedAt: { $exists: false },
    expiresAt: { $gt: now },
  })
  if (!session) return null
  const member = await HireWorkspaceMember.findOne({
    _id: session.memberId,
    workspaceId: session.workspaceId,
    authState: 'active',
    sessionVersion: session.sessionVersion,
  })
  if (!member) return null
  const workspace = await HireWorkspace.findOne({ _id: credential.workspaceId })
  if (!workspace) return null
  if (session.lastSeenAt.getTime() < Date.now() - 5 * 60 * 1000) {
    void HireMemberSession.updateOne(
      {
        _id: session._id,
        workspaceId: credential.workspaceId,
        revokedAt: { $exists: false },
      },
      { $set: { lastSeenAt: now } }
    ).catch((err) => logger.warn({ err }, 'hire: member session last-seen update failed'))
  }
  return { workspace, membership: member }
}

export async function revokeHireMemberSession(sessionCredential: string | undefined): Promise<void> {
  const credential = parseHireMemberCredential(sessionCredential)
  if (!credential) return
  await connectHireControlDB()
  await HireMemberSession.updateOne(
    {
      workspaceId: credential.workspaceId,
      tokenHash: tokenHash(credential.rawSecret),
      revokedAt: { $exists: false },
    },
    { $set: { revokedAt: new Date() } }
  )
}
