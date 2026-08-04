import { createHash } from 'node:crypto'
import type { CmsAuditActor } from '../types/admin'
import type {
  CouponRevisionStatus,
  CouponRevisionTerms,
} from '../types/catalog'
import { canonicalJson } from './canonicalJson'

export const COUPON_LIFECYCLE_TRANSITION_SCHEMA_VERSION =
  'coupon_lifecycle_transition_v1' as const
export const COUPON_LIFECYCLE_HISTORY_MAX_ENTRIES = 128 as const

const SHA256 = /^[a-f0-9]{64}$/
const ALLOWED_TRANSITIONS = {
  draft: ['active', 'scheduled'],
  scheduled: ['active', 'paused', 'expired'],
  active: ['paused', 'expired'],
  paused: ['active', 'scheduled', 'expired'],
  expired: [],
} as const satisfies Readonly<
  Record<CouponRevisionStatus, readonly CouponRevisionStatus[]>
>

export interface CouponLifecycleTransition {
  readonly schemaVersion:
    typeof COUPON_LIFECYCLE_TRANSITION_SCHEMA_VERSION
  readonly version: number
  readonly fromStatus: CouponRevisionStatus
  readonly toStatus: CouponRevisionStatus
  readonly effectiveAt: Date
  readonly recordedAt: Date
  readonly scheduledStartAt: Date | null
  readonly scheduledEndAt: Date | null
  readonly actorDigest: string
  readonly mutationIdDigest: string
  readonly correlationIdDigest: string
  readonly reasonDigest: string
  readonly auditLinkDigest: string
  readonly previousTransitionDigest: string | null
  readonly transitionDigest: string
}

interface TransitionContext {
  readonly campaignId: string
  readonly revision: number
}

interface TransitionIdentityInput extends TransitionContext {
  readonly actor: CmsAuditActor
  readonly mutationId: string
  readonly correlationId: string
  readonly reason: string
  readonly toStatus: CouponRevisionStatus
  readonly terms: Pick<CouponRevisionTerms, 'startsAt' | 'endsAt'>
}

export interface BuildCouponLifecycleTransitionInput
  extends TransitionIdentityInput {
  readonly fromStatus: CouponRevisionStatus
  readonly history?: readonly CouponLifecycleTransition[]
  readonly recordedAt: Date
}

export interface ValidateCouponLifecycleHistoryInput
  extends TransitionContext {
  readonly value: unknown
  readonly terms: Pick<CouponRevisionTerms, 'startsAt' | 'endsAt'>
  readonly currentStatus: CouponRevisionStatus
  readonly allowEmpty?: boolean
}

export interface ResolveCouponActiveLifecycleProofInput
  extends ValidateCouponLifecycleHistoryInput {
  readonly at: Date
}

export interface CouponActiveLifecycleProof {
  readonly activeAt: Date
  readonly version: number
  readonly effectiveAt: Date
  readonly recordedAt: Date
  readonly scheduledStartAt: Date | null
  readonly scheduledEndAt: Date | null
  readonly transitionDigest: string
  readonly auditLinkDigest: string
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\n${canonicalJson(value)}`, 'utf8')
    .digest('hex')
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function transitionAllowed(
  fromStatus: CouponRevisionStatus,
  toStatus: CouponRevisionStatus,
): boolean {
  return (
    ALLOWED_TRANSITIONS[fromStatus] as
      readonly CouponRevisionStatus[]
  ).includes(toStatus)
}

function sameDate(
  left: Date | null,
  right: Date | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && left.getTime() === right.getTime()
}

function transitionWithinScheduledWindow(
  transition: Pick<
    CouponLifecycleTransition,
    | 'toStatus'
    | 'effectiveAt'
    | 'scheduledStartAt'
    | 'scheduledEndAt'
  >,
): boolean {
  if (
    transition.scheduledStartAt !== null &&
    transition.scheduledEndAt !== null &&
    transition.scheduledEndAt <= transition.scheduledStartAt
  ) {
    return false
  }
  if (transition.toStatus === 'scheduled') {
    return (
      transition.scheduledStartAt !== null &&
      transition.effectiveAt < transition.scheduledStartAt
    )
  }
  if (transition.toStatus !== 'active') return true
  return (
    (
      transition.scheduledStartAt === null ||
      transition.effectiveAt >= transition.scheduledStartAt
    ) &&
    (
      transition.scheduledEndAt === null ||
      transition.effectiveAt < transition.scheduledEndAt
    )
  )
}

function scheduledWindow(
  terms: Pick<CouponRevisionTerms, 'startsAt' | 'endsAt'>,
) {
  return {
    scheduledStartAt: terms.startsAt
      ? new Date(terms.startsAt)
      : null,
    scheduledEndAt: terms.endsAt
      ? new Date(terms.endsAt)
      : null,
  }
}

function transitionAction(
  toStatus: CouponRevisionStatus,
): 'coupon_activated' | 'coupon_paused' | 'coupon_expired' {
  if (toStatus === 'paused') return 'coupon_paused'
  if (toStatus === 'expired') return 'coupon_expired'
  return 'coupon_activated'
}

function auditLinkDigest(input: TransitionContext & {
  toStatus: CouponRevisionStatus
  actorDigest: string
  mutationIdDigest: string
  correlationIdDigest: string
  reasonDigest: string
}): string {
  return digest('coupon-lifecycle-audit-link-v1', {
    action: transitionAction(input.toStatus),
    targetType: 'CouponCampaignRevision',
    targetId: `${input.campaignId}:${input.revision}`,
    actorDigest: input.actorDigest,
    mutationIdDigest: input.mutationIdDigest,
    correlationIdDigest: input.correlationIdDigest,
    reasonDigest: input.reasonDigest,
    toStatus: input.toStatus,
  })
}

function identity(input: TransitionIdentityInput) {
  const actorDigest = digest('coupon-lifecycle-actor-v1', {
    userId: input.actor.userId,
    role: input.actor.role,
  })
  const mutationIdDigest = digest(
    'coupon-lifecycle-mutation-id-v1',
    { mutationId: input.mutationId.trim() },
  )
  const correlationIdDigest = digest(
    'coupon-lifecycle-correlation-id-v1',
    { correlationId: input.correlationId.trim() },
  )
  const reasonDigest = digest(
    'coupon-lifecycle-reason-v1',
    { reason: input.reason.trim() },
  )
  const window = scheduledWindow(input.terms)
  const auditLink = auditLinkDigest({
    campaignId: input.campaignId,
    revision: input.revision,
    toStatus: input.toStatus,
    actorDigest,
    mutationIdDigest,
    correlationIdDigest,
    reasonDigest,
  })
  return {
    ...window,
    actorDigest,
    mutationIdDigest,
    correlationIdDigest,
    reasonDigest,
    auditLinkDigest: auditLink,
  }
}

function digestBody(
  context: TransitionContext,
  transition: Omit<CouponLifecycleTransition, 'transitionDigest'>,
) {
  return {
    campaignId: context.campaignId,
    revision: context.revision,
    ...transition,
  }
}

function strictTransition(
  value: unknown,
): value is CouponLifecycleTransition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const transition = value as Record<string, unknown>
  const keys = [
    'schemaVersion',
    'version',
    'fromStatus',
    'toStatus',
    'effectiveAt',
    'recordedAt',
    'scheduledStartAt',
    'scheduledEndAt',
    'actorDigest',
    'mutationIdDigest',
    'correlationIdDigest',
    'reasonDigest',
    'auditLinkDigest',
    'previousTransitionDigest',
    'transitionDigest',
  ]
  return (
    Object.keys(transition).length === keys.length &&
    keys.every((key) => Object.hasOwn(transition, key)) &&
    transition.schemaVersion ===
      COUPON_LIFECYCLE_TRANSITION_SCHEMA_VERSION &&
    Number.isSafeInteger(transition.version) &&
    (transition.version as number) > 0 &&
    typeof transition.fromStatus === 'string' &&
    Object.hasOwn(ALLOWED_TRANSITIONS, transition.fromStatus) &&
    typeof transition.toStatus === 'string' &&
    Object.hasOwn(ALLOWED_TRANSITIONS, transition.toStatus) &&
    validDate(transition.effectiveAt) &&
    validDate(transition.recordedAt) &&
    (
      transition.scheduledStartAt === null ||
      validDate(transition.scheduledStartAt)
    ) &&
    (
      transition.scheduledEndAt === null ||
      validDate(transition.scheduledEndAt)
    ) &&
    [
      transition.actorDigest,
      transition.mutationIdDigest,
      transition.correlationIdDigest,
      transition.reasonDigest,
      transition.auditLinkDigest,
      transition.transitionDigest,
    ].every((value) => typeof value === 'string' && SHA256.test(value)) &&
    (
      transition.previousTransitionDigest === null ||
      (
        typeof transition.previousTransitionDigest === 'string' &&
        SHA256.test(transition.previousTransitionDigest)
      )
    )
  )
}

export function validateCouponLifecycleHistory(
  input: ValidateCouponLifecycleHistoryInput,
): readonly CouponLifecycleTransition[] | null {
  if (
    !Array.isArray(input.value) ||
    input.value.length > COUPON_LIFECYCLE_HISTORY_MAX_ENTRIES ||
    (!input.allowEmpty && input.value.length === 0)
  ) {
    return null
  }
  const history = input.value as unknown[]
  const expectedWindow = scheduledWindow(input.terms)
  const mutationDigests = new Set<string>()
  let previous: CouponLifecycleTransition | undefined
  for (let index = 0; index < history.length; index += 1) {
    const candidate = history[index]
    if (!strictTransition(candidate)) return null
    const transition = candidate as CouponLifecycleTransition
    if (
      transition.version !== index + 1 ||
      !transitionAllowed(
        transition.fromStatus,
        transition.toStatus,
      ) ||
      transition.effectiveAt.getTime() !==
        transition.recordedAt.getTime() ||
      !sameDate(
        transition.scheduledStartAt,
        expectedWindow.scheduledStartAt,
      ) ||
      !sameDate(
        transition.scheduledEndAt,
        expectedWindow.scheduledEndAt,
      ) ||
      !transitionWithinScheduledWindow(transition) ||
      transition.previousTransitionDigest !==
        (previous?.transitionDigest ?? null) ||
      (
        previous !== undefined &&
        (
          transition.fromStatus !== previous.toStatus ||
          transition.recordedAt < previous.recordedAt
        )
      ) ||
      mutationDigests.has(transition.mutationIdDigest)
    ) {
      return null
    }
    if (
      transition.auditLinkDigest !== auditLinkDigest({
        campaignId: input.campaignId,
        revision: input.revision,
        toStatus: transition.toStatus,
        actorDigest: transition.actorDigest,
        mutationIdDigest: transition.mutationIdDigest,
        correlationIdDigest: transition.correlationIdDigest,
        reasonDigest: transition.reasonDigest,
      })
    ) {
      return null
    }
    const { transitionDigest, ...body } = transition
    if (
      transitionDigest !== digest(
        'coupon-lifecycle-transition-v1',
        digestBody(input, body),
      )
    ) {
      return null
    }
    mutationDigests.add(transition.mutationIdDigest)
    previous = transition
  }
  if (
    previous !== undefined &&
    previous.toStatus !== input.currentStatus
  ) {
    return null
  }
  return history as CouponLifecycleTransition[]
}

export function buildCouponLifecycleTransition(
  input: BuildCouponLifecycleTransitionInput,
): CouponLifecycleTransition {
  const history = validateCouponLifecycleHistory({
    ...input,
    value: input.history ?? [],
    currentStatus: input.fromStatus,
    allowEmpty: true,
  })
  if (
    !history ||
    history.length >= COUPON_LIFECYCLE_HISTORY_MAX_ENTRIES ||
    !validDate(input.recordedAt) ||
    !transitionAllowed(input.fromStatus, input.toStatus)
  ) {
    throw new TypeError('Coupon lifecycle transition is invalid')
  }
  const last = history.at(-1)
  const recordedAt = new Date(Math.max(
    input.recordedAt.getTime(),
    last?.recordedAt.getTime() ?? input.recordedAt.getTime(),
  ))
  const transitionWithoutDigest = {
    schemaVersion: COUPON_LIFECYCLE_TRANSITION_SCHEMA_VERSION,
    version: history.length + 1,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    effectiveAt: new Date(recordedAt),
    recordedAt,
    ...identity(input),
    previousTransitionDigest: last?.transitionDigest ?? null,
  } satisfies Omit<CouponLifecycleTransition, 'transitionDigest'>
  if (!transitionWithinScheduledWindow(transitionWithoutDigest)) {
    throw new TypeError('Coupon lifecycle transition is outside its schedule')
  }
  return Object.freeze({
    ...transitionWithoutDigest,
    transitionDigest: digest(
      'coupon-lifecycle-transition-v1',
      digestBody(input, transitionWithoutDigest),
    ),
  })
}

export function couponLifecycleReplayDisposition(
  input: TransitionIdentityInput & {
    readonly history?: readonly CouponLifecycleTransition[]
    readonly currentStatus: CouponRevisionStatus
  },
): 'none' | 'exact' | 'conflict' {
  const expected = identity(input)
  const duplicate = input.history?.find(
    (transition) =>
      transition.mutationIdDigest === expected.mutationIdDigest,
  )
  if (!duplicate) return 'none'
  const tail = input.history?.at(-1)
  return (
    duplicate === tail &&
    duplicate.toStatus === input.toStatus &&
    input.currentStatus === input.toStatus &&
    duplicate.actorDigest === expected.actorDigest &&
    duplicate.correlationIdDigest === expected.correlationIdDigest &&
    duplicate.reasonDigest === expected.reasonDigest &&
    duplicate.auditLinkDigest === expected.auditLinkDigest &&
    sameDate(
      duplicate.scheduledStartAt,
      expected.scheduledStartAt,
    ) &&
    sameDate(
      duplicate.scheduledEndAt,
      expected.scheduledEndAt,
    )
  )
    ? 'exact'
    : 'conflict'
}

export function resolveCouponActiveLifecycleProof(
  input: ResolveCouponActiveLifecycleProofInput,
): CouponActiveLifecycleProof | null {
  if (!validDate(input.at)) return null
  const history = validateCouponLifecycleHistory(input)
  if (!history) return null
  let applicable: CouponLifecycleTransition | undefined
  for (const transition of history) {
    if (
      transition.effectiveAt <= input.at &&
      transition.recordedAt <= input.at
    ) {
      applicable = transition
    }
  }
  if (
    !applicable ||
    applicable.toStatus !== 'active' ||
    (
      applicable.scheduledStartAt !== null &&
      applicable.scheduledStartAt > input.at
    ) ||
    (
      applicable.scheduledEndAt !== null &&
      applicable.scheduledEndAt <= input.at
    )
  ) {
    return null
  }
  return Object.freeze({
    activeAt: new Date(input.at),
    version: applicable.version,
    effectiveAt: new Date(applicable.effectiveAt),
    recordedAt: new Date(applicable.recordedAt),
    scheduledStartAt: applicable.scheduledStartAt
      ? new Date(applicable.scheduledStartAt)
      : null,
    scheduledEndAt: applicable.scheduledEndAt
      ? new Date(applicable.scheduledEndAt)
      : null,
    transitionDigest: applicable.transitionDigest,
    auditLinkDigest: applicable.auditLinkDigest,
  })
}
