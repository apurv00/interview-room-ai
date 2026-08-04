import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
  BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION,
  BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
  BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION,
  BILLING_ROLLOUT_QUERY_IDS,
  billingRolloutAllowlistHash,
  billingRolloutCohortContinuityHash,
  billingRolloutDigest,
  billingRolloutRequestedPolicyHash,
  billingRolloutSubjectHash,
  createBillingRolloutControlService,
  createBillingRolloutControlServiceForTest,
  type BillingRolloutActivationCommand,
  type BillingRolloutActivationView,
  type BillingRolloutActorAuthorizationInput,
  type BillingRolloutApprovalCommand,
  type BillingRolloutApprovalView,
  type BillingRolloutAuthorityView,
  type BillingRolloutControlPorts,
  type BillingRolloutControlRepository,
  type BillingRolloutEmergencyStopCommand,
  type BillingRolloutEmergencyStopView,
  type BillingRolloutPhaseId,
  type BillingRolloutPhaseRequestCommand,
  type BillingRolloutRequestView,
  type BillingRolloutRequestedState,
  type BillingRolloutRuntimeSnapshot,
} from '..'

const REQUESTER = '64c000000000000000000001'
const PRODUCT_APPROVER = '64c000000000000000000002'
const PAYMENT_APPROVER = '64c000000000000000000003'
const SECURITY_APPROVER = '64c000000000000000000004'
const EXECUTOR = '64c000000000000000000005'
const QA_USER = '64c000000000000000000006'
const DELETION_USER = '64c000000000000000000007'
const NOW = new Date('2026-08-02T10:00:00.000Z')
const SECRET = Buffer.alloc(32, 9).toString('base64')
const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const DIGEST_C = 'c'.repeat(64)
const DIGEST_D = 'd'.repeat(64)
const DIGEST_E = 'e'.repeat(64)
const REVIEWER = 'f'.repeat(64)

function sealState(
  input: BillingRolloutRequestedState,
): BillingRolloutRequestedState {
  const state = structuredClone(input)
  state.cohortContinuityHash =
    billingRolloutCohortContinuityHash(state)
  state.rolloutPolicyHash =
    billingRolloutRequestedPolicyHash(state)
  return state
}

interface MemoryState {
  authority: BillingRolloutAuthorityView
  requests: Map<string, BillingRolloutRequestView>
  approvals: Map<string, BillingRolloutApprovalView>
  activations: Map<string, BillingRolloutActivationView>
  stops: Map<string, BillingRolloutEmergencyStopView>
}

interface MemoryTransaction {
  state: MemoryState
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function memoryRepository(initial?: Partial<MemoryState>) {
  let state: MemoryState = {
    authority: {
      revision: 0,
      currentActivationSequence: 0,
      stopEpoch: 0,
      state: 'inert',
    },
    requests: new Map(),
    approvals: new Map(),
    activations: new Map(),
    stops: new Map(),
    ...initial,
  }
  const transactionCount = vi.fn()
  const repository: BillingRolloutControlRepository<MemoryTransaction> = {
    async withTransaction(work) {
      transactionCount()
      const transaction = { state: clone(state) }
      const result = await work(transaction)
      state = transaction.state
      return clone(result)
    },
    async loadAuthority(transaction) {
      return clone(transaction.state.authority)
    },
    async findRequestByCommandId(commandId, transaction) {
      return clone(
        [...transaction.state.requests.values()].find(
          (request) => request.commandId === commandId,
        ) ?? null,
      )
    },
    async findRequestById(requestId, transaction) {
      return clone(
        transaction.state.requests.get(requestId) ?? null,
      )
    },
    async findOpenRequest(transaction) {
      return clone(
        [...transaction.state.requests.values()].find(
          (request) =>
            request.status === 'pending_approval' ||
            request.status === 'approved',
        ) ?? null,
      )
    },
    async insertRequest(request, transaction) {
      transaction.state.requests.set(
        request.requestId,
        clone(request),
      )
    },
    async compareAndSetRequestStatus(input, transaction) {
      const request = transaction.state.requests.get(input.requestId)
      if (
        !request ||
        request.status !== input.expectedStatus ||
        request.revision !== input.expectedRevision
      ) return false
      transaction.state.requests.set(input.requestId, {
        ...request,
        status: input.nextStatus,
        revision: request.revision + 1,
      })
      return true
    },
    async findApprovalByCommandId(commandId, transaction) {
      return clone(
        [...transaction.state.approvals.values()].find(
          (approval) => approval.commandId === commandId,
        ) ?? null,
      )
    },
    async listApprovals(requestId, transaction) {
      return clone(
        [...transaction.state.approvals.values()]
          .filter((approval) => approval.requestId === requestId)
          .sort((left, right) =>
            left.ownerRole.localeCompare(right.ownerRole)),
      )
    },
    async insertApproval(approval, transaction) {
      transaction.state.approvals.set(
        approval.approvalId,
        clone(approval),
      )
    },
    async findActivationByCommandId(commandId, transaction) {
      return clone(
        [...transaction.state.activations.values()].find(
          (activation) => activation.commandId === commandId,
        ) ?? null,
      )
    },
    async findActivationById(activationId, transaction) {
      return clone(
        transaction.state.activations.get(activationId) ?? null,
      )
    },
    async insertActivation(activation, transaction) {
      transaction.state.activations.set(
        activation.activationId,
        clone(activation),
      )
    },
    async compareAndSetAuthorityActive(input, transaction) {
      if (
        JSON.stringify(transaction.state.authority) !==
          JSON.stringify(input.expected)
      ) return false
      transaction.state.authority = {
        revision: input.activation.authorityRevision,
        currentActivationSequence: input.activation.sequence,
        activeActivationId: input.activation.activationId,
        lastActivationId: input.activation.activationId,
        stopEpoch: input.activation.stopEpoch,
        state: 'active',
      }
      return true
    },
    async findEmergencyStopByCommandId(commandId, transaction) {
      return clone(
        [...transaction.state.stops.values()].find(
          (stop) => stop.commandId === commandId,
        ) ?? null,
      )
    },
    async insertEmergencyStop(stop, transaction) {
      transaction.state.stops.set(stop.stopId, clone(stop))
    },
    async compareAndSetAuthorityStopped(input, transaction) {
      if (
        JSON.stringify(transaction.state.authority) !==
          JSON.stringify(input.expected)
      ) return false
      transaction.state.authority = {
        revision: input.stop.authorityRevision,
        currentActivationSequence:
          input.stop.previousActivationSequence,
        lastActivationId: input.stop.previousActivationId,
        stopEpoch: input.stop.stopEpoch,
        state: 'stopped',
      }
      return true
    },
  }
  return {
    repository,
    transactionCount,
    readState: () => clone(state),
  }
}

function requestedState(
  phaseId: BillingRolloutPhaseId = 'phase_1_test_qa',
): BillingRolloutRequestedState {
  const allSkus = [
    'additional_interview',
    'plus_subscription',
    'premium_resume_unlock',
    'pro_subscription',
  ] as const
  const common = {
    activeCatalogVersion: 'catalog-2026-08-v1',
    activeCatalogHash: DIGEST_A,
    providerBindingHash: DIGEST_B,
    couponPolicyHash: DIGEST_C,
    copyBundleHash: DIGEST_D,
    rolloutSeedId: 'consumer-rollout-2026-08',
    rolloutPolicyHash: '0'.repeat(64),
    cohortContinuityHash: '0'.repeat(64),
    autoCouponRequired: true as const,
    webhookProcessingEnabled: true,
    reconciliationEnabled: true,
  }
  if (
    phaseId === 'phase_1_test_qa' ||
    phaseId === 'phase_2_internal_live'
  ) {
    return sealState({
      ...common,
      providerMode:
        phaseId === 'phase_1_test_qa' ? 'test' : 'live',
      sellingMode: 'qa',
      enforcementMode: 'off',
      couponMode: 'qa',
      allowlistCount: 1,
      allowlistHash: billingRolloutAllowlistHash({
        userIds: [QA_USER],
        authoritySecretBase64: SECRET,
      }),
      allowlistExpiresAt: '2026-08-02T11:00:00.000Z',
      skuScope:
        phaseId === 'phase_2_internal_live'
          ? ['premium_resume_unlock']
          : [...allSkus],
      newUserRolloutPercent: 0,
      enforcementStartedAt: null,
      legacyGrandfatherEndsAt: null,
      surfaces: {
        selling: true,
        enforcement: false,
        copy: true,
        analytics: true,
        communications: false,
      },
    })
  }
  throw new Error(`Fixture does not implement ${phaseId}`)
}

function requestCommand(
  phaseId: BillingRolloutPhaseId = 'phase_1_test_qa',
): BillingRolloutPhaseRequestCommand {
  const state = requestedState(phaseId)
  return {
    schemaVersion: BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION,
    commandId: `request-${phaseId}`,
    correlationId: `correlation-${phaseId}`,
    phaseId,
    expectedAuthorityRevision: 0,
    expectedCurrentActivationSequence: 0,
    expectedConfigRevision: 4,
    configBeforeHash: DIGEST_C,
    configAfterPreviewHash: DIGEST_D,
    requestedState: state,
    deploymentId: 'preview-deployment-123',
    commitSha: 'a1b2c3d4e5f6a7b8',
    cohortOrAllowlistHash: state.allowlistHash,
    evidence: [...BILLING_ROLLOUT_QUERY_IDS]
      .sort()
      .map((queryId, index) => ({
        queryId,
        artifactHash: index % 2 === 0 ? DIGEST_A : DIGEST_E,
        resultStatus: 'pass' as const,
        phaseId,
        environment: 'staging' as const,
        providerMode: state.providerMode,
        deploymentId: 'preview-deployment-123',
        commitSha: 'a1b2c3d4e5f6a7b8',
        catalogVersion: state.activeCatalogVersion,
        catalogHash: state.activeCatalogHash,
        configSnapshotHash: DIGEST_D,
        allowlistOrCohortHash: state.allowlistHash,
        windowStartedAt: '2026-08-02T08:00:00.000Z',
        windowEndedAt: '2026-08-02T09:00:00.000Z',
        generatedAt: '2026-08-02T09:05:00.000Z',
        reviewedByHandles: [REVIEWER],
      })),
    externalReferences: {
      legalApprovalRef: 'legal-approval-2026-08',
      financeApprovalRef: 'finance-approval-2026-08',
      securityApprovalRef: 'security-approval-2026-08',
      supportCoverageRef: 'support-coverage-2026-08',
      incidentChannelRef: 'incident-channel-billing',
      dashboardWindowRef: 'dashboard-window-2026-08',
    },
    entryWindowUtc: {
      notBefore: '2026-08-02T09:30:00.000Z',
      expiresAt: '2026-08-02T11:00:00.000Z',
    },
    openIncidentCount: 0,
    openP0P1IncidentCount: 0,
    openSupportCasesBySeverity: { p0: 0, p1: 0, p2: 0, p3: 0 },
    reason:
      'All exact evidence passed for the bounded rollout phase.',
    confirmation: `REQUEST BILLING ROLLOUT ${phaseId}`,
  }
}

function replacementRequestCommand(): BillingRolloutPhaseRequestCommand {
  const command = requestCommand('phase_2_internal_live')
  const expiresAt = '2026-08-02T12:00:00.000Z'
  const requestedState = sealState({
    ...command.requestedState,
    allowlistExpiresAt: expiresAt,
  })
  return {
    ...command,
    commandId: 'request-phase-2-replacement',
    correlationId: 'correlation-phase-2-replacement',
    requestedState,
    cohortOrAllowlistHash: requestedState.allowlistHash,
    entryWindowUtc: {
      notBefore: '2026-08-02T11:00:00.000Z',
      expiresAt,
    },
  }
}

function snapshots(
  command: BillingRolloutPhaseRequestCommand,
) {
  const currentState: BillingRolloutRequestedState = {
    ...command.requestedState,
    providerMode: 'none',
    sellingMode: 'off',
    enforcementMode: 'off',
    couponMode: 'off',
    allowlistCount: 0,
    allowlistHash: billingRolloutAllowlistHash({
      userIds: [],
      authoritySecretBase64: SECRET,
    }),
    allowlistExpiresAt: null,
    skuScope: [],
    newUserRolloutPercent: 0,
    surfaces: {
      selling: false,
      enforcement: false,
      copy: false,
      analytics: false,
      communications: false,
    },
  }
  const current: BillingRolloutRuntimeSnapshot = {
    configRevision: command.expectedConfigRevision,
    configHash: command.configBeforeHash,
    deploymentId: command.deploymentId,
    commitSha: command.commitSha,
    state: currentState,
    allowlistSubjectHashes: [],
  }
  const preview: BillingRolloutRuntimeSnapshot = {
    configRevision: command.expectedConfigRevision + 1,
    configHash: command.configAfterPreviewHash,
    deploymentId: command.deploymentId,
    commitSha: command.commitSha,
    state: command.requestedState,
    allowlistSubjectHashes:
      command.requestedState.allowlistCount > 0
        ? [billingRolloutSubjectHash({
            userId: QA_USER,
            authoritySecretBase64: SECRET,
          })]
        : [],
  }
  return { current, preview }
}

function memoryPorts(
  command: BillingRolloutPhaseRequestCommand,
  options: {
    driftPreview?: boolean
    unsafeStop?: boolean
  } = {},
) {
  let runtime = snapshots(command).current
  const authorizations:
    BillingRolloutActorAuthorizationInput[] = []
  const applyRequestedState = vi.fn(async () => {
    runtime = clone(snapshots(command).preview)
    return clone(runtime)
  })
  const applyEmergencyStop = vi.fn(
    async (): Promise<BillingRolloutRuntimeSnapshot> => {
      const state: BillingRolloutRequestedState = {
        ...runtime.state,
        providerMode: 'none',
        sellingMode: 'off',
        enforcementMode: 'off',
        couponMode: 'off',
        allowlistCount: 0,
        allowlistHash: billingRolloutAllowlistHash({
          userIds: [],
          authoritySecretBase64: SECRET,
        }),
        allowlistExpiresAt: null,
        skuScope: [],
        newUserRolloutPercent: 0,
        surfaces: {
          selling: false,
          enforcement: false,
          copy: false,
          analytics: false,
          communications: false,
        },
        webhookProcessingEnabled: true,
        reconciliationEnabled: !options.unsafeStop,
      }
      runtime = {
        ...runtime,
        configRevision: runtime.configRevision + 1,
        configHash: billingRolloutDigest({
          domain: 'stopped-config-v1',
          state,
        }),
        state,
        allowlistSubjectHashes: [],
      }
      return clone(runtime)
    },
  )
  const loadAuthoritySecretBase64 = vi.fn(() => SECRET)
  const ports: BillingRolloutControlPorts<MemoryTransaction> = {
    async authorizeCurrentActor(input) {
      authorizations.push(clone(input))
    },
    async previewRequest() {
      const result = snapshots(command)
      if (options.driftPreview) {
        result.preview = {
          ...result.preview,
          configHash: DIGEST_E,
        }
      }
      return result
    },
    async observeActivationBasis() {
      return snapshots(command)
    },
    applyRequestedState,
    applyEmergencyStop,
    async observeDecisionState() {
      return clone(runtime)
    },
    loadAuthoritySecretBase64,
  }
  return {
    ports,
    authorizations,
    applyRequestedState,
    applyEmergencyStop,
    loadAuthoritySecretBase64,
    readRuntime: () => clone(runtime),
  }
}

function approvalCommand(input: {
  request: BillingRolloutRequestView
  ownerRole: BillingRolloutApprovalCommand['ownerRole']
  actorUserId: string
}): BillingRolloutApprovalCommand {
  return {
    schemaVersion: BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION,
    commandId: `approval-${input.ownerRole}`,
    correlationId: `correlation-${input.ownerRole}`,
    requestId: input.request.requestId,
    requestDigest: input.request.requestDigest,
    ownerRole: input.ownerRole,
    decision: 'approved',
    reason:
      'I reviewed the immutable phase, deployment, catalog, and evidence.',
    confirmation:
      `APPROVE BILLING ROLLOUT ${input.request.phaseId} ` +
      input.request.requestDigest,
  }
}

async function fullyApprove(
  service: ReturnType<typeof createBillingRolloutControlServiceForTest>,
  request: BillingRolloutRequestView,
) {
  const actors = new Map([
    ['product_rollout', PRODUCT_APPROVER],
    ['payments_engineering', PAYMENT_APPROVER],
    ['security', SECURITY_APPROVER],
  ])
  for (const ownerRole of request.requiredApprovalRoles) {
    await service.approve({
      command: approvalCommand({
        request,
        ownerRole,
        actorUserId: actors.get(ownerRole)!,
      }),
      actor: {
        userId: actors.get(ownerRole)!,
        cmsRole: 'platform_admin',
      },
      now: NOW,
    })
  }
}

function activationCommand(
  request: BillingRolloutRequestView,
): BillingRolloutActivationCommand {
  return {
    schemaVersion: BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
    commandId: 'activate-phase-1',
    correlationId: 'activate-phase-1-correlation',
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    expectedAuthorityRevision: 0,
    confirmation:
      `ACTIVATE BILLING ROLLOUT ${request.phaseId} ` +
      request.requestDigest,
  }
}

describe('payment rollout control service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows audited preparation while every execution gate is dark', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command)
    const service = createBillingRolloutControlService(
      memory.repository,
      composition.ports,
    )

    const request = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })

    expect(request.status).toBe('pending_approval')
    expect(composition.authorizations).toEqual([
      expect.objectContaining({
        action: 'request',
        freshAuthenticationRequired: true,
      }),
    ])
    expect(memory.readState().authority.state).toBe('inert')
  })

  it('replays an exact request and rejects command drift', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command)
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      composition.ports,
      {
        activation: false,
        emergencyStop: false,
        decisionConsumption: false,
      },
    )
    const first = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    const replay = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    expect(replay).toEqual(first)

    await expect(service.request({
      command: {
        ...command,
        reason: 'Different but still sufficiently long rollout reason.',
      },
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects a server-observed preview hash drift atomically', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command, { driftPreview: true })
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      composition.ports,
      {
        activation: false,
        emergencyStop: false,
        decisionConsumption: false,
      },
    )

    await expect(service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })).rejects.toMatchObject({ code: 'state_drift' })
    expect(memory.readState().requests.size).toBe(0)
  })

  it('records distinct role approvals and moves the request to approved', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command)
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      composition.ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const request = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })

    await fullyApprove(service, request)

    expect(
      memory.readState().requests.get(request.requestId)?.status,
    ).toBe('approved')
    expect(memory.readState().approvals.size).toBe(3)
  })

  it('write-fences every approval before deriving the terminal status', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      memoryPorts(command).ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const request = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    const approvals = [
      ['payments_engineering', PAYMENT_APPROVER],
      ['product_rollout', PRODUCT_APPROVER],
      ['security', SECURITY_APPROVER],
    ] as const

    for (const [index, [ownerRole, userId]] of approvals.entries()) {
      await service.approve({
        command: approvalCommand({
          request,
          ownerRole,
          actorUserId: userId,
        }),
        actor: { userId, cmsRole: 'platform_admin' },
        now: NOW,
      })
      const current = memory.readState().requests.get(request.requestId)
      expect(current?.revision).toBe(index + 2)
      expect(current?.status).toBe(
        index === approvals.length - 1
          ? 'approved'
          : 'pending_approval',
      )
    }
  })

  it('reconciles complete legacy approval evidence left pending', async () => {
    const command = requestCommand()
    const source = memoryRepository()
    const sourceService = createBillingRolloutControlServiceForTest(
      source.repository,
      memoryPorts(command).ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const request = await sourceService.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    await fullyApprove(sourceService, request)
    const strandedState = source.readState()
    strandedState.requests.set(request.requestId, {
      ...strandedState.requests.get(request.requestId)!,
      status: 'pending_approval',
      revision: 1,
    })
    const stranded = memoryRepository(strandedState)
    const repairService = createBillingRolloutControlServiceForTest(
      stranded.repository,
      memoryPorts(command).ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )

    await repairService.approve({
      command: approvalCommand({
        request,
        ownerRole: 'security',
        actorUserId: SECURITY_APPROVER,
      }),
      actor: {
        userId: SECURITY_APPROVER,
        cmsRole: 'platform_admin',
      },
      now: NOW,
    })

    expect(
      stranded.readState().requests.get(request.requestId),
    ).toMatchObject({ status: 'approved', revision: 2 })
  })

  it('expires a stale pending request before opening its replacement', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const request = await createBillingRolloutControlServiceForTest(
      memory.repository,
      memoryPorts(command).ports,
      {
        activation: false,
        emergencyStop: false,
        decisionConsumption: false,
      },
    ).request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    const replacementCommand = replacementRequestCommand()
    const replacement =
      await createBillingRolloutControlServiceForTest(
        memory.repository,
        memoryPorts(replacementCommand).ports,
        {
          activation: false,
          emergencyStop: false,
          decisionConsumption: false,
        },
      ).request({
        command: replacementCommand,
        actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
        now: new Date('2026-08-02T11:01:00.000Z'),
      })

    expect(memory.readState().requests.get(request.requestId))
      .toMatchObject({ status: 'expired', revision: 2 })
    expect(replacement.status).toBe('pending_approval')
  })

  it('keeps an unexpired request in the singleton open slot', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const request = await createBillingRolloutControlServiceForTest(
      memory.repository,
      memoryPorts(command).ports,
      {
        activation: false,
        emergencyStop: false,
        decisionConsumption: false,
      },
    ).request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    const replacementCommand = replacementRequestCommand()

    await expect(createBillingRolloutControlServiceForTest(
      memory.repository,
      memoryPorts(replacementCommand).ports,
      {
        activation: false,
        emergencyStop: false,
        decisionConsumption: false,
      },
    ).request({
      command: replacementCommand,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: new Date('2026-08-02T10:30:00.000Z'),
    })).rejects.toMatchObject({ code: 'conflict' })
    expect(memory.readState().requests.get(request.requestId))
      .toMatchObject({ status: 'pending_approval', revision: 1 })
  })

  it('expires an approved but unactivated request before replacement', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      memoryPorts(command).ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const request = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    await fullyApprove(service, request)
    const replacementCommand = replacementRequestCommand()

    await createBillingRolloutControlServiceForTest(
      memory.repository,
      memoryPorts(replacementCommand).ports,
      {
        activation: false,
        emergencyStop: false,
        decisionConsumption: false,
      },
    ).request({
      command: replacementCommand,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: new Date('2026-08-02T11:01:00.000Z'),
    })

    expect(memory.readState().requests.get(request.requestId))
      .toMatchObject({ status: 'expired', revision: 5 })
  })

  it('activates only after independent approvals and exact local apply', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command)
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      composition.ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const request = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    await fullyApprove(service, request)

    const activation = await service.activate({
      command: activationCommand(request),
      actor: { userId: EXECUTOR, cmsRole: 'platform_admin' },
      now: NOW,
    })

    expect(activation).toMatchObject({
      phaseId: 'phase_1_test_qa',
      sequence: 1,
      authorityRevision: 1,
      stopEpoch: 0,
      recoveryPreserved: true,
    })
    expect(composition.applyRequestedState).toHaveBeenCalledTimes(1)
    expect(memory.readState().authority).toMatchObject({
      state: 'active',
      activeActivationId: activation.activationId,
      currentActivationSequence: 1,
    })
    expect(
      memory.readState().requests.get(request.requestId)?.status,
    ).toBe('activated')
  })

  it('keeps an explicitly disabled activation dark before transactions or state reads', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command)
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      composition.ports,
      {
        activation: false,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const beforeTransactions = memory.transactionCount.mock.calls.length

    await expect(service.activate({
      command: {
        schemaVersion: BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
        commandId: 'dark-activation',
        correlationId: 'dark-activation-correlation',
        requestId: DIGEST_A,
        requestDigest: DIGEST_A,
        expectedAuthorityRevision: 0,
        confirmation: `ACTIVATE BILLING ROLLOUT x ${DIGEST_A}`,
      },
      actor: { userId: EXECUTOR, cmsRole: 'platform_admin' },
      now: NOW,
    })).rejects.toMatchObject({ code: 'activation_disabled' })
    expect(memory.transactionCount).toHaveBeenCalledTimes(
      beforeTransactions,
    )
    expect(composition.applyRequestedState).not.toHaveBeenCalled()
  })

  it('uses one active attestation for provider mode and deletion suppression', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command)
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      composition.ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const request = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    await fullyApprove(service, request)
    await service.activate({
      command: activationCommand(request),
      actor: { userId: EXECUTOR, cmsRole: 'platform_admin' },
      now: NOW,
    })

    await expect(service.decide({
      userId: QA_USER,
      now: NOW,
    })).resolves.toMatchObject({
      enabled: true,
      providerMode: 'test',
      sellingAllowed: true,
      enforcementEnabled: false,
      skuScope: [
        'additional_interview',
        'plus_subscription',
        'premium_resume_unlock',
        'pro_subscription',
      ],
    })
    await expect(service.decide({
      userId: DELETION_USER,
      buyerState: 'deletion_pending',
      now: NOW,
    })).resolves.toMatchObject({
      reason: 'deletion_pending',
      sellingAllowed: false,
      communicationsEnabled: false,
    })
  })

  it('emergency-stops acquisition while preserving both recovery lanes', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command)
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      composition.ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const request = await service.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    await fullyApprove(service, request)
    const activation = await service.activate({
      command: activationCommand(request),
      actor: { userId: EXECUTOR, cmsRole: 'platform_admin' },
      now: NOW,
    })
    const stopCommand: BillingRolloutEmergencyStopCommand = {
      schemaVersion: BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
      commandId: 'emergency-stop-phase-1',
      correlationId: 'emergency-stop-phase-1-correlation',
      expectedAuthorityRevision: 1,
      expectedActiveActivationId: activation.activationId,
      incidentReference: 'incident-billing-2026-08-02',
      reason:
        'Contain new billing effects while continuing every recovery lane.',
      confirmation:
        `EMERGENCY STOP BILLING ${activation.activationId}`,
    }

    const stopped = await service.emergencyStop({
      command: stopCommand,
      actor: { userId: SECURITY_APPROVER, cmsRole: 'platform_admin' },
      now: NOW,
    })

    expect(stopped).toMatchObject({
      stopEpoch: 1,
      authorityRevision: 2,
      webhookProcessingPreserved: true,
      reconciliationPreserved: true,
    })
    expect(composition.readRuntime().state).toMatchObject({
      sellingMode: 'off',
      enforcementMode: 'off',
      couponMode: 'off',
      webhookProcessingEnabled: true,
      reconciliationEnabled: true,
    })
    expect(memory.readState().authority).toMatchObject({
      state: 'stopped',
      stopEpoch: 1,
    })
  })

  it('rolls back an unsafe emergency stop that disables reconciliation', async () => {
    const command = requestCommand()
    const setupMemory = memoryRepository()
    const setupPorts = memoryPorts(command)
    const setupService = createBillingRolloutControlServiceForTest(
      setupMemory.repository,
      setupPorts.ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )
    const request = await setupService.request({
      command,
      actor: { userId: REQUESTER, cmsRole: 'platform_admin' },
      now: NOW,
    })
    await fullyApprove(setupService, request)
    const activation = await setupService.activate({
      command: activationCommand(request),
      actor: { userId: EXECUTOR, cmsRole: 'platform_admin' },
      now: NOW,
    })
    const unsafePorts = memoryPorts(command, { unsafeStop: true })
    // Make the second composition observe the already-active runtime.
    await unsafePorts.ports.applyRequestedState(command, {
      state: setupMemory.readState(),
    } as unknown as MemoryTransaction)
    const unsafeService = createBillingRolloutControlServiceForTest(
      setupMemory.repository,
      unsafePorts.ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: true,
      },
    )

    await expect(unsafeService.emergencyStop({
      command: {
        schemaVersion: BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
        commandId: 'unsafe-emergency-stop',
        correlationId: 'unsafe-emergency-stop-correlation',
        expectedAuthorityRevision: 1,
        expectedActiveActivationId: activation.activationId,
        incidentReference: 'incident-unsafe-stop',
        reason:
          'This simulated stop must roll back when recovery is disabled.',
        confirmation:
          `EMERGENCY STOP BILLING ${activation.activationId}`,
      },
      actor: { userId: SECURITY_APPROVER, cmsRole: 'platform_admin' },
      now: NOW,
    })).rejects.toMatchObject({ code: 'recovery_not_preserved' })
    expect(setupMemory.readState().authority.state).toBe('active')
    expect(setupMemory.readState().stops.size).toBe(0)
  })

  it('keeps explicitly disabled decision consumption all-off without loading a secret', async () => {
    const command = requestCommand()
    const memory = memoryRepository()
    const composition = memoryPorts(command)
    composition.loadAuthoritySecretBase64.mockImplementation(() => {
      throw new Error('must not load')
    })
    const service = createBillingRolloutControlServiceForTest(
      memory.repository,
      composition.ports,
      {
        activation: true,
        emergencyStop: true,
        decisionConsumption: false,
      },
    )

    await expect(service.decide({
      userId: QA_USER,
      now: NOW,
    })).resolves.toMatchObject({
      enabled: false,
      reason: 'execution_gate_off',
      sellingAllowed: false,
    })
    expect(
      composition.loadAuthoritySecretBase64,
    ).not.toHaveBeenCalled()
  })
})
