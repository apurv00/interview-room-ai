import {
  BILLING_ROLLOUT_ACTIVATION_EXECUTION_READY,
  BILLING_ROLLOUT_DECISION_CONSUMPTION_READY,
  BILLING_ROLLOUT_EMERGENCY_STOP_EXECUTION_READY,
} from './readiness'
import {
  BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
  BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
  BillingRolloutActivationCommandSchema,
  BillingRolloutEmergencyStopCommandSchema,
  BillingRolloutPhaseRequestCommandSchema,
  assertBillingRolloutActivationApproved,
  billingRolloutDigest,
  canonicalRolloutJson,
  evaluateBillingRolloutAuthority,
  prepareBillingRolloutApproval,
  prepareBillingRolloutRequest,
  type BillingRolloutActivationAttestation,
  type BillingRolloutActivationCommand,
  type BillingRolloutActor,
  type BillingRolloutApprovalCommand,
  type BillingRolloutApprovalEvidence,
  type BillingRolloutAuthorityDecision,
  type BillingRolloutEmergencyStopCommand,
  type BillingRolloutOwnerRole,
  type BillingRolloutPhaseId,
  type BillingRolloutPhaseRequestCommand,
  type BillingRolloutRequestedState,
  type PreparedBillingRolloutApproval,
  type PreparedBillingRolloutRequest,
} from './contracts'

export const BILLING_ROLLOUT_CONTROL_ERROR_CODES = [
  'invalid_request',
  'not_authorized',
  'conflict',
  'not_found',
  'expired',
  'approval_incomplete',
  'activation_disabled',
  'stop_disabled',
  'state_drift',
  'lineage_invalid',
  'recovery_not_preserved',
] as const

export type BillingRolloutControlErrorCode =
  (typeof BILLING_ROLLOUT_CONTROL_ERROR_CODES)[number]

export class BillingRolloutControlError extends Error {
  readonly code: BillingRolloutControlErrorCode

  constructor(
    code: BillingRolloutControlErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'BillingRolloutControlError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export type BillingRolloutRequestStatus =
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'activated'
  | 'expired'
  | 'superseded'

export interface BillingRolloutRequestView extends Omit<
  PreparedBillingRolloutRequest,
  'status' | 'revision'
> {
  readonly status: BillingRolloutRequestStatus
  readonly revision: number
}

export interface BillingRolloutApprovalView extends
  PreparedBillingRolloutApproval {}

export interface BillingRolloutActivationView extends
  BillingRolloutActivationAttestation {
  readonly commandId: string
  readonly correlationId: string
  readonly kind: 'activated'
}

export interface BillingRolloutAuthorityView {
  readonly revision: number
  readonly currentActivationSequence: number
  readonly activeActivationId?: string
  readonly lastActivationId?: string
  readonly stopEpoch: number
  readonly state: 'inert' | 'active' | 'stopped'
}

export interface BillingRolloutEmergencyStopView {
  readonly schemaVersion:
    typeof BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION
  readonly stopId: string
  readonly commandId: string
  readonly correlationId: string
  readonly stopEpoch: number
  readonly authorityRevision: number
  readonly previousActivationId: string
  readonly previousActivationSequence: number
  readonly incidentReference: string
  readonly reason: string
  readonly configBeforeHash: string
  readonly configAfterHash: string
  readonly webhookProcessingPreserved: true
  readonly reconciliationPreserved: true
  readonly stoppedByUserId: string
  readonly stoppedAt: Date
}

export interface BillingRolloutRuntimeSnapshot {
  readonly configRevision: number
  readonly configHash: string
  readonly deploymentId: string
  readonly commitSha: string
  readonly state: BillingRolloutRequestedState
  /**
   * Runtime-only HMAC subject identifiers. Raw user IDs are never persisted
   * in rollout manifests or copied into phase and activation artifacts.
   */
  readonly allowlistSubjectHashes: readonly string[]
}

export interface BillingRolloutPreviewEvidence {
  readonly current: BillingRolloutRuntimeSnapshot
  readonly preview: BillingRolloutRuntimeSnapshot
}

export interface BillingRolloutActorAuthorizationInput {
  readonly actor: BillingRolloutActor
  readonly action: 'request' | 'approve' | 'activate' | 'emergency_stop'
  readonly ownerRole?: BillingRolloutOwnerRole
  readonly requestId?: string
  readonly freshAuthenticationRequired: boolean
}

export interface BillingRolloutControlPorts<TTransaction = unknown> {
  readonly authorizeCurrentActor: (
    input: BillingRolloutActorAuthorizationInput,
    transaction: TTransaction,
  ) => Promise<void>
  readonly previewRequest: (
    command: BillingRolloutPhaseRequestCommand,
    transaction: TTransaction,
  ) => Promise<BillingRolloutPreviewEvidence>
  readonly observeActivationBasis: (
    command: BillingRolloutPhaseRequestCommand,
    transaction: TTransaction,
  ) => Promise<BillingRolloutPreviewEvidence>
  /**
   * This port may update only local rollout/config/pointer projections in the
   * caller transaction. It must not read secrets or perform provider/network
   * I/O.
   */
  readonly applyRequestedState: (
    command: BillingRolloutPhaseRequestCommand,
    transaction: TTransaction,
  ) => Promise<BillingRolloutRuntimeSnapshot>
  /**
   * Stops acquisition/enforcement/communications locally while retaining all
   * recovery lanes. Provider cleanup remains an independent recovery concern.
   */
  readonly applyEmergencyStop: (
    command: BillingRolloutEmergencyStopCommand,
    transaction: TTransaction,
  ) => Promise<BillingRolloutRuntimeSnapshot>
  readonly observeDecisionState: (
    transaction: TTransaction,
  ) => Promise<BillingRolloutRuntimeSnapshot>
  readonly loadAuthoritySecretBase64: () => string
}

export interface BillingRolloutControlRepository<
  TTransaction = unknown,
> {
  readonly withTransaction: <T>(
    work: (transaction: TTransaction) => Promise<T>,
  ) => Promise<T>
  readonly loadAuthority: (
    transaction: TTransaction,
  ) => Promise<BillingRolloutAuthorityView>
  readonly findRequestByCommandId: (
    commandId: string,
    transaction: TTransaction,
  ) => Promise<BillingRolloutRequestView | null>
  readonly findRequestById: (
    requestId: string,
    transaction: TTransaction,
  ) => Promise<BillingRolloutRequestView | null>
  readonly findOpenRequest: (
    transaction: TTransaction,
  ) => Promise<BillingRolloutRequestView | null>
  readonly insertRequest: (
    request: PreparedBillingRolloutRequest,
    transaction: TTransaction,
  ) => Promise<void>
  readonly compareAndSetRequestStatus: (
    input: {
      readonly requestId: string
      readonly expectedStatus: BillingRolloutRequestStatus
      readonly expectedRevision: number
      readonly nextStatus: BillingRolloutRequestStatus
    },
    transaction: TTransaction,
  ) => Promise<boolean>
  readonly findApprovalByCommandId: (
    commandId: string,
    transaction: TTransaction,
  ) => Promise<BillingRolloutApprovalView | null>
  readonly listApprovals: (
    requestId: string,
    transaction: TTransaction,
  ) => Promise<readonly BillingRolloutApprovalView[]>
  readonly insertApproval: (
    approval: PreparedBillingRolloutApproval,
    transaction: TTransaction,
  ) => Promise<void>
  readonly findActivationByCommandId: (
    commandId: string,
    transaction: TTransaction,
  ) => Promise<BillingRolloutActivationView | null>
  readonly findActivationById: (
    activationId: string,
    transaction: TTransaction,
  ) => Promise<BillingRolloutActivationView | null>
  readonly insertActivation: (
    activation: BillingRolloutActivationView,
    transaction: TTransaction,
  ) => Promise<void>
  readonly compareAndSetAuthorityActive: (
    input: {
      readonly expected: BillingRolloutAuthorityView
      readonly activation: BillingRolloutActivationView
      readonly actorUserId: string
    },
    transaction: TTransaction,
  ) => Promise<boolean>
  readonly findEmergencyStopByCommandId: (
    commandId: string,
    transaction: TTransaction,
  ) => Promise<BillingRolloutEmergencyStopView | null>
  readonly insertEmergencyStop: (
    stop: BillingRolloutEmergencyStopView,
    transaction: TTransaction,
  ) => Promise<void>
  readonly compareAndSetAuthorityStopped: (
    input: {
      readonly expected: BillingRolloutAuthorityView
      readonly stop: BillingRolloutEmergencyStopView
      readonly actorUserId: string
    },
    transaction: TTransaction,
  ) => Promise<boolean>
}

export interface BillingRolloutDecisionInput {
  readonly userId: string
  readonly userCreatedAt?: Date
  readonly buyerState?: string
  readonly now: Date
}

interface BillingRolloutReadiness {
  readonly activation: boolean
  readonly emergencyStop: boolean
  readonly decisionConsumption: boolean
}

function fail(
  code: BillingRolloutControlErrorCode,
  message: string,
  cause?: unknown,
): BillingRolloutControlError {
  return new BillingRolloutControlError(
    code,
    message,
    cause,
  )
}

function approvalEvidence(
  approvals: readonly BillingRolloutApprovalView[],
): readonly BillingRolloutApprovalEvidence[] {
  return approvals.map((approval) => ({
    requestId: approval.requestId,
    requestDigest: approval.requestDigest,
    ownerRole: approval.ownerRole,
    decision: approval.decision,
    actorUserId: approval.actorUserId,
    approvalDigest: approval.approvalDigest,
  }))
}

function pendingPreparedRequest(
  request: BillingRolloutRequestView,
): PreparedBillingRolloutRequest {
  return {
    ...request,
    status: 'pending_approval',
    revision: 1,
  }
}

function parsePersistedRequest(
  request: BillingRolloutRequestView,
): BillingRolloutPhaseRequestCommand {
  let raw: unknown
  try {
    raw = JSON.parse(request.requestCanonicalJson)
  } catch (cause) {
    throw fail(
      'state_drift',
      'Stored rollout request JSON is invalid',
      cause,
    )
  }
  const parsed = BillingRolloutPhaseRequestCommandSchema.safeParse(raw)
  if (!parsed.success) {
    throw fail('state_drift', 'Stored rollout request failed validation')
  }
  const replay = prepareBillingRolloutRequest({
    command: parsed.data,
    actor: {
      userId: request.requesterUserId,
      cmsRole: request.requesterCmsRole,
    },
    now: request.createdAt,
  })
  const expected = {
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    commandId: request.commandId,
    correlationId: request.correlationId,
    phaseId: request.phaseId,
    requestCanonicalJson: request.requestCanonicalJson,
    requestedStateHash: request.requestedStateHash,
    evidenceBundleHash: request.evidenceBundleHash,
    requesterUserId: request.requesterUserId,
    requesterCmsRole: request.requesterCmsRole,
    requiredApprovalRoles: request.requiredApprovalRoles,
    expectedAuthorityRevision: request.expectedAuthorityRevision,
    expectedCurrentActivationSequence:
      request.expectedCurrentActivationSequence,
    expectedConfigRevision: request.expectedConfigRevision,
    configBeforeHash: request.configBeforeHash,
    configAfterPreviewHash: request.configAfterPreviewHash,
    notBefore: request.notBefore,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
  }
  const actual = {
    requestId: replay.requestId,
    requestDigest: replay.requestDigest,
    commandId: replay.commandId,
    correlationId: replay.correlationId,
    phaseId: replay.phaseId,
    requestCanonicalJson: replay.requestCanonicalJson,
    requestedStateHash: replay.requestedStateHash,
    evidenceBundleHash: replay.evidenceBundleHash,
    requesterUserId: replay.requesterUserId,
    requesterCmsRole: replay.requesterCmsRole,
    requiredApprovalRoles: replay.requiredApprovalRoles,
    expectedAuthorityRevision: replay.expectedAuthorityRevision,
    expectedCurrentActivationSequence:
      replay.expectedCurrentActivationSequence,
    expectedConfigRevision: replay.expectedConfigRevision,
    configBeforeHash: replay.configBeforeHash,
    configAfterPreviewHash: replay.configAfterPreviewHash,
    notBefore: replay.notBefore,
    expiresAt: replay.expiresAt,
    createdAt: replay.createdAt,
  }
  if (canonicalRolloutJson(actual) !== canonicalRolloutJson(expected)) {
    throw fail('state_drift', 'Stored rollout request digest drifted')
  }
  return parsed.data
}

function assertRequestBasis(
  command: BillingRolloutPhaseRequestCommand,
  evidence: BillingRolloutPreviewEvidence,
): void {
  if (
    evidence.current.configRevision !== command.expectedConfigRevision ||
    evidence.current.configHash !== command.configBeforeHash ||
    evidence.preview.configRevision !==
      command.expectedConfigRevision + 1 ||
    evidence.preview.configHash !== command.configAfterPreviewHash ||
    evidence.preview.deploymentId !== command.deploymentId ||
    evidence.preview.commitSha !== command.commitSha ||
    canonicalRolloutJson(evidence.preview.state) !==
      canonicalRolloutJson(command.requestedState) ||
    billingRolloutDigest(evidence.preview.state) !==
      billingRolloutDigest(command.requestedState)
  ) {
    throw fail(
      'state_drift',
      'Rollout config, deployment, catalog, or preview evidence drifted',
    )
  }
}

function requestMatches(
  existing: BillingRolloutRequestView,
  prepared: PreparedBillingRolloutRequest,
): boolean {
  return existing.requestDigest === prepared.requestDigest &&
    existing.commandId === prepared.commandId &&
    existing.requesterUserId === prepared.requesterUserId
}

function approvalMatches(
  existing: BillingRolloutApprovalView,
  prepared: PreparedBillingRolloutApproval,
): boolean {
  return existing.approvalDigest === prepared.approvalDigest &&
    existing.commandId === prepared.commandId &&
    existing.requestId === prepared.requestId &&
    existing.actorUserId === prepared.actorUserId
}

function allRequiredRolesApproved(
  request: BillingRolloutRequestView,
  approvals: readonly BillingRolloutApprovalView[],
): boolean {
  const approved = new Set(
    approvals
      .filter((approval) => approval.decision === 'approved')
      .map((approval) => approval.ownerRole),
  )
  return request.requiredApprovalRoles.every((role) => approved.has(role))
}

const EXPECTED_PREVIOUS_PHASE:
Partial<Record<BillingRolloutPhaseId, BillingRolloutPhaseId>> = {
  phase_2_internal_live: 'phase_1_test_qa',
  phase_3_qualified_pilot: 'phase_2_internal_live',
  phase_4_new_users_5: 'phase_3_qualified_pilot',
  phase_5_new_users_25: 'phase_4_new_users_5',
  phase_6_new_users_100: 'phase_5_new_users_25',
  phase_7_existing_boundary: 'phase_6_new_users_100',
}

function promotionLineageShape(
  state: BillingRolloutRequestedState,
) {
  return {
    providerMode: state.providerMode,
    sellingMode: state.sellingMode,
    couponMode: state.couponMode,
    allowlistCount: state.allowlistCount,
    allowlistHash: state.allowlistHash,
    allowlistExpiresAt: state.allowlistExpiresAt,
    skuScope: state.skuScope,
    enforcementStartedAt: state.enforcementStartedAt,
    legacyGrandfatherEndsAt: state.legacyGrandfatherEndsAt,
    activeCatalogVersion: state.activeCatalogVersion,
    activeCatalogHash: state.activeCatalogHash,
    providerBindingHash: state.providerBindingHash,
    couponPolicyHash: state.couponPolicyHash,
    copyBundleHash: state.copyBundleHash,
    rolloutSeedId: state.rolloutSeedId,
    cohortContinuityHash: state.cohortContinuityHash,
    autoCouponRequired: state.autoCouponRequired,
    webhookProcessingEnabled: state.webhookProcessingEnabled,
    reconciliationEnabled: state.reconciliationEnabled,
    surfaces: state.surfaces,
  }
}

function assertPromotionLineage(
  next: BillingRolloutPhaseRequestCommand,
  previous: BillingRolloutPhaseRequestCommand | undefined,
): void {
  const expectedPrevious = EXPECTED_PREVIOUS_PHASE[next.phaseId]
  if (!expectedPrevious) return
  if (!previous || previous.phaseId !== expectedPrevious) {
    throw fail(
      'lineage_invalid',
      `Rollout phase ${next.phaseId} requires ${expectedPrevious}`,
    )
  }
  if (
    next.phaseId === 'phase_5_new_users_25' ||
    next.phaseId === 'phase_6_new_users_100'
  ) {
    if (
      canonicalRolloutJson(promotionLineageShape(next.requestedState)) !==
      canonicalRolloutJson(
        promotionLineageShape(previous.requestedState),
      )
    ) {
      throw fail(
        'lineage_invalid',
        'Public percentage promotion may change only percentage and policy hash',
      )
    }
  }
  if (
    (
      next.phaseId === 'phase_5_new_users_25' ||
      next.phaseId === 'phase_6_new_users_100' ||
      next.phaseId === 'phase_7_existing_boundary'
    ) &&
    next.requestedState.cohortContinuityHash !==
      previous.requestedState.cohortContinuityHash
  ) {
    throw fail(
      'lineage_invalid',
      'Cohort continuity hash changed across a promotion',
    )
  }
}

function activationMatches(
  existing: BillingRolloutActivationView,
  command: BillingRolloutActivationCommand,
  actor: BillingRolloutActor,
): boolean {
  return existing.commandId === command.commandId &&
    existing.correlationId === command.correlationId &&
    existing.requestId === command.requestId &&
    existing.requestDigest === command.requestDigest &&
    existing.activatedByUserId === actor.userId.toLowerCase()
}

function stoppedStateIsSafe(
  state: BillingRolloutRequestedState,
): boolean {
  return state.providerMode === 'none' &&
    state.sellingMode === 'off' &&
    state.enforcementMode === 'off' &&
    state.couponMode === 'off' &&
    state.newUserRolloutPercent === 0 &&
    state.skuScope.length === 0 &&
    Object.values(state.surfaces).every((value) => value === false) &&
    state.webhookProcessingEnabled === true &&
    state.reconciliationEnabled === true
}

export interface BillingRolloutControlService {
  readonly request: (input: {
    readonly command: BillingRolloutPhaseRequestCommand
    readonly actor: BillingRolloutActor
    readonly now?: Date
  }) => Promise<BillingRolloutRequestView>
  readonly approve: (input: {
    readonly command: BillingRolloutApprovalCommand
    readonly actor: BillingRolloutActor
    readonly now?: Date
  }) => Promise<BillingRolloutApprovalView>
  readonly activate: (input: {
    readonly command: BillingRolloutActivationCommand
    readonly actor: BillingRolloutActor
    readonly now?: Date
  }) => Promise<BillingRolloutActivationView>
  readonly emergencyStop: (input: {
    readonly command: BillingRolloutEmergencyStopCommand
    readonly actor: BillingRolloutActor
    readonly now?: Date
  }) => Promise<BillingRolloutEmergencyStopView>
  readonly decide: (
    input: BillingRolloutDecisionInput,
  ) => Promise<BillingRolloutAuthorityDecision>
}

function buildBillingRolloutControlService<TTransaction>(
  repository: BillingRolloutControlRepository<TTransaction>,
  ports: BillingRolloutControlPorts<TTransaction>,
  readiness: BillingRolloutReadiness,
): BillingRolloutControlService {
  return Object.freeze({
    async request(
      input: Parameters<BillingRolloutControlService['request']>[0],
    ) {
      const now = input.now ?? new Date()
      let prepared: PreparedBillingRolloutRequest
      try {
        prepared = prepareBillingRolloutRequest({
          command: input.command,
          actor: input.actor,
          now,
        })
      } catch (cause) {
        throw fail(
          'invalid_request',
          cause instanceof Error
            ? cause.message
            : 'Rollout request is invalid',
          cause,
        )
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await repository.withTransaction(
          async (transaction) => {
            await ports.authorizeCurrentActor({
              actor: input.actor,
              action: 'request',
              freshAuthenticationRequired: true,
            }, transaction)
            const existing = await repository.findRequestByCommandId(
              prepared.commandId,
              transaction,
            )
            if (existing) {
              if (!requestMatches(existing, prepared)) {
                throw fail(
                  'conflict',
                  'Rollout command ID was reused with different evidence',
                )
              }
              return existing
            }
            const authority = await repository.loadAuthority(transaction)
            if (
              authority.revision !== prepared.expectedAuthorityRevision ||
              authority.currentActivationSequence !==
                prepared.expectedCurrentActivationSequence
            ) {
              throw fail('conflict', 'Rollout authority changed concurrently')
            }
            const open = await repository.findOpenRequest(transaction)
            if (open) {
              if (attempt === 0 && now >= open.expiresAt) {
                const expired =
                  await repository.compareAndSetRequestStatus({
                    requestId: open.requestId,
                    expectedStatus: open.status,
                    expectedRevision: open.revision,
                    nextStatus: 'expired',
                  }, transaction)
                if (!expired) {
                  throw fail('conflict', 'Open rollout request changed')
                }
                return null
              }
              throw fail(
                'conflict',
                'Another rollout request is still open',
              )
            }
            const evidence = await ports.previewRequest(
              input.command,
              transaction,
            )
            assertRequestBasis(input.command, evidence)
            await repository.insertRequest(prepared, transaction)
            return prepared
          },
        )
        if (result) return result
      }
      throw fail('conflict', 'Expired rollout request was not released')
    },

    async approve(
      input: Parameters<BillingRolloutControlService['approve']>[0],
    ) {
      const now = input.now ?? new Date()
      const parsed = input.command
      return repository.withTransaction(async (transaction) => {
        const request = await repository.findRequestById(
          parsed.requestId,
          transaction,
        )
        if (!request) {
          throw fail('not_found', 'Rollout request was not found')
        }
        if (
          request.status !== 'pending_approval' &&
          request.status !== 'approved'
        ) {
          throw fail(
            'conflict',
            'Rollout request no longer accepts approvals',
          )
        }
        await ports.authorizeCurrentActor({
          actor: input.actor,
          action: 'approve',
          ownerRole: parsed.ownerRole,
          requestId: request.requestId,
          freshAuthenticationRequired: true,
        }, transaction)
        const existing = await repository.findApprovalByCommandId(
          parsed.commandId,
          transaction,
        )
        const approvals = await repository.listApprovals(
          request.requestId,
          transaction,
        )
        let prepared: PreparedBillingRolloutApproval
        try {
          prepared = prepareBillingRolloutApproval({
            request: pendingPreparedRequest(request),
            existing: approvalEvidence(approvals),
            command: parsed,
            actor: input.actor,
            now,
          })
        } catch (cause) {
          if (
            existing &&
            existing.commandId === parsed.commandId
          ) {
            const replayDigest = billingRolloutDigest({
              domain: parsed.schemaVersion,
              command: parsed,
              actorUserId: input.actor.userId.toLowerCase(),
              actorCmsRole: input.actor.cmsRole,
            })
            if (existing.approvalDigest === replayDigest) {
              const reconciledStatus =
                now >= request.expiresAt
                  ? 'expired'
                  : approvals.some((item) => item.decision === 'rejected')
                    ? 'rejected'
                    : allRequiredRolesApproved(request, approvals)
                      ? 'approved'
                      : undefined
              if (
                reconciledStatus &&
                request.status !== reconciledStatus
              ) {
                const changed =
                  await repository.compareAndSetRequestStatus({
                    requestId: request.requestId,
                    expectedStatus: request.status,
                    expectedRevision: request.revision,
                    nextStatus: reconciledStatus,
                  }, transaction)
                if (!changed) {
                  throw fail('conflict', 'Rollout request changed')
                }
              }
              return existing
            }
          }
          throw fail(
            'invalid_request',
            cause instanceof Error
              ? cause.message
              : 'Rollout approval is invalid',
            cause,
          )
        }
        if (existing) {
          if (!approvalMatches(existing, prepared)) {
            throw fail(
              'conflict',
              'Approval command ID was reused with different evidence',
            )
          }
          return existing
        }
        await repository.insertApproval(prepared, transaction)
        const combined = [...approvals, prepared]
        const nextStatus =
          prepared.decision === 'rejected'
            ? 'rejected'
            : allRequiredRolesApproved(request, combined)
              ? 'approved'
              : 'pending_approval'
        const changed = await repository.compareAndSetRequestStatus({
          requestId: request.requestId,
          expectedStatus: request.status,
          expectedRevision: request.revision,
          nextStatus,
        }, transaction)
        if (!changed) {
          throw fail(
            'conflict',
            'Rollout request changed while recording approval',
          )
        }
        return prepared
      })
    },

    async activate(
      input: Parameters<BillingRolloutControlService['activate']>[0],
    ) {
      if (!readiness.activation) {
        throw fail(
          'activation_disabled',
          'Billing rollout activation is not executable',
        )
      }
      const now = input.now ?? new Date()
      const command = BillingRolloutActivationCommandSchema.parse(
        input.command,
      )
      return repository.withTransaction(async (transaction) => {
        await ports.authorizeCurrentActor({
          actor: input.actor,
          action: 'activate',
          requestId: command.requestId,
          freshAuthenticationRequired: true,
        }, transaction)
        const replay = await repository.findActivationByCommandId(
          command.commandId,
          transaction,
        )
        if (replay) {
          if (!activationMatches(replay, command, input.actor)) {
            throw fail(
              'conflict',
              'Activation command ID was reused with different evidence',
            )
          }
          return replay
        }
        const [authority, request] = await Promise.all([
          repository.loadAuthority(transaction),
          repository.findRequestById(command.requestId, transaction),
        ])
        if (!request) {
          throw fail('not_found', 'Rollout request was not found')
        }
        if (
          command.requestDigest !== request.requestDigest ||
          command.expectedAuthorityRevision !== authority.revision ||
          request.expectedAuthorityRevision !== authority.revision ||
          request.expectedCurrentActivationSequence !==
            authority.currentActivationSequence
        ) {
          throw fail(
            'conflict',
            'Activation authority or request digest changed',
          )
        }
        if (request.status !== 'approved') {
          throw fail(
            'approval_incomplete',
            'Rollout request is not fully approved',
          )
        }
        const expectedConfirmation =
          `ACTIVATE BILLING ROLLOUT ${request.phaseId} ` +
          request.requestDigest
        if (command.confirmation !== expectedConfirmation) {
          throw fail(
            'invalid_request',
            'Exact rollout activation confirmation is required',
          )
        }
        const requestCommand = parsePersistedRequest(request)
        const approvals = await repository.listApprovals(
          request.requestId,
          transaction,
        )
        try {
          assertBillingRolloutActivationApproved({
            request: pendingPreparedRequest(request),
            approvals: approvalEvidence(approvals),
            now,
          })
        } catch (cause) {
          throw fail(
            'approval_incomplete',
            cause instanceof Error
              ? cause.message
              : 'Rollout approvals are incomplete',
            cause,
          )
        }
        const actorUserId = input.actor.userId.toLowerCase()
        if (
          actorUserId === request.requesterUserId ||
          approvals.some(
            (approval) => approval.actorUserId === actorUserId,
          )
        ) {
          throw fail(
            'not_authorized',
            'Rollout executor must be independent of maker and approvers',
          )
        }
        let previousRequest:
          BillingRolloutPhaseRequestCommand | undefined
        if (authority.lastActivationId) {
          const previousActivation =
            await repository.findActivationById(
              authority.lastActivationId,
              transaction,
            )
          if (!previousActivation) {
            throw fail(
              'state_drift',
              'Previous activation evidence is missing',
            )
          }
          const previousRecord = await repository.findRequestById(
            previousActivation.requestId,
            transaction,
          )
          if (!previousRecord) {
            throw fail(
              'state_drift',
              'Previous rollout request evidence is missing',
            )
          }
          previousRequest = parsePersistedRequest(previousRecord)
        }
        assertPromotionLineage(requestCommand, previousRequest)

        const basis = await ports.observeActivationBasis(
          requestCommand,
          transaction,
        )
        assertRequestBasis(requestCommand, basis)
        const after = await ports.applyRequestedState(
          requestCommand,
          transaction,
        )
        if (
          canonicalRolloutJson(after) !==
            canonicalRolloutJson(basis.preview) ||
          !after.state.webhookProcessingEnabled ||
          !after.state.reconciliationEnabled
        ) {
          throw fail(
            'recovery_not_preserved',
            'Activation result did not match preview or recovery lanes',
          )
        }
        const sequence = authority.currentActivationSequence + 1
        const authorityRevision = authority.revision + 1
        const activationId = billingRolloutDigest({
          domain: BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
          command,
          sequence,
          authorityRevision,
          stopEpoch: authority.stopEpoch,
          requestDigest: request.requestDigest,
          requestedStateHash: request.requestedStateHash,
          configBeforeHash: request.configBeforeHash,
          configAfterHash: after.configHash,
          configRevision: after.configRevision,
          actorUserId,
          activatedAt: now,
        })
        const activation: BillingRolloutActivationView =
          Object.freeze({
            schemaVersion:
              BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
            activationId,
            commandId: command.commandId,
            correlationId: command.correlationId,
            sequence,
            authorityRevision,
            stopEpoch: authority.stopEpoch,
            kind: 'activated',
            phaseId: request.phaseId,
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            requestedStateHash: request.requestedStateHash,
            configBeforeHash: request.configBeforeHash,
            configAfterHash: after.configHash,
            configRevision: after.configRevision,
            deploymentId: after.deploymentId,
            commitSha: after.commitSha,
            activeCatalogVersion:
              after.state.activeCatalogVersion,
            activeCatalogHash: after.state.activeCatalogHash,
            providerBindingHash:
              after.state.providerBindingHash,
            couponPolicyHash: after.state.couponPolicyHash,
            copyBundleHash: after.state.copyBundleHash,
            rolloutPolicyHash: after.state.rolloutPolicyHash,
            cohortOrAllowlistHash:
              requestCommand.cohortOrAllowlistHash,
            cohortContinuityHash:
              after.state.cohortContinuityHash,
            recoveryPreserved: true,
            activatedByUserId: actorUserId,
            activatedAt: new Date(now),
          })
        await repository.insertActivation(activation, transaction)
        const authorityChanged =
          await repository.compareAndSetAuthorityActive({
            expected: authority,
            activation,
            actorUserId,
          }, transaction)
        const requestChanged =
          await repository.compareAndSetRequestStatus({
            requestId: request.requestId,
            expectedStatus: 'approved',
            expectedRevision: request.revision,
            nextStatus: 'activated',
          }, transaction)
        if (!authorityChanged || !requestChanged) {
          throw fail(
            'conflict',
            'Rollout authority changed during activation',
          )
        }
        return activation
      })
    },

    async emergencyStop(
      input: Parameters<
        BillingRolloutControlService['emergencyStop']
      >[0],
    ) {
      if (!readiness.emergencyStop) {
        throw fail(
          'stop_disabled',
          'Billing rollout emergency stop is not executable',
        )
      }
      const now = input.now ?? new Date()
      const command = BillingRolloutEmergencyStopCommandSchema.parse(
        input.command,
      )
      if (
        command.confirmation !==
          `EMERGENCY STOP BILLING ${command.expectedActiveActivationId}`
      ) {
        throw fail(
          'invalid_request',
          'Exact emergency-stop confirmation is required',
        )
      }
      return repository.withTransaction(async (transaction) => {
        await ports.authorizeCurrentActor({
          actor: input.actor,
          action: 'emergency_stop',
          freshAuthenticationRequired: true,
        }, transaction)
        const replay =
          await repository.findEmergencyStopByCommandId(
            command.commandId,
            transaction,
          )
        if (replay) {
          if (
            replay.previousActivationId !==
              command.expectedActiveActivationId ||
            replay.stoppedByUserId !==
              input.actor.userId.toLowerCase()
          ) {
            throw fail(
              'conflict',
              'Emergency-stop command ID was reused',
            )
          }
          return replay
        }
        const authority = await repository.loadAuthority(transaction)
        if (
          authority.state !== 'active' ||
          authority.revision !== command.expectedAuthorityRevision ||
          authority.activeActivationId !==
            command.expectedActiveActivationId
        ) {
          throw fail(
            'conflict',
            'Active rollout authority changed before stop',
          )
        }
        const before = await ports.observeDecisionState(transaction)
        const after = await ports.applyEmergencyStop(
          command,
          transaction,
        )
        if (
          !stoppedStateIsSafe(after.state) ||
          after.configRevision !== before.configRevision + 1
        ) {
          throw fail(
            'recovery_not_preserved',
            'Emergency stop did not preserve every recovery lane',
          )
        }
        const stoppedByUserId = input.actor.userId.toLowerCase()
        const stopEpoch = authority.stopEpoch + 1
        const authorityRevision = authority.revision + 1
        const stopId = billingRolloutDigest({
          domain: BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
          command,
          stopEpoch,
          authorityRevision,
          configBeforeHash: before.configHash,
          configAfterHash: after.configHash,
          stoppedByUserId,
          stoppedAt: now,
        })
        const stop: BillingRolloutEmergencyStopView =
          Object.freeze({
            schemaVersion:
              BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
            stopId,
            commandId: command.commandId,
            correlationId: command.correlationId,
            stopEpoch,
            authorityRevision,
            previousActivationId:
              command.expectedActiveActivationId,
            previousActivationSequence:
              authority.currentActivationSequence,
            incidentReference: command.incidentReference,
            reason: command.reason,
            configBeforeHash: before.configHash,
            configAfterHash: after.configHash,
            webhookProcessingPreserved: true,
            reconciliationPreserved: true,
            stoppedByUserId,
            stoppedAt: new Date(now),
          })
        await repository.insertEmergencyStop(stop, transaction)
        const changed =
          await repository.compareAndSetAuthorityStopped({
            expected: authority,
            stop,
            actorUserId: stoppedByUserId,
          }, transaction)
        if (!changed) {
          throw fail(
            'conflict',
            'Rollout authority changed during emergency stop',
          )
        }
        return stop
      })
    },

    async decide(
      input: Parameters<BillingRolloutControlService['decide']>[0],
    ) {
      if (!readiness.decisionConsumption) {
        return evaluateBillingRolloutAuthority({
          executionReady: false,
          currentConfigRevision: 0,
          currentConfigHash: '0'.repeat(64),
          currentCatalogVersion: '',
          currentCatalogHash: '0'.repeat(64),
          currentRolloutPolicyHash: '0'.repeat(64),
          currentAllowlistSubjectHashes: [],
          userId: input.userId,
          userCreatedAt: input.userCreatedAt,
          buyerState: input.buyerState,
          now: input.now,
        })
      }
      return repository.withTransaction(async (transaction) => {
        const authority = await repository.loadAuthority(transaction)
        if (
          authority.state !== 'active' ||
          !authority.activeActivationId
        ) {
          return evaluateBillingRolloutAuthority({
            executionReady: true,
            currentConfigRevision: 0,
            currentConfigHash: '0'.repeat(64),
            currentCatalogVersion: '',
            currentCatalogHash: '0'.repeat(64),
            currentRolloutPolicyHash: '0'.repeat(64),
            currentAllowlistSubjectHashes: [],
            userId: input.userId,
            userCreatedAt: input.userCreatedAt,
            buyerState: input.buyerState,
            now: input.now,
          })
        }
        const activation = await repository.findActivationById(
          authority.activeActivationId,
          transaction,
        )
        if (!activation) {
          throw fail(
            'state_drift',
            'Active rollout activation evidence is missing',
          )
        }
        const request = await repository.findRequestById(
          activation.requestId,
          transaction,
        )
        if (!request) {
          throw fail(
            'state_drift',
            'Active rollout request evidence is missing',
          )
        }
        const command = parsePersistedRequest(request)
        const snapshot = await ports.observeDecisionState(transaction)
        return evaluateBillingRolloutAuthority({
          executionReady: true,
          activation: {
            ...activation,
            authorityRevision: authority.revision,
            stopEpoch: authority.stopEpoch,
          },
          request: command,
          currentConfigRevision: snapshot.configRevision,
          currentConfigHash: snapshot.configHash,
          currentCatalogVersion:
            snapshot.state.activeCatalogVersion,
          currentCatalogHash: snapshot.state.activeCatalogHash,
          currentRolloutPolicyHash:
            snapshot.state.rolloutPolicyHash,
          currentAllowlistSubjectHashes:
            snapshot.allowlistSubjectHashes,
          userId: input.userId,
          userCreatedAt: input.userCreatedAt,
          buyerState: input.buyerState,
          now: input.now,
          cohortSecretBase64: ports.loadAuthoritySecretBase64(),
        })
      })
    },
  })
}

export function createBillingRolloutControlService<TTransaction>(
  repository: BillingRolloutControlRepository<TTransaction>,
  ports: BillingRolloutControlPorts<TTransaction>,
): BillingRolloutControlService {
  return buildBillingRolloutControlService(repository, ports, {
    activation: BILLING_ROLLOUT_ACTIVATION_EXECUTION_READY,
    emergencyStop:
      BILLING_ROLLOUT_EMERGENCY_STOP_EXECUTION_READY,
    decisionConsumption:
      BILLING_ROLLOUT_DECISION_CONSUMPTION_READY,
  })
}

export function createBillingRolloutControlServiceForTest<
  TTransaction,
>(
  repository: BillingRolloutControlRepository<TTransaction>,
  ports: BillingRolloutControlPorts<TTransaction>,
  readiness: BillingRolloutReadiness,
): BillingRolloutControlService {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Test rollout control is available only in tests')
  }
  return buildBillingRolloutControlService(
    repository,
    ports,
    readiness,
  )
}
