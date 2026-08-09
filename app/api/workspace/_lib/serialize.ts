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
} from '@hire'

export function serializeMembership(ctx: MembershipContext) {
  return {
    workspace: {
      id: ctx.workspace._id.toString(),
      name: ctx.workspace.name,
      guestAuthMode: ctx.workspace.guestAuthMode ?? 'magic_link',
      createdAt: ctx.workspace.createdAt,
    },
    membership: {
      id: ctx.membership._id.toString(),
      role: ctx.membership.role,
      email: ctx.membership.email,
      name: ctx.membership.name ?? null,
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
    createdAt: job.createdAt,
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

export function serializeCandidate(c: IHireCandidate, opts: { includeResume?: boolean } = {}) {
  return {
    id: c._id.toString(),
    name: c.name,
    email: c.email,
    phone: c.phone ?? null,
    hasResume: !!c.resumeText,
    resumeFileName: c.resumeFileName ?? null,
    source: c.source,
    addedAt: c.createdAt,
    ...(opts.includeResume ? { resumeText: c.resumeText ?? null } : {}),
  }
}

export function serializeApplication(
  a: IHireApplication,
  opts: { candidateResumeHash?: string | null } = {},
) {
  return {
    id: a._id.toString(),
    jobId: a.jobId.toString(),
    candidateId: a.candidateId.toString(),
    stage: a.stage,
    decisionNote: a.decisionNote ?? null,
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
          stale:
            a.resumeMatch.stale === true ||
            (opts.candidateResumeHash != null &&
              a.resumeMatch.resumeHash !== opts.candidateResumeHash),
        }
      : null,
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
    authVerifiedAt: r.authVerifiedAt ?? null,
    preparedAt: r.preparedAt ?? null,
    linkedAt: r.linkedAt ?? null,
    revokedAt: r.revokedAt ?? null,
    config: r.config,
    attemptCount: r.attemptCount ?? null,
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
  }
}
