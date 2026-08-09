import mongoose, { type ClientSession } from 'mongoose'
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
  type IHireJob,
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

/**
 * Who the write is attributed to, and whose account-deletion state gates
 * it. Decoupled from MembershipContext so the PUBLIC apply page reuses this
 * exact write path (transaction, merge policy, staleness sweep, identity
 * guard) instead of duplicating it — duplicated write paths are how the
 * two halves drift apart and only one gets the next fix.
 */
export interface IntakeActor {
  /** Barrier claim target — writes abort if THIS account is deleting. */
  userId: mongoose.Types.ObjectId
  /** Audit display name recorded on the created event. */
  displayName: string
  /** Member id for member actions; absent for self-service applications. */
  actorUserId?: mongoose.Types.ObjectId
}

/** Member-initiated intake (bulk upload / recruiter add). */
export async function intakeCandidate(
  ctx: MembershipContext,
  input: IntakeInput,
): Promise<IntakeResult> {
  // userId is optional on the membership type (linked lazily on first
  // sign-in), but requireMembership always resolves or links it — a
  // missing id here means a context built some other way; refuse rather
  // than write personal data without a claimable actor.
  const actorUserId = ctx.membership.userId
  if (!actorUserId) {
    throw new AppError('Workspace membership is not linked to a user', 403, 'MEMBERSHIP_UNLINKED')
  }
  return runIntake(ctx.workspace._id, input, {
    userId: actorUserId,
    displayName: ctx.membership.name || ctx.membership.email,
    actorUserId,
  })
}

/**
 * Public apply-page intake. Tenancy proof is the hashed apply token that
 * resolved this job (never a client-supplied workspace id), and the
 * deletion barrier claims against the job's OWNER — if the recruiter's
 * account is being deleted, their workspace stops accepting applications.
 * The event carries no actorUserId: nobody on the team performed it.
 */
export async function intakeFromApplyPage(
  job: Pick<IHireJob, '_id' | 'workspaceId'>,
  input: Omit<IntakeInput, 'jobId' | 'source' | 'identityConfirmed'>,
  opts: {
    /** Live workspace authority — see resolveWorkspaceWriteAuthority. */
    authorityUserId: mongoose.Types.ObjectId
    /**
     * sha256 of the apply token this submission arrived with. Folded into
     * the in-transaction job claim so a link rotated or disabled DURING the
     * parse/model phase cannot still commit (Codex P2 on #615).
     */
    applyTokenHash: string
  },
): Promise<IntakeResult> {
  return runIntake(
    job.workspaceId,
    { ...input, jobId: job._id.toString(), source: 'apply_page' },
    {
      userId: opts.authorityUserId,
      displayName: 'Applicant (public apply page)',
    },
    { applyTokenHash: opts.applyTokenHash, applyPageEnabled: true },
  )
}

async function runIntake(
  workspaceId: mongoose.Types.ObjectId,
  input: IntakeInput,
  actor: IntakeActor,
  /** Extra conditions the job row must STILL satisfy at write time. */
  jobGuard?: Record<string, unknown>,
): Promise<IntakeResult> {
  await connectDB()
  const email = input.email.toLowerCase().trim()
  if (!email) throw new AppError('Candidate email is required', 422, 'NO_EMAIL')

  const job = await HireJob.findOne({ _id: input.jobId, workspaceId })
  if (!job) throw new NotFoundError('Job')
  if (job.status === 'closed') {
    throw new AppError('This job is closed', 409, 'JOB_CLOSED')
  }

  const runIntakeTx = () =>
    withPersonalDataWriteTransaction(actor.userId, (session) =>
      writeIntake(session, workspaceId, input, email, actor, jobGuard),
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
    // NOTE for callers: seenBefore is HR-only intelligence. The public
    // apply route must never include it in an applicant-facing response.
    seenBefore: await seenBeforeForCandidate(workspaceId, outcome.candidate, outcome.application),
  }
}

async function writeIntake(
  session: ClientSession,
  workspaceId: mongoose.Types.ObjectId,
  input: IntakeInput,
  email: string,
  actor: IntakeActor,
  jobGuard?: Record<string, unknown>,
): Promise<{
  candidate: IHireCandidate
  application: IHireApplication
  createdCandidate: boolean
  createdApplication: boolean
}> {
  // In-transaction job claim (self-review on #612): the pre-transaction
  // status check is a fast-path only — snapshot reads do not serialize
  // against a concurrent close, so the authority is this conflict-inducing
  // WRITE on the job row. A close committing first makes this claim miss
  // (409); this claim committing first makes the close retry after us.
  const jobClaim = await HireJob.updateOne(
    { _id: input.jobId, workspaceId, status: { $ne: 'closed' }, ...(jobGuard ?? {}) },
    { $inc: { intakeWriteVersion: 1 } },
    { session },
  )
  if (jobClaim.matchedCount !== 1) {
    // Either the job closed, or (public path) the apply link was rotated
    // or disabled while this submission was being parsed and scored.
    throw new AppError('This job is no longer accepting applications', 409, 'JOB_CLOSED')
  }

  // ── Candidate: find-or-create; merge on revisit ──
  let createdCandidate = false
  let resumeReplaced = false
  // Set when a public submission must not touch the shared pool résumé —
  // the file rides on the APPLICATION instead of being discarded.
  let applicantResumeText: string | undefined
  let applicantResumeFileName: string | undefined
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
          createdBy: actor.userId,
        },
      ],
      { session },
    )
    candidate = created[0]
    createdCandidate = true
  } else {
    // Identity-conflict guard (self-review on #612): an UNCONFIRMED email
    // landing on an existing candidate whose stored name shares no tokens
    // with the incoming one, while carrying a DIFFERENT resume, is more
    // likely a shared/agency address, a crafted CV, or a stranger typing
    // someone else's address than the same person.
    // PUBLIC path: an anonymous submission NEVER overwrites a résumé that
    // is already on file — no name heuristic decides it (self-review found
    // the heuristic fails OPEN for single-token and non-Latin names, which
    // handed an anonymous caller a résumé-overwrite primitive). The
    // applicant's file is instead attached to THEIR application below, so
    // nothing is lost and the recruiter sees exactly what was submitted.
    // Response stays byte-identical either way — the endpoint must not
    // become an oracle for who is already in the pool.
    const publicSubmissionKeepsPoolRecord =
      input.source === 'apply_page' &&
      !!input.resumeText &&
      !!candidate.resumeText &&
      input.resumeText !== candidate.resumeText

    const identityConflict =
      !input.identityConfirmed &&
      !!input.resumeText &&
      !!candidate.resumeText &&
      input.resumeText !== candidate.resumeText &&
      namesDisjoint(candidate.name, input.name)

    if (publicSubmissionKeepsPoolRecord) {
      applicantResumeText = input.resumeText
      applicantResumeFileName = input.resumeFileName
      input = { ...input, resumeText: undefined, resumeFileName: undefined }
    } else if (identityConflict && input.source !== 'apply_page') {
      // MEMBER path: surface it — the recruiter can confirm the email via
      // the override retry (which sets identityConfirmed) or fix the file.
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
          ...(applicantResumeText
            ? {
                applicantResumeText,
                applicantResumeFileName,
              }
            : {}),
          events: [
            {
              type: 'created',
              // Absent for self-service: nobody on the team did this.
              ...(actor.actorUserId ? { actorUserId: actor.actorUserId } : {}),
              actorName: actor.displayName,
              note: SOURCE_LABEL[input.source],
              at: new Date(),
            },
          ],
          createdBy: actor.userId,
        },
      ],
      { session },
    )
    application = created[0]
    createdApplication = true
  } else if (applicantResumeText) {
    // REPEAT public submission on an existing application: the quarantined
    // document and its score must move together. Refreshing the match
    // while leaving the old quarantined résumé in place would show the
    // recruiter a new score beside the document it was NOT computed from
    // (Codex P1 on #615) — the precise failure the quarantine exists to
    // prevent.
    application.applicantResumeText = applicantResumeText
    application.applicantResumeFileName = applicantResumeFileName
    application.resumeMatch = input.resumeMatch
    application.markModified('resumeMatch')
    await application.save({ session })
  } else if (input.resumeMatch) {
    // A fresh analysis always refreshes the match. This branch means the
    // score came from the POOL résumé (nothing was quarantined this time),
    // so any quarantined document from an earlier submission is now
    // obsolete: leaving it would show the recruiter document B beside a
    // score computed from A, and would anchor staleness to B as well
    // (Codex P1 on #615).
    application.resumeMatch = input.resumeMatch
    if (application.applicantResumeText) {
      application.applicantResumeText = undefined
      application.applicantResumeFileName = undefined
      application.markModified('applicantResumeText')
      application.markModified('applicantResumeFileName')
    }
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
  // Fail CLOSED: a name we cannot tokenize (single character, non-Latin
  // script) must not silently DISABLE the guard — treat it as a conflict
  // the recruiter confirms, never as proof of same-person.
  if (ta.size === 0 || tb.size === 0) return true
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
  workspaceId: mongoose.Types.ObjectId,
  candidate: IHireCandidate,
  currentApplication: IHireApplication,
): Promise<SeenBeforeEntry[]> {
  const others = await HireApplication.find({
    workspaceId,
    candidateId: candidate._id,
    _id: { $ne: currentApplication._id },
  })
    .sort({ createdAt: -1 })
    .limit(10)
  if (others.length === 0) return []
  const jobs = await HireJob.find({
    workspaceId,
    _id: { $in: others.map((a) => a.jobId) },
  }).select('title')
  const titleById = new Map(jobs.map((j) => [j._id.toString(), j.title]))
  return others.map((a) => ({
    jobId: a.jobId.toString(),
    jobTitle: titleById.get(a.jobId.toString()) ?? 'Unknown job',
    stage: a.stage,
  }))
}
