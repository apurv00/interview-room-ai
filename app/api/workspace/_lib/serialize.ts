/**
 * Response shapes for the workspace (member-facing) API. Explicit picks —
 * never spread a Mongoose doc into a response: HireRound carries
 * inviteTokenHash and internal B2C ids (guestUserId, sessionId) that must
 * not reach the client.
 */

import { createHash } from 'crypto'
import type {
  IHireApplication,
  IHireCandidate,
  IHireJob,
  IHireRound,
  IHireWorkspaceMember,
  MembershipContext,
  JobListItem,
  PipelineEntry,
  HireJobEmailDeliverySummary,
} from '@hire'

export function serializeMembership(ctx: MembershipContext) {
  return {
    workspace: {
      id: ctx.workspace._id.toString(),
      name: ctx.workspace.name,
      companyBlurb: ctx.workspace.companyBlurb ?? null,
      guestAuthMode: ctx.workspace.guestAuthMode ?? 'magic_link',
      lifecycleState: ctx.workspace.lifecycleState ?? 'active',
      deletedAt: ctx.workspace.deletedAt ?? null,
      purgeAfter: ctx.workspace.purgeAfter ?? null,
      deletedByName: ctx.workspace.deletedByName ?? null,
      createdAt: ctx.workspace.createdAt,
    },
    membership: {
      id: ctx.membership._id.toString(),
      role: ctx.membership.role,
      email: ctx.membership.email,
      name: ctx.membership.name ?? null,
      directAccount: !!ctx.membership.passwordSetAt,
    },
  }
}

export function serializeMember(m: IHireWorkspaceMember) {
  return {
    id: m._id.toString(),
    email: m.email,
    name: m.name ?? null,
    role: m.role,
    linked: !!m.userId,
    authState: m.authState ?? 'active',
    passwordSet: !!m.passwordSetAt,
    removedAt: m.removedAt ?? null,
    addedAt: m.createdAt,
  }
}

export function serializeJob(job: IHireJob, opts: { includeJd?: boolean } = {}) {
  return {
    id: job._id.toString(),
    title: job.title,
    status: job.status,
    closeNote: job.closeNote ?? null,
    closedAt: job.closedAt ?? null,
    closedByName: job.closedByName ?? null,
    activeRequirementVersion: job.activeRequirementVersion ?? null,
    createdAt: job.createdAt,
    // Whether the public apply page is live. The token itself is NEVER
    // serialized — only its hash is stored, and the raw value is shown
    // once at mint time.
    applyPageEnabled: job.applyPageEnabled === true,
    screeningSettings: {
      location: job.screeningSettings?.location ?? null,
      experienceFloorYears: job.screeningSettings?.experienceFloorYears ?? null,
    },
    ...(opts.includeJd ? { jdText: job.jdText } : {}),
  }
}

export function serializeJobListItem(item: JobListItem) {
  return {
    ...serializeJob(item.job),
    applicationCount: item.applicationCount,
    byStage: item.byStage,
  }
}

export function serializeJobEmailDelivery(summary: HireJobEmailDeliverySummary) {
  return {
    total: summary.total,
    pending: summary.pending,
    sending: summary.sending,
    sent: summary.sent,
    failed: summary.failed,
    failures: summary.failures.map((failure) => ({
      recipientEmail: failure.recipientEmail,
      recipientName: failure.recipientName,
      attempts: failure.attempts,
      lastError: failure.lastError,
      failedAt: failure.failedAt,
    })),
  }
}

export function serializeCandidate(c: IHireCandidate, opts: { includeResume?: boolean } = {}) {
  return {
    id: c._id.toString(),
    name: c.name,
    email: c.email,
    phone: c.phone ?? null,
    hasResume: !!c.resumeText,
    resumeFileName: c.resumeFileName ?? null,
    source: c.source,
    createdByMemberId: c.createdByMemberId?.toString() ?? null,
    createdByName: c.createdByName ?? null,
    addedAt: c.createdAt,
    ...(opts.includeResume ? { resumeText: c.resumeText ?? null } : {}),
  }
}

export function serializeApplication(
  a: IHireApplication,
  opts: { candidateResumeHash?: string | null; includeApplicantResume?: boolean } = {},
) {
  // A score belongs to the document that PRODUCED it, identified by hash —
  // never by position. Assuming "newest submission" made an anonymous
  // caller able to force a false "outdated" warning on a still-valid score
  // simply by appending, and it broke as soon as the headline score came
  // from the pool copy instead (Codex P2 on #615).
  const submissionHashes = (a.applicantSubmissions ?? []).map((sub) =>
    resumeHashOf(sub.resumeText),
  )
  const headlineHash = a.resumeMatch?.resumeHash
  const headlineSourceExists =
    headlineHash != null &&
    (headlineHash === opts.candidateResumeHash || submissionHashes.includes(headlineHash))
  // Derive ONLY with the FULL source set. Submissions alone are not
  // enough: a caller that omits candidate context (e.g. the stage route)
  // would compare a pool-derived headline hash against submissions only,
  // find no match, and report a perfectly valid score as stale. Presence
  // of the key — not its value — is what signals context, since `null`
  // legitimately means "this candidate has no pool résumé" (Codex P2 on
  // #616).
  const haveSources = 'candidateResumeHash' in opts
  return {
    id: a._id.toString(),
    jobId: a.jobId.toString(),
    candidateId: a.candidateId.toString(),
    stage: a.stage,
    decisionNote: a.decisionNote ?? null,
    offerDecision: a.offerDecision
      ? {
          outcome: a.offerDecision.outcome,
          actorName: a.offerDecision.actorName,
          note: a.offerDecision.note ?? null,
          at: a.offerDecision.at,
        }
      : null,
    resumeMatch: a.resumeMatch
      ? {
          score: a.resumeMatch.score ?? null,
          strengths: a.resumeMatch.strengths,
          gaps: a.resumeMatch.gaps,
          scoredAt: a.resumeMatch.scoredAt,
          // Outdated evidence must never present as fresh. Staleness is
          // DERIVED at read time (match.resumeHash vs the candidate's
          // current resume hash) — the write-time sweep is only a hint,
          // since snapshot isolation lets a concurrently-scored sibling
          // slip past it (self-review on #612). Stored flag kept as a
          // fallback for callers without candidate context.
          // Compare against the résumé this match was actually computed
          // FROM: an application carrying its own quarantined document is
          // validated against that, not the pool copy. Using the pool hash
          // marked every apply-page match permanently "outdated" — a
          // false warning on every public application (Codex P2 on #615).
          // Stale means: the document this score came from is no longer on
          // file. Not "a newer one exists" — a newer submission does not
          // invalidate a score computed from a document that is still here.
          stale: haveSources ? !headlineSourceExists : a.resumeMatch.stale === true,
        }
      : null,
    // Résumé submitted through the public apply page when the pool record
    // already had a different one — the document the JD-match score came
    // from (Codex P1 on #615). DETAIL ENDPOINT ONLY: this field is up to
    // 50k chars, and serializeApplication also feeds the pipeline board
    // (serializePipelineEntry), where hundreds of cards would balloon the
    // response for text the board never renders (Codex P2 on #615).
    ...(opts.includeApplicantResume
      ? {
          applicantSubmissions: (a.applicantSubmissions ?? []).map((sub) => ({
            text: sub.resumeText,
            fileName: sub.resumeFileName ?? null,
            submittedAt: sub.submittedAt,
            score: sub.match?.score ?? null,
          })),
        }
      : {}),
    events: a.events.map((e) => ({
      type: e.type,
      from: e.from ?? null,
      to: e.to ?? null,
      actorName: e.actorName,
      note: e.note ?? null,
      at: e.at,
    })),
    createdAt: a.createdAt,
  }
}

export function serializeRound(r: IHireRound) {
  return {
    id: r._id.toString(),
    kind: r.kind,
    status: r.status,
    invitedAt: r.invitedAt,
    inviteExpiresAt: r.inviteTokenExpiry,
    consentAt: r.consentAt ?? null,
    preparedAt: r.preparedAt ?? null,
    linkedAt: r.linkedAt ?? null,
    revokedAt: r.revokedAt ?? null,
    config: r.config,
    attemptCount: r.attemptCount ?? null,
    requirementVersion: r.requirementVersion ?? null,
    requirementHash: r.requirementHash ?? null,
    revocationState: r.revocationState ?? 'not_requested',
    results: r.results ?? null,
  }
}

/** sha256 of the candidate's current resume — read-time staleness anchor. */
export function resumeHashOf(resumeText: string | null | undefined): string | null {
  return resumeText ? createHash('sha256').update(resumeText).digest('hex') : null
}

export function serializePipelineEntry(entry: PipelineEntry) {
  return {
    application: serializeApplication(entry.application, {
      candidateResumeHash: resumeHashOf(entry.candidate?.resumeText),
    }),
    candidate: entry.candidate ? serializeCandidate(entry.candidate) : null,
    latestRound: entry.latestRound
      ? {
          id: entry.latestRound._id.toString(),
          status: entry.latestRound.status,
          invitedAt: entry.latestRound.invitedAt,
          inviteExpiresAt: entry.latestRound.inviteTokenExpiry,
          revokedAt: entry.latestRound.revokedAt ?? null,
          linkedAt: entry.latestRound.linkedAt ?? null,
          overallScore: entry.latestRound.results?.overallScore ?? null,
          resultsPending: entry.latestRound.results?.pending ?? false,
          resultsUnscored: entry.latestRound.results?.unscored ?? false,
        }
      : null,
    ranking: {
      scoreState: entry.scoreState,
      rank: entry.rank,
    },
    previouslySeenIn: entry.previouslySeenIn.map((seen) => ({
      jobId: seen.jobId,
      jobTitle: seen.jobTitle,
      stage: seen.stage,
    })),
  }
}
