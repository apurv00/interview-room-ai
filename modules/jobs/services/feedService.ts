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

/**
 * Feed serving (PRODUCT_FLOW §1 Stage 0, Wave 3.1) — Tier-A DETERMINISTIC
 * ranking. Rules only:
 * - Serving NEVER consumes llmVerdict fields at launch (ruling #16 serving
 *   honesty: rank may read typed verdict fields only once enforcement is on
 *   AND the reason-chip vocabulary names that basis). Soft-closed rows are
 *   already `status:'closed'` and excluded by the status filter.
 * - Demotion flags DEMOTE, never hide (ruling #15) — a staffing/short-JD
 *   row sinks, it does not disappear.
 * - Copy vocabulary for this tier stays claim-minimal — no resume/readiness
 *   claims exist at Tier-A (the UI owns the words; this module owns making
 *   them true: rank inputs are title/domain, recency, apply-path quality).
 *   City/location is NEITHER an input NOR a rank signal (founder directive
 *   2026-07-16, supersedes ruling #17's city-as-ranking-signal: typed
 *   cities hard-collapsed the pool — 'Bangalore' matched zero stored keys
 *   ('bengaluru') and left only the 354 remote rows).
 *
 * P-2 (founder ruling 2026-07-14): public feed, auth-gated detail — the
 * DETAIL projection is split anon-shell vs authed-full SERVER-SIDE here, so
 * no route can accidentally ship the JD/apply URLs to an anonymous client.
 */

const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50
/** Bounded candidate pull — scored in-app; index {domain, locationKeys, status, postedAt} serves the scan. */
const CANDIDATE_POOL = 400
/** When the pull is domain-first (derived roleDomain), a small recent
 *  cross-domain tail keeps thin domains from rendering an empty feed. */
const MIXED_TAIL = 100

export interface FeedQuery {
  /** Explicit ?domain= (press surfaces) — a HARD filter: the link promised
   *  "N {domain} jobs" and must deliver exactly that pool. */
  domain?: string
  /** Derived from targetRole server-side (roleToJobsDomain) — a SOFT
   *  domain: pulls domain-first and ranks the domain as a class above
   *  everything else, but never empties the feed (founder RCA 2026-07-16:
   *  the 400-newest cross-domain pull admitted 15 of 125 open pm rows). */
  roleDomain?: string
  page?: number
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
  /** Tier-A cards claim ONLY "title & location match"; Tier-B cards may
   *  name the resume evidence — but ONLY the skills that actually matched
   *  (reveal honesty, §4a: claim "based on your resume: X, Y" solely from
   *  this list). */
  relevance: 'title-location' | 'resume'
  matchedSkills: string[]
}

// ── Tier-A scoring (deterministic; every weight visible in one place) ────────
const TIER_BONUS: Record<ApplyTier, number> = {
  'direct-ats': 30,
  employer: 25,
  'aggregator-deep': 15,
  'platform-funnel': 8,
  'aggregator-redirect': 3,
}
const DOMAIN_MATCH_BONUS = 25
/** Tier-B: per matched resume skill (cap 3 count) + target-role title affinity. */
const SKILL_MATCH_BONUS = 8
const SKILL_MATCH_CAP = 3
const ROLE_MATCH_BONUS = 20
const ROLE_MATCH_JACCARD = 0.5
const DEMOTION = { staffing: 10, shortJd: 8, repost: 6, confidential: 4 } as const
/** Linear recency decay to zero over 21 days — beyond that, freshness stops discriminating. */
const RECENCY_MAX = 25
const RECENCY_WINDOW_DAYS = 21

/** Browser-navigation policy shared with the production link checker: only
 * credential-free HTTP(S) on default ports, excluding localhost and every
 * non-global IP literal, may reach a candidate. DNS names remain subject to
 * the server-side pinned resolver when the liveness worker checks them. */
export function isSafeHttpUrl(u: string): boolean {
  return canonicalizeCheckableLink(u) !== null
}

export function bestApplyTierOf(doc: Pick<IJobPosting, 'provenance'>): ApplyTier | undefined {
  // Crowd-healing reaches the FEED too (Codex on #522): a reported rung
  // must not keep earning the 'Direct application' badge and its rank bonus
  // while the detail ladder demotes it. Clean rungs win; if every rung is
  // reported, fall back to the best of them (demote, never hide).
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

export function tierAScore(
  doc: Pick<IJobPosting, 'provenance' | 'flags' | 'confidentialCompany' | 'domain' | 'isRemote' | 'postedAt'>,
  q: { domain?: string },
  now: Date
): number {
  let score = 0
  const tier = bestApplyTierOf(doc)
  if (tier) score += TIER_BONUS[tier]
  if (q.domain && doc.domain === q.domain) score += DOMAIN_MATCH_BONUS
  if (doc.postedAt) {
    const ageDays = (now.getTime() - doc.postedAt.getTime()) / 86_400_000
    if (ageDays >= 0 && ageDays < RECENCY_WINDOW_DAYS) {
      score += RECENCY_MAX * (1 - ageDays / RECENCY_WINDOW_DAYS)
    }
  }
  if (doc.flags?.staffing) score -= DEMOTION.staffing
  if (doc.flags?.shortJd) score -= DEMOTION.shortJd
  if (doc.flags?.repost) score -= DEMOTION.repost
  if (doc.confidentialCompany) score -= DEMOTION.confidential
  return score
}

/** Tier-B on top of Tier-A: same deterministic base, plus resume-skill and
 *  target-role affinity. With no skills/targetRole this is EXACTLY tierAScore
 *  (pinned by test) — the 3-questions path gets Tier-A + role filter and no
 *  resume-flavored claims. */
export function tierBScore(
  doc: Pick<IJobPosting, 'provenance' | 'flags' | 'confidentialCompany' | 'domain' | 'isRemote' | 'postedAt' | 'title' | 'titleTokens'>,
  q: { domain?: string; skills?: string[]; targetRole?: string },
  now: Date
): number {
  let score = tierAScore(doc, q, now)
  const matched = matchedSkillsOf(doc, q.skills)
  score += Math.min(matched.length, SKILL_MATCH_CAP) * SKILL_MATCH_BONUS
  if (q.targetRole && titleJaccard(q.targetRole, doc.title ?? '') >= ROLE_MATCH_JACCARD) {
    score += ROLE_MATCH_BONUS
  }
  return score
}

export async function getFeed(query: FeedQuery, now = new Date()): Promise<{ cards: FeedCard[]; page: number; pageSize: number; hasMore: boolean; total: number; sharpened: number }> {
  const page = Math.max(1, Math.floor(query.page ?? 1))
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize ?? PAGE_SIZE_DEFAULT)))

  const select = 'title titleTokens company locations isRemote domain postedAt salaryText provenance flags confidentialCompany'
  const sort = { postedAt: -1 as const, _id: -1 as const }
  let docs: Awaited<ReturnType<typeof pull>>
  async function pull(filter: Record<string, unknown>, limit: number) {
    return JobPosting.find(filter).select(select).sort(sort).limit(limit).lean()
  }
  if (!query.domain && query.roleDomain) {
    // Domain-FIRST pull (founder RCA 2026-07-16): every open row of the
    // seeker's domain reaches scoring — the newest-across-domains pull
    // admitted 15 of 125 open pm rows and starved every non-fresh domain.
    // The mixed tail keeps thin domains from rendering an empty feed.
    const [domainRows, mixedTail] = await Promise.all([
      pull({ status: 'open', domain: query.roleDomain }, CANDIDATE_POOL),
      pull({ status: 'open', domain: { $ne: query.roleDomain } }, MIXED_TAIL),
    ])
    docs = [...domainRows, ...mixedTail]
  } else {
    const filter: Record<string, unknown> = { status: 'open' }
    if (query.domain) filter.domain = query.domain
    docs = await pull(filter, CANDIDATE_POOL)
  }

  const rankDomain = query.domain ?? query.roleDomain
  const rankQ = { domain: rankDomain, skills: query.skills, targetRole: query.targetRole }
  const scored = docs
    .map((d) => ({ d, score: tierBScore(d as IJobPosting, rankQ, now), matched: matchedSkillsOf(d as IJobPosting, query.skills) }))
    .sort((a, b) => {
      // Domain CLASS first: when the seeker names a role, in-domain rows
      // outrank every out-of-domain row — recency/apply-tier order only
      // WITHIN the class (a fresh fullstack job must not beat a week-old
      // pm job for a pm target; recency 25 alone outweighed domain 25).
      const am = rankDomain && a.d.domain === rankDomain ? 1 : 0
      const bm = rankDomain && b.d.domain === rankDomain ? 1 : 0
      return bm - am || b.score - a.score || String(b.d._id).localeCompare(String(a.d._id))
    })

  const start = (page - 1) * pageSize
  const slice = scored.slice(start, start + pageSize)
  return {
    cards: slice.map(({ d, matched }) => ({
      id: String(d._id),
      title: d.title,
      company: d.company,
      locations: d.locations ?? [],
      isRemote: !!d.isRemote,
      domain: d.domain,
      postedAt: d.postedAt ? new Date(d.postedAt).toISOString() : undefined,
      salaryText: d.salaryText,
      applyTier: bestApplyTierOf(d as IJobPosting),
      relevance: matched.length ? ('resume' as const) : ('title-location' as const),
      matchedSkills: matched,
    })),
    page,
    pageSize,
    hasMore: start + pageSize < scored.length,
    total: scored.length,
    // Reveal honesty (§4a): "sharpened N matches" only when matched-skill
    // sets actually changed something — otherwise the UI says "Feed refreshed."
    sharpened: scored.filter((x) => x.matched.length > 0).length,
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
  flags: { staffing: boolean; shortJd: boolean; repost: boolean }
  /** The caller's own tracker row (chip + evidence ticker + ATS inputs). */
  application: {
    applicationId: string
    status: string
    practiceCount: number
    interviewDate?: string
    interviewDateConfidence?: 'exact' | 'week' | 'unknown'
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
      .select('_id status jobSnapshot verifiedPracticeSessionIds interviewDate interviewDateConfidence atsResult atsRequestedAt')
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
      flags: { staffing: false, shortJd: false, repost: false },
      application: {
        applicationId: String(snapshotApp._id),
        status: snapshotApp.status,
        interviewDate: snapshotApp.interviewDate ? new Date(snapshotApp.interviewDate).toISOString() : undefined,
        interviewDateConfidence: snapshotApp.interviewDateConfidence,
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
  let app = await JobApplication.findOne({ userId, jobPostingId: id }).select('_id status jobSnapshot verifiedPracticeSessionIds interviewDate interviewDateConfidence atsResult atsRequestedAt').lean()
  if (doc.status === 'closed' && !app) return null

  const postingState = jobPostingStateOf(doc as IJobPosting)
  const practice = postingState === 'restricted'
    ? { jobDescription: '' }
    : await preparePracticeHandoffPosting(doc)
  const jd = practice.jobDescription
  const applyOptions = postingState === 'live'
    ? canonicalApplyOptionsOf(doc.provenance)
        // Crowd-healed ladder (§4b): rungs with dead-click reports sink below
        // clean ones — demoted, never hidden (they may still work for others).
        .sort((a, b) => Number(a.broken) - Number(b.broken) || TIER_RANK[a.tier] - TIER_RANK[b.tier])
        .map(({ optionId, url, tier, viaSite }) => ({ optionId, url, tier, viaSite }))
    : []
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
    flags: postingState === 'restricted'
      ? { staffing: false, shortJd: false, repost: false }
      : { staffing: !!doc.flags?.staffing, shortJd: !!doc.flags?.shortJd, repost: !!doc.flags?.repost },
    application: app
      ? {
          applicationId: String(app._id),
          status: app.status,
          interviewDate: app.interviewDate ? new Date(app.interviewDate).toISOString() : undefined,
          interviewDateConfidence: app.interviewDateConfidence,
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
