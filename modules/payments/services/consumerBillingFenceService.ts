import mongoose, { type ClientSession } from 'mongoose'
import {
  ConsumerBillingFence,
  type ConsumerBillingFenceState,
} from '../models/ConsumerBillingFence'
import type { CheckoutIntentKind } from '../models/CheckoutIntent'
import type { ProviderMode } from '../types/catalog'

export class CheckoutBlockedByAccountDeletionError extends Error {
  constructor() {
    super('Checkout is unavailable while account deletion is pending')
    this.name = 'CheckoutBlockedByAccountDeletionError'
  }
}

export class ConsumerBillingFenceConflictError extends Error {
  constructor() {
    super('Consumer billing fence changed concurrently')
    this.name = 'ConsumerBillingFenceConflictError'
  }
}

export interface ConsumerBillingFenceSnapshot {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  state: ConsumerBillingFenceState
  version: number
  lastCheckoutIntentId?: mongoose.Types.ObjectId
  lastCheckoutIntentKind?: CheckoutIntentKind
  lastCheckoutProviderMode?: ProviderMode
  lastCheckoutClaimedAt?: Date
  deletionRequestedAt?: Date
}

export interface CheckoutFenceClaimInput {
  userId: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  claimedAt: Date
}

export interface DeletionFenceClaimInput {
  userId: mongoose.Types.ObjectId
  requestedAt: Date
}

export interface CreateConsumerBillingFenceInput {
  userId: mongoose.Types.ObjectId
  state: ConsumerBillingFenceState
  version: 1
  lastCheckoutIntentId?: mongoose.Types.ObjectId
  lastCheckoutIntentKind?: CheckoutIntentKind
  lastCheckoutProviderMode?: ProviderMode
  lastCheckoutClaimedAt?: Date
  deletionRequestedAt?: Date
}

export interface UpdateActiveCheckoutFenceInput
extends CheckoutFenceClaimInput {
  expectedVersion: number
}

export interface TransitionDeletionFenceInput
extends DeletionFenceClaimInput {
  expectedVersion: number
}

export interface ConsumerBillingFenceMutationStore {
  load(
    userId: mongoose.Types.ObjectId,
  ): Promise<ConsumerBillingFenceSnapshot | null>
  create(
    input: CreateConsumerBillingFenceInput,
  ): Promise<ConsumerBillingFenceSnapshot>
  updateActiveCheckoutClaim(
    input: UpdateActiveCheckoutFenceInput,
  ): Promise<ConsumerBillingFenceSnapshot | null>
  transitionToDeletionPending(
    input: TransitionDeletionFenceInput,
  ): Promise<ConsumerBillingFenceSnapshot | null>
}

interface LeanConsumerBillingFence {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  state: ConsumerBillingFenceState
  version: number
  lastCheckoutIntentId?: mongoose.Types.ObjectId
  lastCheckoutIntentKind?: CheckoutIntentKind
  lastCheckoutProviderMode?: ProviderMode
  lastCheckoutClaimedAt?: Date
  deletionRequestedAt?: Date
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime())
}

function assertFenceSnapshot(
  value: ConsumerBillingFenceSnapshot,
): void {
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    throw new ConsumerBillingFenceConflictError()
  }
}

function snapshot(
  value: LeanConsumerBillingFence,
): ConsumerBillingFenceSnapshot {
  const result: ConsumerBillingFenceSnapshot = {
    id: value._id,
    userId: value.userId,
    state: value.state,
    version: value.version,
    lastCheckoutIntentId: value.lastCheckoutIntentId,
    lastCheckoutIntentKind: value.lastCheckoutIntentKind,
    lastCheckoutProviderMode:
      value.lastCheckoutProviderMode,
    lastCheckoutClaimedAt: value.lastCheckoutClaimedAt,
    deletionRequestedAt: value.deletionRequestedAt,
  }
  assertFenceSnapshot(result)
  return result
}

export async function claimConsumerBillingFenceForCheckout(
  input: CheckoutFenceClaimInput,
  store: ConsumerBillingFenceMutationStore,
): Promise<ConsumerBillingFenceSnapshot> {
  if (
    !mongoose.isValidObjectId(input.userId) ||
    !mongoose.isValidObjectId(input.checkoutIntentId) ||
    !validDate(input.claimedAt)
  ) {
    throw new TypeError('Checkout billing fence claim is invalid')
  }

  const current = await store.load(input.userId)
  if (current?.state === 'deletion_pending') {
    throw new CheckoutBlockedByAccountDeletionError()
  }
  if (!current) {
    return store.create({
      userId: input.userId,
      state: 'active',
      version: 1,
      lastCheckoutIntentId: input.checkoutIntentId,
      lastCheckoutIntentKind: input.kind,
      lastCheckoutProviderMode: input.providerMode,
      lastCheckoutClaimedAt: input.claimedAt,
    })
  }
  assertFenceSnapshot(current)

  const updated = await store.updateActiveCheckoutClaim({
    ...input,
    expectedVersion: current.version,
  })
  if (!updated) {
    throw new ConsumerBillingFenceConflictError()
  }
  return updated
}

export async function markConsumerBillingFenceDeletionPending(
  input: DeletionFenceClaimInput,
  store: ConsumerBillingFenceMutationStore,
): Promise<ConsumerBillingFenceSnapshot> {
  if (
    !mongoose.isValidObjectId(input.userId) ||
    !validDate(input.requestedAt)
  ) {
    throw new TypeError('Deletion billing fence claim is invalid')
  }

  const current = await store.load(input.userId)
  if (!current) {
    return store.create({
      userId: input.userId,
      state: 'deletion_pending',
      version: 1,
      deletionRequestedAt: input.requestedAt,
    })
  }
  assertFenceSnapshot(current)
  if (current.state === 'deletion_pending') return current

  const updated = await store.transitionToDeletionPending({
    userId: input.userId,
    requestedAt: input.requestedAt,
    expectedVersion: current.version,
  })
  if (!updated) {
    throw new ConsumerBillingFenceConflictError()
  }
  return updated
}

export function mongoConsumerBillingFenceMutationStore(
  session: ClientSession,
): ConsumerBillingFenceMutationStore {
  return {
    async load(userId) {
      const fence = await ConsumerBillingFence.findOne({
        userId,
      }).session(session).lean<LeanConsumerBillingFence>()
      return fence ? snapshot(fence) : null
    },

    async create(input) {
      const [created] = await ConsumerBillingFence.create(
        [input],
        { session },
      )
      return snapshot(
        created.toObject() as LeanConsumerBillingFence,
      )
    },

    async updateActiveCheckoutClaim(input) {
      const updated =
        await ConsumerBillingFence.findOneAndUpdate(
          {
            userId: input.userId,
            state: 'active',
            version: input.expectedVersion,
          },
          {
            $set: {
              lastCheckoutIntentId: input.checkoutIntentId,
              lastCheckoutIntentKind: input.kind,
              lastCheckoutProviderMode: input.providerMode,
              lastCheckoutClaimedAt: input.claimedAt,
            },
            $inc: { version: 1 },
          },
          {
            new: true,
            runValidators: true,
            session,
          },
        ).lean<LeanConsumerBillingFence>()
      return updated ? snapshot(updated) : null
    },

    async transitionToDeletionPending(input) {
      const updated =
        await ConsumerBillingFence.findOneAndUpdate(
          {
            userId: input.userId,
            state: 'active',
            version: input.expectedVersion,
          },
          {
            $set: {
              state: 'deletion_pending',
              deletionRequestedAt: input.requestedAt,
            },
            $inc: { version: 1 },
          },
          {
            new: true,
            runValidators: true,
            session,
          },
        ).lean<LeanConsumerBillingFence>()
      return updated ? snapshot(updated) : null
    },
  }
}
