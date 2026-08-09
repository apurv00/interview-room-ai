import type { ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { AppError, NotFoundError } from '@shared/errors'
import { withPersonalDataWriteTransaction } from '@shared/services/accountDeletion'
import {
  HireApplication,
  HireCandidate,
  HireJob,
  type HireCandidateSource,
  type IHireApplication,
  type IHireCandidate,
  type IHireResumeMatch,
} from '../models'
import type { MembershipContext } from './workspaceService'

/**
 * Phase 2 intake: idempotent candidate + application creation with
 * workspace-scoped email dedupe and the "seen before" signal.
 *
 * Contrast with pipelineService.addCandidate (Phase 1, manual form): that
 * path REJECTS duplicates with 409 because a recruiter typing an email that
 * already exists is a mistake worth surfacing. Bulk upload and the apply
 * page are the opposite — the same person showing up again is EXPECTED and
 * must merge into the existing record, not fail the row.
 *
 * WRITE AUTHORITY: every write runs inside
 * withPersonalDataWriteTransaction(actor) — the claim on the recruiter's
 * User row (accountState ≠ deleting) and ALL intake writes commit in one
 * transaction, so an account-deletion sweep can never interleave with
 * them. A plain recheck-then-write is a TOCTOU race; this is the
 * repository's durable barrier (Codex P1 on #612).
 *
 * Merge policy (deliberate, keep boring):
 *   - name: existing wins (recruiter-entered names beat parsed ones); filled
 *     only when the existing record has none.
 *   - phone: filled only when missing.
 *   - resumeText/resumeFileName: NEWEST upload wins whenever the intake
 *     carries a resume — a re-uploaded CV is assumed fresher.
 *   - email: immutable here; it IS the identity key.
 *
 * Resume/score coherence (the resume is WORKSPACE-level, matches are
 * per-application): replacing the shared resume (a) refreshes or — when
 * analysis failed — CLEARS the current application's match (a new CV must
 * never wear the old CV's score), and (b) flags every sibling
 * application's match `stale` so pipeline readers see that its evidence
 * predates the current CV. Matches carry resumeHash for auditability.
 */

export interface IntakeInput {
  jobId: string
  name: string
  email: string
  phone?: string
  resumeText?: string
  resumeFileName?: string
  source: Extract<HireCandidateSource, 'bulk_upload' | 'apply_page'>
  /** Resume-vs-JD analysis, when scoring succeeded (advisory). */
  resumeMatch?: IHireResumeMatch
  /**
   * True when the identity email was explicitly supplied/confirmed by the
   * recruiter (override field), not extracted from the document. Bypasses
   * the identity-conflict guard below.
   */
  identityConfirmed?: boolean
}

export interface SeenBeforeEntry {
  jobId: string
  jobTitle: string
  stage: string
}

export interface IntakeResult {
  candidateId: string
  applicationId: string
  createdCandidate: boolean
  createdApplication: boolean
  /** Other applications of this person in the workspace (dedupe signal). */
  seenBefore: SeenBeforeEntry[]
}

const SOURCE_LABEL: Record<IntakeInput['source'], string> = {
  bulk_upload: 'via bulk resume upload',
  apply_page: 'via public apply page',
}

export async function intakeCandidate(
  ctx: MembershipContext,
  input: IntakeInput,
): Promise<IntakeResult> {
  await connectDB()
  const workspaceId = ctx.workspace._id
  const email = input.email.toLowerCase().trim()
  if (!email) throw new AppError('Candidate email is required', 422, 'NO_EMAIL')

  const job = await HireJob.findOne({ _id: input.jobId, workspaceId })
  if (!job) throw new NotFoundError('Job')
  if (job.status === 'closed') {
    throw new AppError('This job is closed', 409, 'JOB_CLOSED')
  }

  // userId is optional on the membership type (linked lazily on first
  // sign-in), but requireMembership always resolves or links it — a
  // missing id here means a context built some other way; refuse rather
  // than write personal data without a claimable actor.
  const actorUserId = ctx.membership.userId
  if (!actorUserId) {
    throw new AppError('Workspace membership is not linked to a user', 403, 'MEMBERSHIP_UNLINKED')
  }

  const runIntakeTx = () =>
    withPersonalDataWriteTransaction(actorUserId, (session) =>
      writeIntake(session, ctx, input, email),
    )

  let outcome: Awaited<ReturnType<typeof writeIntake>>
  try {
    outcome = await runIntakeTx()
  } catch (err: unknown) {
    // A duplicate-key loss (two files of the same person racing in one
    // batch) aborts the whole transaction — retry the claim+write once;
    // the re-read inside then finds the winner and merges.
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      outcome = await runIntakeTx()
    } else {
      throw err
    }
  }

  return {
    candidateId: outcome.candidate._id.toString(),
    applicationId: outcome.application._id.toString(),
    createdCandidate: outcome.createdCandidate,
    createdApplication: outcome.createdApplication,
    seenBefore: await seenBeforeForCandidate(ctx, outcome.candidate, outcome.application),
  }
}

async function writeIntake(
  session: ClientSession,
  ctx: MembershipContext,
  input: IntakeInput,
  email: string,
): Promise<{
  candidate: IHireCandidate
  application: IHireApplication
  createdCandidate: boolean
  createdApplication: boolean
}> {
  const workspaceId = ctx.workspace._id

  // In-transaction job claim (self-review on #612): the pre-transaction
  // status check is a fast-path only — snapshot reads do not serialize
  // against a concurrent close, so the authority is this conflict-inducing
  // WRITE on the job row. A close committing first makes this claim miss
  // (409); this claim committing first makes the close retry after us.
  const jobClaim = await HireJob.updateOne(
    { _id: input.jobId, workspaceId, status: { $ne: 'closed' } },
    { $inc: { intakeWriteVersion: 1 } },
    { session },
  )
  if (jobClaim.matchedCount !== 1) {
    throw new AppError('This job is closed', 409, 'JOB_CLOSED')
  }

  // ── Candidate: find-or-create; merge on revisit ──
  let createdCandidate = false
  let resumeReplaced = false
  let candidate = await HireCandidate.findOne({ workspaceId, email }).session(session)
  if (!candidate) {
    const created = await HireCandidate.create(
      [
        {
          workspaceId,
          name: input.name,
          email,
          phone: input.phone,
          resumeText: input.resumeText,
          resumeFileName: input.resumeFileName,
          source: input.source,
          createdBy: ctx.membership.userId,
        },
      ],
      { session },
    )
    candidate = created[0]
    createdCandidate = true
  } else {
    // Identity-conflict guard (self-review on #612): an EXTRACTED email
    // landing on an existing candidate whose stored name shares no tokens
    // with the incoming one, while carrying a DIFFERENT resume, is more
    // likely a shared/agency address or a crafted CV than the same person.
    // Refuse the destructive overwrite; the recruiter confirms via the
    // email-override retry, which sets identityConfirmed.
    if (
      !input.identityConfirmed &&
      input.resumeText &&
      candidate.resumeText &&
      input.resumeText !== candidate.resumeText &&
      namesDisjoint(candidate.name, input.name)
    ) {
      throw new AppError(
        `This email already belongs to "${candidate.name}" in this workspace — confirm the email to replace their résumé`,
        422,
        'IDENTITY_CONFLICT',
      )
    }
    resumeReplaced = applyMerge(candidate, input)
    if (candidate.isModified()) await candidate.save({ session })
  }

  // ── Application: find-or-create; keep score coherent with the CV ──
  let createdApplication = false
  let application = await HireApplication.findOne({
    workspaceId,
    jobId: input.jobId,
    candidateId: candidate._id,
  }).session(session)
  if (!application) {
    const created = await HireApplication.create(
      [
        {
          workspaceId,
          jobId: input.jobId,
          candidateId: candidate._id,
          stage: 'new',
          resumeMatch: input.resumeMatch,
          events: [
            {
              type: 'created',
              actorUserId: ctx.membership.userId,
              actorName: ctx.membership.name || ctx.membership.email,
              note: SOURCE_LABEL[input.source],
              at: new Date(),
            },
          ],
          createdBy: ctx.membership.userId,
        },
      ],
      { session },
    )
    application = created[0]
    createdApplication = true
  } else if (input.resumeMatch) {
    // A fresh analysis always refreshes the match.
    application.resumeMatch = input.resumeMatch
    await application.save({ session })
  } else if (input.resumeText && resumeReplaced) {
    // FAILED analysis on a genuinely NEW resume: clear — the new CV must
    // never wear the old CV's score (Codex P1 on #612). Gated on
    // resumeReplaced: an IDENTICAL re-upload during a provider outage
    // must PRESERVE the still-valid match, not wipe the pipeline's
    // evidence (self-review on #612).
    application.resumeMatch = undefined
    application.markModified('resumeMatch')
    await application.save({ session })
  }

  if (resumeReplaced) {
    // The shared workspace-level resume changed: every OTHER application's
    // match was computed from the previous CV — flag, don't delete, so the
    // evidence stays visible but visibly outdated (Codex P1 on #612).
    await HireApplication.updateMany(
      {
        workspaceId,
        candidateId: candidate._id,
        _id: { $ne: application._id },
        resumeMatch: { $exists: true },
      },
      { $set: { 'resumeMatch.stale': true } },
      { session },
    )
  }

  return { candidate, application, createdCandidate, createdApplication }
}

/**
 * True when two names share NO alphabetic tokens at all — deliberately
 * conservative ("Jane D." vs "Jane Doe" overlaps; only fully different
 * names trip the identity-conflict guard).
 */
function namesDisjoint(a: string, b: string): boolean {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((t) => t.length >= 2),
    )
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return false
  return !Array.from(ta).some((t) => tb.has(t))
}

/** Returns true when the workspace-level resume was actually replaced. */
function applyMerge(candidate: IHireCandidate, input: IntakeInput): boolean {
  if (!candidate.name && input.name) candidate.name = input.name
  if (!candidate.phone && input.phone) candidate.phone = input.phone
  if (input.resumeText && input.resumeText !== candidate.resumeText) {
    candidate.resumeText = input.resumeText
    candidate.resumeFileName = input.resumeFileName
    return true
  }
  return false
}

/** Everywhere else this person already is in the workspace, with job names. */
async function seenBeforeForCandidate(
  ctx: MembershipContext,
  candidate: IHireCandidate,
  currentApplication: IHireApplication,
): Promise<SeenBeforeEntry[]> {
  const others = await HireApplication.find({
    workspaceId: ctx.workspace._id,
    candidateId: candidate._id,
    _id: { $ne: currentApplication._id },
  })
    .sort({ createdAt: -1 })
    .limit(10)
  if (others.length === 0) return []
  const jobs = await HireJob.find({
    workspaceId: ctx.workspace._id,
    _id: { $in: others.map((a) => a.jobId) },
  }).select('title')
  const titleById = new Map(jobs.map((j) => [j._id.toString(), j.title]))
  return others.map((a) => ({
    jobId: a.jobId.toString(),
    jobTitle: titleById.get(a.jobId.toString()) ?? 'Unknown job',
    stage: a.stage,
  }))
}
