import crypto from 'crypto'
import mongoose, { type ClientSession, type UpdateQuery } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
  HireJob,
  type HireCandidateSource,
  type IHireApplication,
  type IHireCandidate,
  type IHireCandidateScreeningProfile,
  type IHireJob,
  type IHireResumeMatch,
  APPLICANT_SUBMISSION_CAP,
} from '../models'
import type { MembershipContext } from './workspaceService'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import { claimHireCandidatePiiWriteFence } from './hireCandidatePrivacyWriteFence'

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
 * WRITE AUTHORITY: every write runs inside a Hire-owned workspace/member
 * transaction. The workspace claim and ALL intake writes commit together,
 * so workspace deletion/removal cannot interleave with them. Candidate
 * identity never reaches the B2C User collection.
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
   * Bounded profile extracted from the same resume as `resumeMatch`. The
   * write path binds it to `resumeText` itself before it ever reaches a
   * candidate row, so a stale score/profile cannot silently become a
   * knockout input for a newer CV.
   */
  screeningProfile?: {
    location?: string | null
    experienceYears?: number | null
  }
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function profileForIntake(
  input: IntakeInput,
): IHireCandidateScreeningProfile | undefined {
  if (!input.screeningProfile || !input.resumeText) return undefined
  const rawLocation = input.screeningProfile.location
  const location =
    typeof rawLocation === 'string'
      ? rawLocation.trim().replace(/\s+/g, ' ').slice(0, 160)
      : undefined
  const rawExperience = input.screeningProfile.experienceYears
  const experienceYears =
    typeof rawExperience === 'number' &&
    Number.isFinite(rawExperience) &&
    rawExperience >= 0 &&
    rawExperience <= 50
      ? rawExperience
      : undefined
  return {
    ...(location ? { location } : {}),
    ...(experienceYears !== undefined ? { experienceYears } : {}),
    resumeHash: sha256(input.resumeText),
    extractedAt: new Date(),
  }
}

function versionConstraint(document: object): Record<string, unknown> {
  const version = (document as { __v?: unknown }).__v
  return typeof version === 'number' && Number.isInteger(version)
    ? { __v: version }
    : { __v: { $exists: false } }
}

function advanceLocalVersion(document: object): void {
  const versionedDocument = document as { __v?: number }
  const version = versionedDocument.__v
  versionedDocument.__v =
    typeof version === 'number' && Number.isInteger(version) ? version + 1 : 1
}

async function persistScopedCandidate(
  candidate: IHireCandidate,
  workspaceId: mongoose.Types.ObjectId,
  update: UpdateQuery<IHireCandidate>,
  session: ClientSession,
): Promise<void> {
  const result = await HireCandidate.updateOne(
    {
      _id: candidate._id,
      workspaceId,
      email: candidate.email,
      ...versionConstraint(candidate),
    },
    { ...update, $inc: { __v: 1 } },
    { session, runValidators: true },
  )
  if (result.matchedCount !== 1) {
    throw new AppError(
      'Candidate changed during intake; retry the submission',
      409,
      'INTAKE_WRITE_CONFLICT',
    )
  }
  advanceLocalVersion(candidate)
}

async function persistScopedApplication(
  application: IHireApplication,
  workspaceId: mongoose.Types.ObjectId,
  jobId: string,
  candidateId: mongoose.Types.ObjectId,
  update: UpdateQuery<IHireApplication>,
  session: ClientSession,
): Promise<void> {
  const result = await HireApplication.updateOne(
    {
      _id: application._id,
      workspaceId,
      jobId,
      candidateId,
      ...versionConstraint(application),
    },
    { ...update, $inc: { __v: 1 } },
    { session, runValidators: true },
  )
  if (result.matchedCount !== 1) {
    throw new AppError(
      'Application changed during intake; retry the submission',
      409,
      'INTAKE_WRITE_CONFLICT',
    )
  }
  advanceLocalVersion(application)
}

/**
 * Who the write is attributed to, and whose account-deletion state gates
 * it. Decoupled from MembershipContext so the PUBLIC apply page reuses this
 * exact write path (transaction, merge policy, staleness sweep, identity
 * guard) instead of duplicating it — duplicated write paths are how the
 * two halves drift apart and only one gets the next fix.
 */
export interface IntakeActor {
  /** Hire-owned barrier authority; never a B2C User id. */
  authorityMemberId: mongoose.Types.ObjectId
  /** Audit display name recorded on the created event. */
  displayName: string
  /** Member actor for member actions; absent for self-service applications. */
  actorMemberId?: mongoose.Types.ObjectId
  /** Optional historical B2C pointer for already-linked HR members only. */
  legacyActorUserId?: mongoose.Types.ObjectId
}

/** Member-initiated intake (bulk upload / recruiter add). */
export async function intakeCandidate(
  ctx: MembershipContext,
  input: IntakeInput,
): Promise<IntakeResult> {
  return runIntake(ctx.workspace._id, input, {
    authorityMemberId: ctx.membership._id,
    displayName: ctx.membership.name || ctx.membership.email,
    actorMemberId: ctx.membership._id,
    legacyActorUserId: ctx.membership.userId,
  })
}

/**
 * Public apply-page intake. Tenancy proof is the hashed apply token that
 * resolved this job (never a client-supplied workspace id), and the
 * write barrier claims an active Hire member in the active workspace. The
 * event carries no actor member: nobody on the team performed it.
 */
export async function intakeFromApplyPage(
  job: Pick<IHireJob, '_id' | 'workspaceId'>,
  input: Omit<IntakeInput, 'jobId' | 'source' | 'identityConfirmed'>,
  opts: {
    /** Live workspace authority — see resolveWorkspaceWriteAuthority. */
    authorityMemberId: mongoose.Types.ObjectId
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
      authorityMemberId: opts.authorityMemberId,
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
    withActiveHireWorkspaceWriteTransaction(
      workspaceId,
      actor.authorityMemberId,
      (session) =>
        writeIntake(session, workspaceId, input, email, actor, jobGuard),
    )

  let outcome: Awaited<ReturnType<typeof writeIntake>>
  try {
    outcome = await runIntakeTx()
  } catch (err: unknown) {
    // A duplicate-key loss (two files of the same person racing in one
    // batch) aborts the whole transaction — retry the claim+write once;
    // the re-read inside then finds the winner and merges.
    if (
      err &&
      typeof err === 'object' &&
      (err as { code?: number }).code === 11000
    ) {
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
    seenBefore: await seenBeforeForCandidate(
      workspaceId,
      outcome.candidate,
      outcome.application,
    ),
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
    {
      _id: input.jobId,
      workspaceId,
      status: { $ne: 'closed' },
      ...(jobGuard ?? {}),
    },
    { $inc: { intakeWriteVersion: 1 } },
    { session },
  )
  if (jobClaim.matchedCount !== 1) {
    // Either the job closed, or (public path) the apply link was rotated
    // or disabled while this submission was being parsed and scored.
    throw new AppError(
      'This job is no longer accepting applications',
      409,
      'JOB_CLOSED',
    )
  }

  // ── Candidate: find-or-create; merge on revisit ──
  let createdCandidate = false
  let resumeReplaced = false
  const intakeProfile = profileForIntake(input)
  // Set when a public submission must not touch the shared pool résumé —
  // the file is APPENDED to the application instead of being discarded.
  let applicantSubmission:
    | {
        resumeText: string
        resumeFileName?: string
        submittedAt: Date
        match?: IHireResumeMatch
      }
    | undefined
  let candidate = await HireCandidate.findOne({ workspaceId, email }).session(
    session,
  )
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
          ...(intakeProfile ? { screeningProfile: intakeProfile } : {}),
          source: input.source,
          ...(actor.actorMemberId
            ? { createdByMemberId: actor.actorMemberId }
            : {}),
          createdByName: actor.displayName,
          ...(actor.legacyActorUserId
            ? { createdBy: actor.legacyActorUserId }
            : {}),
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
    // PUBLIC path is CREATE-ONLY on an existing candidate. The rule is
    // PROVENANCE, not content: any anonymous submission landing on a
    // candidate that already exists goes to that application's append-only
    // submissions and touches the pool record in no way at all.
    //
    // Keying this on content emptiness ("only protect a résumé that is
    // already there") left a hole in the most common Phase 1 flow — a
    // recruiter adds someone by name+email with NO résumé, and an
    // anonymous caller who knows that email could then write their own
    // document into the workspace-level pool record, flip resumeReplaced,
    // and fire the sibling staleness sweep across that person's OTHER
    // applications. Provenance has no such precondition to exploit
    // (threat-model pass, #616).
    const publicSubmissionKeepsPoolRecord =
      input.source === 'apply_page' && !!input.resumeText

    const identityConflict =
      !input.identityConfirmed &&
      !!input.resumeText &&
      !!candidate.resumeText &&
      input.resumeText !== candidate.resumeText &&
      namesDisjoint(candidate.name, input.name)

    if (publicSubmissionKeepsPoolRecord) {
      applicantSubmission = {
        resumeText: input.resumeText as string,
        resumeFileName: input.resumeFileName,
        submittedAt: new Date(),
        match: input.resumeMatch,
      }
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
    if (input.source !== 'apply_page') {
      const previous = {
        name: candidate.name,
        phone: candidate.phone,
        resumeText: candidate.resumeText,
        resumeFileName: candidate.resumeFileName,
        screeningProfile: candidate.screeningProfile,
      }
      resumeReplaced = applyMerge(candidate, input)
      // A profile is only useful while it is bound to the current resume.
      // Fresh analysis can update an identical re-upload; a changed resume
      // with no successful extraction clears the old profile rather than
      // screening the new CV using stale location/experience evidence.
      if (intakeProfile) {
        candidate.screeningProfile = intakeProfile
      } else if (resumeReplaced) {
        candidate.screeningProfile = undefined
      }
      const $set: Record<string, unknown> = {}
      const $unset: Record<string, 1> = {}
      if (candidate.name !== previous.name) $set.name = candidate.name
      if (candidate.phone !== previous.phone) $set.phone = candidate.phone
      if (candidate.resumeText !== previous.resumeText)
        $set.resumeText = candidate.resumeText
      if (candidate.resumeFileName !== previous.resumeFileName) {
        if (candidate.resumeFileName === undefined) $unset.resumeFileName = 1
        else $set.resumeFileName = candidate.resumeFileName
      }
      if (candidate.screeningProfile !== previous.screeningProfile) {
        if (candidate.screeningProfile === undefined) $unset.screeningProfile = 1
        else $set.screeningProfile = candidate.screeningProfile
      }
      if (Object.keys($set).length > 0 || Object.keys($unset).length > 0) {
        await persistScopedCandidate(
          candidate,
          workspaceId,
          {
            ...(Object.keys($set).length > 0 ? { $set } : {}),
            ...(Object.keys($unset).length > 0 ? { $unset } : {}),
          },
          session,
        )
      }
    }
    // (apply_page deliberately falls through with NO candidate write: an
    // anonymous caller may create a candidate, never edit one.)
  }

  // The same candidate-row fence used by media/result finalization makes an
  // intake worker and a verified privacy erasure serialize at the one
  // tenant-owned identity record. A tombstone that wins first means this
  // transaction aborts before creating or modifying an application.
  await claimHireCandidatePiiWriteFence({
    workspaceId,
    candidateId: candidate._id,
    session,
  })

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
          resumeMatch: input.resumeMatch ?? applicantSubmission?.match,
          ...(applicantSubmission
            ? { applicantSubmissions: [applicantSubmission] }
            : {}),
          events: [
            {
              type: 'created',
              // Absent for self-service: nobody on the team did this.
              ...(actor.actorMemberId
                ? { actorMemberId: actor.actorMemberId }
                : {}),
              ...(actor.legacyActorUserId
                ? { actorUserId: actor.legacyActorUserId }
                : {}),
              actorName: actor.displayName,
              note: SOURCE_LABEL[input.source],
              at: new Date(),
            },
          ],
          ...(actor.actorMemberId
            ? { createdByMemberId: actor.actorMemberId }
            : {}),
          createdByName: actor.displayName,
          ...(actor.legacyActorUserId
            ? { createdBy: actor.legacyActorUserId }
            : {}),
        },
      ],
      { session },
    )
    application = created[0]
    createdApplication = true
  } else if (applicantSubmission) {
    // REPEAT public submission on an existing application: APPEND it with
    // the score it produced, and mutate NOTHING that is already there.
    // An anonymous caller must never be able to overwrite a real
    // applicant's evidence just by knowing their email and the shared link
    // (Codex P1 on #615) — each submission stands on its own and a
    // recruiter can see all of them, which also makes tampering visible.
    // Retention PROTECTS THE ORIGINAL. A newest-first cap still let an
    // attacker evict the genuine applicant's first submission by sending
    // enough of their own — append-only is worthless if the oldest entry
    // can be pushed out (Codex on #615). The first submission is therefore
    // pinned forever; the cap bounds only the later ones.
    const existingSubs = application.applicantSubmissions ?? []
    const original =
      existingSubs.length > 0
        ? existingSubs[existingSubs.length - 1]
        : undefined
    if (!original) {
      application.applicantSubmissions = [applicantSubmission]
    } else {
      const laterOnly = [
        applicantSubmission,
        ...existingSubs.slice(0, -1),
      ].slice(0, APPLICANT_SUBMISSION_CAP - 1)
      application.applicantSubmissions = [...laterOnly, original]
    }
    await persistScopedApplication(
      application,
      workspaceId,
      input.jobId,
      candidate._id,
      { $set: { applicantSubmissions: application.applicantSubmissions } },
      session,
    )
  } else if (input.resumeMatch) {
    // A fresh analysis always refreshes the match. This branch means the
    // score came from the POOL résumé (nothing was quarantined this time),
    // so any quarantined document from an earlier submission is now
    // obsolete: leaving it would show the recruiter document B beside a
    // score computed from A, and would anchor staleness to B as well
    // (Codex P1 on #615).
    // Refresh the headline score ONLY. Earlier public submissions are
    // retained: deleting them let anyone holding the link, the applicant's
    // email and a copy of the pool résumé erase the append-only history —
    // evidence retention cannot depend on which document was scored last
    // (Codex P1 on #615). Which document the headline score belongs to is
    // resolved by HASH at read time, so history and score coexist without
    // either misrepresenting the other.
    application.resumeMatch = input.resumeMatch
    await persistScopedApplication(
      application,
      workspaceId,
      input.jobId,
      candidate._id,
      { $set: { resumeMatch: input.resumeMatch } },
      session,
    )
  } else if (input.resumeText && resumeReplaced) {
    // FAILED analysis on a genuinely NEW resume: clear — the new CV must
    // never wear the old CV's score (Codex P1 on #612). Gated on
    // resumeReplaced: an IDENTICAL re-upload during a provider outage
    // must PRESERVE the still-valid match, not wipe the pipeline's
    // evidence (self-review on #612).
    application.resumeMatch = undefined
    await persistScopedApplication(
      application,
      workspaceId,
      input.jobId,
      candidate._id,
      { $unset: { resumeMatch: 1 } },
      session,
    )
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
