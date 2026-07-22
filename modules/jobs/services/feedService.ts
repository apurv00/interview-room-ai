import { JobPosting, JobApplication, type IJobPosting } from '@shared/db/models'
import { TIER_RANK, type ApplyTier } from '../config/spamRules'
import { titleJaccard } from './identityResolver'
import { xrayHashOf, legacyXrayHashOf } from './xrayService'
import { getBaseResume } from './baseResumeService'
import { getResume } from '@resume'
import {
  mintPracticeHandoffToken,
  preparePracticeHandoffPosting,
} from './practiceHandoff'
import { jobPostingStateOf, type JobPostingState } from './postingAccess'
import { canonicalApplyOptionsOf } from './applyOptionIdentity'
import { canonicalizeCheckableLink } from './safeLinkNetwork'
import { discoverFeed } from './feedDiscovery'
import type { PublicFeedQuery } from '../config/feedDiscovery'

/**
 * Feed serving (PRODUCT_FLOW §1 Stage 0) — database-backed deterministic
 * discovery plus an optional, page-local private refinement. Rules only:
 * - Serving NEVER consumes llmVerdict fields at launch (ruling #16 serving
 *   honesty: rank may read typed verdict fields only once enforcement is on
 *   AND the reason-chip vocabulary names that basis). Soft-closed rows are
 *   already `status:'closed'` and excluded by the status filter.
 * - Demotion flags DEMOTE, never hide (ruling #15) — a staffing/short-JD
 *   row sinks, it does not disappear.
 * - Normalized location and deterministic title-based experience are soft
 *   preferences only. They may improve order and can never empty the feed.
 * - Apply-path badges use the canonical safe-option authority. DB ranking
 *   deliberately does not duplicate that URL and governance logic.
 *
 * P-2 (founder ruling 2026-07-14): public feed, auth-gated detail — the
 * DETAIL projection is split anon-shell vs authed-full SERVER-SIDE here, so
 * no route can accidentally ship the JD/apply URLs to an anonymous client.
 */

export interface FeedQuery extends PublicFeedQuery {
  /** Explicit ?domain= (press surfaces) — a HARD filter: the link promised
   *  "N {domain} jobs" and must deliver exactly that pool. */
  domain?: string
  /** Derived from targetRole server-side. This private soft signal refines
   *  only the current Best-match page and never changes cursor membership. */
  roleDomain?: string
  pageSize?: number
  /** Tier-B (stateless, PRODUCT_FLOW §1 Stage 1): extracted resume skills
   *  passed from the CLIENT's sessionStorage — never persisted server-side
   *  for strangers. Capped upstream by the route. */
  skills?: string[]
  /** The confirm bar's editable "Role you're targeting" — future intent,
   *  not resume past (career_switch exists). */
  targetRole?: string
}

export interface FeedCard {
  id: string
  title: string
  company: string
  locations: string[]
  isRemote: boolean
  domain?: string
  postedAt?: string
  salaryText?: string
  /** Best apply path across provenance — badge copy is tier-honest. */
  applyTier?: ApplyTier
  /** Resume evidence may be named only when a title actually matched it. */
  relevance: 'discovery' | 'location' | 'resume'
  matchedSkills: string[]
  /** True only when the normalized soft preference matched this posting. */
  locationPreferenceMatched: boolean
}

export interface FeedPayload {
  cards: FeedCard[]
  pageSize: number
  hasMore: boolean
  hasPrevious: boolean
  nextCursor?: string
  previousCursor?: string
  total: number
  accessibleTotal: number
  resultCap: number
  capped: boolean
  sharpened: number
  sort: 'best' | 'newest'
}

const DOMAIN_MATCH_BONUS = 25
/** Tier-B: per matched resume skill (cap 3 count) + target-role title affinity. */
const SKILL_MATCH_BONUS = 8
const SKILL_MATCH_CAP = 3
const ROLE_MATCH_BONUS = 20
const ROLE_MATCH_JACCARD = 0.5

/** Browser-navigation policy shared with the production link checker: only
 * credential-free HTTP(S) on default ports, excluding localhost and every
 * non-global IP literal, may reach a candidate. DNS names remain subject to
 * the server-side pinned resolver when the liveness worker checks them. */
export function isSafeHttpUrl(u: string): boolean {
  return canonicalizeCheckableLink(u) !== null
}

export function bestApplyTierOf(doc: Pick<IJobPosting, 'provenance'>): ApplyTier | undefined {
  // Crowd-healing reaches the FEED too (Codex on #522): a reported rung
  // must not keep earning the 'Direct application' badge while the detail
  // ladder demotes it. Clean rungs win; if every rung is reported, fall back
  // to the best of them (demote, never hide).
  let bestClean: ApplyTier | undefined
  let bestAny: ApplyTier | undefined
  for (const option of canonicalApplyOptionsOf(doc.provenance)) {
    // Badge honesty: derive from exactly the same structurally safe,
    // non-blocklisted canonical set the detail ladder and mutations serve.
    const tier = option.tier
    if (!bestAny || TIER_RANK[tier] < TIER_RANK[bestAny]) bestAny = tier
    if (!option.broken && (!bestClean || TIER_RANK[tier] < TIER_RANK[bestClean])) bestClean = tier
  }
  return bestClean ?? bestAny
}

/** Which of the seeker's skills this posting's TITLE actually evidences —
 *  deterministic, and the only permitted source of reveal copy. */
export function matchedSkillsOf(
  doc: Pick<IJobPosting, 'title' | 'titleTokens'>,
  skills: string[] | undefined
): string[] {
  if (!skills?.length) return []
  const tokens = new Set((doc.titleTokens ?? []).map((t) => t.toLowerCase()))
  const titleLower = (doc.title ?? '').toLowerCase()
  return skills.filter((sk) => {
    const s = sk.trim().toLowerCase()
    if (!s) return false
    return tokens.has(s) || (s.length >= 3 && titleLower.includes(s))
  })
}

export async function getFeed(query: FeedQuery, now = new Date()): Promise<FeedPayload> {
  const discovery = await discoverFeed(query, now, query.pageSize)
  const personalized = discovery.rows.map((d, index) => {
    const matched = matchedSkillsOf(d, query.skills)
    let privateScore = 0
    if (query.roleDomain && d.domain === query.roleDomain) privateScore += DOMAIN_MATCH_BONUS
    privateScore += Math.min(matched.length, SKILL_MATCH_CAP) * SKILL_MATCH_BONUS
    if (query.targetRole && titleJaccard(query.targetRole, d.title ?? '') >= ROLE_MATCH_JACCARD) {
      privateScore += ROLE_MATCH_BONUS
    }
    return { d, index, matched, privateScore }
  })
  // Public filters own page membership and cursor order, so a copied URL is
  // stable and contains no resume-derived state. Private signals may refine
  // only the current "Best match" page; Newest remains strictly chronological.
  if (discovery.sort === 'best' && (query.roleDomain || query.targetRole || query.skills?.length)) {
    personalized.sort((a, b) => b.privateScore - a.privateScore || a.index - b.index)
  }
  return {
    cards: personalized.map(({ d, matched }) => ({
      id: String(d._id),
      title: d.title,
      company: d.company,
      locations: d.locations ?? [],
      isRemote: !!d.isRemote,
      domain: d.domain,
      postedAt: d.postedAt ? new Date(d.postedAt).toISOString() : undefined,
      salaryText: d.salaryText,
      applyTier: bestApplyTierOf(d),
      relevance: matched.length
        ? ('resume' as const)
        : d.locationPreferenceMatched
          ? ('location' as const)
          : ('discovery' as const),
      matchedSkills: matched,
      locationPreferenceMatched: d.locationPreferenceMatched,
    })),
    pageSize: discovery.pageSize,
    hasMore: discovery.hasNext,
    hasPrevious: discovery.hasPrevious,
    nextCursor: discovery.nextCursor,
    previousCursor: discovery.previousCursor,
    total: discovery.total,
    accessibleTotal: discovery.accessibleTotal,
    resultCap: discovery.resultCap,
    capped: discovery.capped,
    // Reveal honesty (§4a): "sharpened N matches" only when matched-skill
    // sets on this returned page actually changed something.
    sharpened: personalized.filter((x) => x.matched.length > 0).length,
    sort: discovery.sort,
  }
}

// ── Detail projections (P-2: the anon/authed split lives HERE, server-side) ──

export interface JobDetailShell {
  id: string
  title: string
  company: string
  locations: string[]
  isRemote: boolean
  domain?: string
  postedAt?: string
  salaryText?: string
  applyTier?: ApplyTier
  /** Anon detail is a GATE surface: shell + this marker, never content. */
  gated: true
}

export interface JobDetailFull extends Omit<JobDetailShell, 'gated'> {
  gated: false
  /** Discovery lifecycle is distinct from the caller's tracked lifecycle. */
  postingState: JobPostingState | 'snapshot-only'
  jd?: string
  capabilities: {
    apply: boolean
    viewSource: boolean
    xray: boolean
    tailor: boolean
    practice: boolean
    atsCheck: boolean
  }
  /** Current canonical JD version for a tracked Tailor association. */
  tailorInputHash?: string
  /** Server-authoritative Practice readiness. Both fields appear together. */
  practiceRole?: string
  practiceHandoffToken?: string
  /** Tier-honest apply ladder, best-first — subtitles are the UI's job. */
  applyOptions: Array<{ optionId: string; url: string; tier: ApplyTier; viaSite?: string }>
  /** Aggregate UX signal only. Never expose reporter counts, timestamps, or
   *  per-option governance authority through the detail projection. */
  allApplyOptionsDemoted: boolean
  flags: { staffing: boolean; shortJd: boolean; repost: boolean }
  /** The caller's own tracker row (chip + evidence ticker + ATS inputs). */
  application: {
    applicationId: string
    status: string
    practiceCount: number
    interviewDate?: string
    interviewDateConfidence?: 'exact' | 'week' | 'unknown'
    interviewDatePreference?: 'this-week' | 'next-week' | 'unknown'
    /** Metadata only. Full Tailor text is available from the owner-only
     *  tailored route, never from detail/list projections. */
    tailoredResume?: { createdAt: string; current: boolean }
    /** Explicit user claim made at apply confirmation. */
    appliedWith?: { wasTailored: boolean }
    ats: { state: 'none' | 'pending' | 'done'; score?: number; missingKeywords?: string[]; checkedAt?: string }
  } | null
}

function shellOf(doc: IJobPosting): Omit<JobDetailShell, 'gated'> {
  return {
    id: String(doc._id),
    title: doc.title,
    company: doc.company,
    locations: doc.locations ?? [],
    isRemote: !!doc.isRemote,
    domain: doc.domain,
    postedAt: doc.postedAt ? new Date(doc.postedAt).toISOString() : undefined,
    salaryText: doc.salaryText,
    applyTier: bestApplyTierOf(doc),
  }
}

function exactDetailPostingLifecycleFilter(
  id: string,
  doc: Pick<IJobPosting, 'status' | 'closedReason'>,
): Record<string, unknown> {
  return {
    _id: id,
    status: doc.status,
    closedReason: doc.closedReason === undefined
      ? { $exists: false }
      : doc.closedReason,
  }
}

export async function getJobDetail(id: string, userId?: string | null): Promise<JobDetailShell | JobDetailFull | null> {
  const doc = await JobPosting.findById(id).lean()
  if (!doc) {
    if (!userId) return null
    const snapshotApp = await JobApplication.findOne({ userId, jobPostingId: id })
      .select('_id status jobSnapshot verifiedPracticeSessionIds interviewDate interviewDateConfidence interviewDatePreference appliedWith.wasTailored atsResult atsRequestedAt')
      .lean()
    if (!snapshotApp) return null
    const snapshotLocation = snapshotApp.jobSnapshot?.location?.trim() ?? ''
    return {
      id,
      title: snapshotApp.jobSnapshot?.title ?? 'Saved job',
      company: snapshotApp.jobSnapshot?.company ?? '',
      locations: snapshotLocation ? [snapshotLocation] : [],
      isRemote: /\bremote\b/i.test(snapshotLocation),
      gated: false,
      postingState: 'snapshot-only',
      capabilities: {
        apply: false,
        viewSource: false,
        xray: false,
        tailor: false,
        practice: false,
        atsCheck: false,
      },
      applyOptions: [],
      allApplyOptionsDemoted: false,
      flags: { staffing: false, shortJd: false, repost: false },
      application: {
        applicationId: String(snapshotApp._id),
        status: snapshotApp.status,
        interviewDate: snapshotApp.interviewDate ? new Date(snapshotApp.interviewDate).toISOString() : undefined,
        interviewDateConfidence: snapshotApp.interviewDateConfidence,
        interviewDatePreference: snapshotApp.interviewDatePreference,
        ...(snapshotApp.appliedWith
          ? { appliedWith: { wasTailored: snapshotApp.appliedWith.wasTailored } }
          : {}),
        practiceCount: Math.min(3, snapshotApp.verifiedPracticeSessionIds?.length ?? 0),
        ats: snapshotApp.atsResult
          ? {
              state: 'done',
              checkedAt: new Date(snapshotApp.atsResult.checkedAt).toISOString(),
            }
          : { state: 'none' },
      },
    }
  }
  if (doc.status !== 'open' && doc.status !== 'closed') return null
  // Closed postings leave public discovery, but an existing tracker row is
  // durable user-owned context. Resolve that ownership before preparing or
  // projecting any JD-derived content; non-owners receive the same 404 as an
  // unknown posting so closure never widens the private-detail boundary.
  if (!userId) {
    if (doc.status !== 'open') return null
    const postingStillAuthoritative = await JobPosting.exists(
      exactDetailPostingLifecycleFilter(id, doc as IJobPosting),
    )
    return postingStillAuthoritative
      ? { ...shellOf(doc as IJobPosting), gated: true }
      : null
  }
  let app = await JobApplication.findOne({ userId, jobPostingId: id })
    .select('_id status jobSnapshot verifiedPracticeSessionIds interviewDate interviewDateConfidence interviewDatePreference tailoredVersion.createdAt tailoredVersion.jdHash appliedWith.wasTailored atsResult atsRequestedAt')
    .lean()
  if (doc.status === 'closed' && !app) return null

  const postingState = jobPostingStateOf(doc as IJobPosting)
  const practice = postingState === 'restricted'
    ? { jobDescription: '' }
    : await preparePracticeHandoffPosting(doc)
  const jd = practice.jobDescription
  const canonicalApplyOptions = postingState === 'live'
    ? canonicalApplyOptionsOf(doc.provenance)
        // Crowd-healed ladder (§4b): rungs with dead-click reports sink below
        // clean ones — demoted, never hidden (they may still work for others).
        .sort((a, b) => Number(a.broken) - Number(b.broken) || TIER_RANK[a.tier] - TIER_RANK[b.tier])
    : []
  const allApplyOptionsDemoted =
    canonicalApplyOptions.length > 0 && canonicalApplyOptions.every((option) => option.broken)
  const applyOptions = canonicalApplyOptions
    .map(({ optionId, url, tier, viaSite }) => ({ optionId, url, tier, viaSite }))
  // An atsResult is 'done' only for the CURRENT (resume x JD) pair (Codex
  // on #521): a JD merge OR a resume edit re-opens the check. The resume
  // comparison costs two User reads, so it runs only on the narrow path
  // where a result exists and the JD already matches. Rows with nothing to
  // compare against (legacy result without resumeHash, or the resume
  // deleted since) keep the historical score — better than a dead button.
  let atsCurrent = postingState !== 'restricted' && !!app?.atsResult && (!jd || app.atsResult.jdHash === xrayHashOf(jd))
  if (atsCurrent && app?.atsResult?.resumeHash) {
    const base = await getBaseResume(userId)
    const full = base ? await getResume(userId, base.id) : null
    const resumeText = (full as { fullText?: string } | null)?.fullText ?? ''
    // Dual acceptance (Codex #541): legacy resumeHash values were computed
    // pre-whitespace-collapse on raw resume text (resumes carry newlines).
    // Both forms count as current — new writes converge on xrayHashOf.
    if (resumeText) {
      atsCurrent =
        app.atsResult.resumeHash === xrayHashOf(resumeText) ||
        app.atsResult.resumeHash === legacyXrayHashOf(resumeText)
    }
  }
  // Practice preparation and ATS-current resolution both cross long async
  // boundaries. Re-bind the response to lifecycle authority after them;
  // benign content refreshes may advance updatedAt, while source-revoked
  // status/reason can never match this predicate.
  const [postingStillAuthoritative, applicationStillExists] = await Promise.all([
    JobPosting.exists(exactDetailPostingLifecycleFilter(id, doc as IJobPosting)),
    app
      ? JobApplication.exists({ _id: app._id, userId, jobPostingId: id })
      : Promise.resolve(true),
  ])
  if (!postingStillAuthoritative || (doc.status === 'closed' && !applicationStillExists)) return null
  if (!applicationStillExists) {
    app = null
    atsCurrent = false
  }

  const fullShell = shellOf(doc as IJobPosting)
  const retainedShell = { ...fullShell }
  delete retainedShell.applyTier
  const snapshotLocation = app?.jobSnapshot?.location?.trim() ?? ''
  const restrictedShell: Omit<JobDetailShell, 'gated'> = {
    id: String(doc._id),
    title: app?.jobSnapshot?.title ?? 'Saved job',
    company: app?.jobSnapshot?.company ?? '',
    locations: snapshotLocation ? [snapshotLocation] : [],
    isRemote: /\bremote\b/i.test(snapshotLocation),
  }
  const hasCanonicalJd = !!practice.jdHash
  const hasCachedXray = hasCanonicalJd && !!doc.parsedJD && doc.parsedJDHash === xrayHashOf(jd)
  const capabilities = {
    apply: postingState === 'live' && applyOptions.length > 0,
    viewSource: postingState === 'live' && applyOptions.length > 0,
    xray: hasCanonicalJd && (postingState === 'live' || hasCachedXray),
    tailor: postingState !== 'restricted' && !!jd.trim(),
    practice: postingState !== 'restricted' && !!practice.role && hasCanonicalJd,
    atsCheck: postingState !== 'restricted' && !!app && hasCanonicalJd,
  }
  const tailorInputHash = capabilities.tailor ? practice.jdHash : undefined
  return {
    ...(postingState === 'live'
      ? fullShell
      : postingState === 'archived'
        ? retainedShell
        : restrictedShell),
    gated: false,
    postingState,
    capabilities,
    ...(tailorInputHash ? { tailorInputHash } : {}),
    ...(postingState !== 'restricted' ? { jd } : {}),
    ...(capabilities.practice && practice.role && practice.jdHash
      ? {
          practiceRole: practice.role,
          practiceHandoffToken: mintPracticeHandoffToken({
            userId,
            jobId: String(doc._id),
            jdHash: practice.jdHash,
          }),
        }
      : {}),
    applyOptions,
    allApplyOptionsDemoted,
    flags: postingState === 'restricted'
      ? { staffing: false, shortJd: false, repost: false }
      : { staffing: !!doc.flags?.staffing, shortJd: !!doc.flags?.shortJd, repost: !!doc.flags?.repost },
    application: app
      ? {
          applicationId: String(app._id),
          status: app.status,
          interviewDate: app.interviewDate ? new Date(app.interviewDate).toISOString() : undefined,
          interviewDateConfidence: app.interviewDateConfidence,
          interviewDatePreference: app.interviewDatePreference,
          ...(postingState !== 'restricted' && app.tailoredVersion?.createdAt
            ? {
                tailoredResume: {
                  createdAt: new Date(app.tailoredVersion.createdAt).toISOString(),
                  current: !!jd && app.tailoredVersion.jdHash === xrayHashOf(jd),
                },
              }
            : {}),
          ...(app.appliedWith
            ? { appliedWith: { wasTailored: app.appliedWith.wasTailored } }
            : {}),
          practiceCount: Math.min(3, app.verifiedPracticeSessionIds?.length ?? 0),
          ats: postingState === 'restricted' && app.atsResult
            ? { state: 'done' as const, checkedAt: new Date(app.atsResult.checkedAt).toISOString() }
            : app.atsResult && atsCurrent
              ? { state: 'done' as const, score: app.atsResult.score, missingKeywords: (app.atsResult.missingKeywords ?? []).slice(0, 5), checkedAt: new Date(app.atsResult.checkedAt).toISOString() }
            : app.atsRequestedAt && Date.now() - new Date(app.atsRequestedAt).getTime() < 3 * 60_000
              ? { state: 'pending' as const }
              : { state: 'none' as const },
        }
      : null,
  }
}
