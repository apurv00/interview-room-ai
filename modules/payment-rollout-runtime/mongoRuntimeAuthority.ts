import mongoose, { type ClientSession, type Model } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  BillingRolloutRequestedStateSchema,
  billingRolloutDigest,
  billingRolloutRequestedPolicyHash,
  billingRolloutSubjectManifestHash,
  type BillingRolloutActor,
  type BillingRolloutActorAuthorizationInput,
  type BillingRolloutControlPorts,
  type BillingRolloutPhaseRequestCommand,
  type BillingRolloutPreviewEvidence,
  type BillingRolloutRequestedState,
  type BillingRolloutRuntimeSnapshot,
} from '@/modules/payment-rollout-control'
import {
  BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION,
  BILLING_ROLLOUT_SUBJECT_MANIFEST_PURGE_SCHEMA_VERSION,
  BILLING_ROLLOUT_SUBJECT_MANIFEST_RETENTION_DAYS,
  BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION,
  PurgeBillingRolloutSubjectManifestsCommandSchema,
  billingRolloutSubjectManifestPurgeConfirmation,
  billingRolloutRuntimeProjectionHash,
  inertBillingRolloutState,
  prepareBillingRolloutSubjectManifest,
  type BillingRolloutArtifactSnapshot,
  type BillingRolloutRuntimeProjectionView,
  type BillingRolloutSubjectManifestPurgeEvidence,
  type BillingRolloutSubjectManifestView,
  type PurgeBillingRolloutSubjectManifestsCommand,
  type StageBillingRolloutSubjectManifestCommand,
} from './contracts'
import {
  BillingRolloutRuntimeProjectionModel,
  BillingRolloutSubjectManifestModel,
  type IBillingRolloutRuntimeProjection,
  type IBillingRolloutSubjectManifest,
} from './models'

interface ProjectionLean {
  readonly schemaVersion: unknown
  readonly key: unknown
  readonly configRevision: unknown
  readonly configHash: unknown
  readonly deploymentId: unknown
  readonly commitSha: unknown
  readonly state: unknown
  readonly allowlistSubjectHashes: unknown
}

interface ManifestLean {
  readonly _id: unknown
  readonly schemaVersion: unknown
  readonly manifestHash: unknown
  readonly commandId: unknown
  readonly correlationId: unknown
  readonly subjectHashes: unknown
  readonly subjectCount: unknown
  readonly expiresAt: unknown
  readonly reason: unknown
  readonly confirmation: unknown
  readonly stagedByUserId: unknown
  readonly stagedAt: unknown
}

export interface MongoBillingRolloutRuntimeAuthorityDependencies {
  readonly connect: typeof connectDB
  readonly startSession: typeof mongoose.startSession
  readonly projectionModel: Model<IBillingRolloutRuntimeProjection>
  readonly manifestModel: Model<IBillingRolloutSubjectManifest>
  readonly authorizeCurrentActor: (
    input: BillingRolloutActorAuthorizationInput,
    transaction: ClientSession,
  ) => Promise<void>
  readonly observeArtifacts: (
    input: {
      readonly requestedState: BillingRolloutRequestedState
      readonly transaction: ClientSession
    },
  ) => Promise<BillingRolloutArtifactSnapshot>
  readonly loadAuthoritySecretBase64: () => string
  readonly rolloutSeedId: string
  readonly authorizeManifestRetentionPurge: (
    input: {
      readonly actor: BillingRolloutActor
      readonly command:
        PurgeBillingRolloutSubjectManifestsCommand
      readonly commandDigest: string
    },
    transaction: ClientSession,
  ) => Promise<void>
}

export interface MongoBillingRolloutRuntimeAuthority {
  readonly ports: BillingRolloutControlPorts<ClientSession>
  readonly previewRequestedState: (input: {
    readonly requestedState: BillingRolloutRequestedState
    readonly transaction?: ClientSession
  }) => Promise<BillingRolloutPreviewEvidence>
  readonly stageSubjectManifest: (input: {
    readonly command: StageBillingRolloutSubjectManifestCommand
    readonly actor: BillingRolloutActor
    readonly now?: Date
  }) => Promise<BillingRolloutSubjectManifestView>
  readonly purgeRetainedSubjectManifests: (input: {
    readonly command:
      PurgeBillingRolloutSubjectManifestsCommand
    readonly actor: BillingRolloutActor
    readonly now?: Date
  }) => Promise<BillingRolloutSubjectManifestPurgeEvidence>
}

function exactString(
  value: unknown,
  pattern: RegExp,
  name: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid persisted ${name}`)
  }
  return value
}

function exactDate(value: unknown, name: string): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid persisted ${name}`)
  }
  return date
}

function exactSubjectHashes(
  value: unknown,
  name: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((hash) =>
      typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
    value.some(
      (hash, index) => index > 0 && value[index - 1] >= hash,
    )
  ) throw new Error(`Invalid persisted ${name}`)
  return Object.freeze([...value] as string[])
}

function projectionFromLean(
  row: ProjectionLean,
): BillingRolloutRuntimeProjectionView {
  if (
    row.schemaVersion !==
      BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION ||
    row.key !== 'singleton' ||
    !Number.isSafeInteger(row.configRevision) ||
    (row.configRevision as number) < 0
  ) throw new Error('Invalid persisted rollout projection')
  const state = BillingRolloutRequestedStateSchema.parse(row.state)
  const allowlistSubjectHashes = exactSubjectHashes(
    row.allowlistSubjectHashes,
    'projection subject hashes',
  )
  const result: BillingRolloutRuntimeProjectionView = {
    schemaVersion:
      BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION,
    persisted: true,
    configRevision: row.configRevision as number,
    configHash: exactString(
      row.configHash,
      /^[a-f0-9]{64}$/,
      'projection config hash',
    ),
    deploymentId: exactString(
      row.deploymentId,
      /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,199}$/,
      'projection deployment ID',
    ),
    commitSha: exactString(
      row.commitSha,
      /^[a-f0-9]{7,64}$/,
      'projection commit SHA',
    ),
    state,
    allowlistSubjectHashes,
  }
  if (
    billingRolloutRuntimeProjectionHash(result) !== result.configHash
  ) throw new Error('Persisted rollout projection hash drifted')
  return Object.freeze(result)
}

function manifestFromLean(
  row: ManifestLean,
): BillingRolloutSubjectManifestView {
  if (
    row.schemaVersion !==
      BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION ||
    !Number.isSafeInteger(row.subjectCount)
  ) throw new Error('Invalid persisted rollout manifest')
  const subjectHashes = exactSubjectHashes(
    row.subjectHashes,
    'manifest subject hashes',
  )
  const manifestHash = exactString(
    row.manifestHash,
    /^[a-f0-9]{64}$/,
    'manifest hash',
  )
  const confirmation = exactString(
    row.confirmation,
    /^STAGE BILLING ROLLOUT AUDIENCE [a-f0-9]{64}$/,
    'manifest confirmation',
  )
  if (
    subjectHashes.length !== row.subjectCount ||
    billingRolloutSubjectManifestHash(subjectHashes) !== manifestHash ||
    confirmation !==
      `STAGE BILLING ROLLOUT AUDIENCE ${manifestHash}`
  ) throw new Error('Persisted rollout manifest hash drifted')
  return Object.freeze({
    schemaVersion: BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION,
    manifestHash,
    commandId: exactString(
      row.commandId,
      /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,199}$/,
      'manifest command ID',
    ),
    correlationId: exactString(
      row.correlationId,
      /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,199}$/,
      'manifest correlation ID',
    ),
    subjectHashes,
    subjectCount: row.subjectCount as number,
    expiresAt: exactDate(row.expiresAt, 'manifest expiry'),
    reason: exactString(
      row.reason,
      /^[\s\S]{20,2000}$/,
      'manifest reason',
    ),
    confirmation,
    stagedByUserId: String(row.stagedByUserId).toLowerCase(),
    stagedAt: exactDate(row.stagedAt, 'manifest staging time'),
  })
}

function sameManifestCommandSemantics(
  existing: BillingRolloutSubjectManifestView,
  prepared: BillingRolloutSubjectManifestView,
): boolean {
  return existing.schemaVersion === prepared.schemaVersion &&
    existing.manifestHash === prepared.manifestHash &&
    existing.commandId === prepared.commandId &&
    existing.correlationId === prepared.correlationId &&
    existing.subjectCount === prepared.subjectCount &&
    existing.expiresAt.getTime() === prepared.expiresAt.getTime() &&
    existing.reason === prepared.reason &&
    existing.confirmation === prepared.confirmation &&
    existing.stagedByUserId === prepared.stagedByUserId &&
    existing.subjectHashes.length === prepared.subjectHashes.length &&
    existing.subjectHashes.every(
      (hash, index) => hash === prepared.subjectHashes[index],
    )
}

function manifestPurgeEvidenceHash(
  manifest: BillingRolloutSubjectManifestView,
): string {
  return billingRolloutDigest({
    domain: 'billing_rollout_subject_manifest_purge_evidence_v1',
    schemaVersion: manifest.schemaVersion,
    manifestHash: manifest.manifestHash,
    commandId: manifest.commandId,
    correlationId: manifest.correlationId,
    subjectCount: manifest.subjectCount,
    expiresAt: manifest.expiresAt.toISOString(),
    reason: manifest.reason,
    stagedAt: manifest.stagedAt.toISOString(),
  })
}

function snapshot(
  input: {
    readonly persisted: boolean
    readonly configRevision: number
    readonly deploymentId: string
    readonly commitSha: string
    readonly state: BillingRolloutRequestedState
    readonly allowlistSubjectHashes: readonly string[]
  },
): BillingRolloutRuntimeProjectionView {
  return Object.freeze({
    schemaVersion:
      BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION,
    ...input,
    configHash: billingRolloutRuntimeProjectionHash(input),
  })
}

function artifactStateMatches(
  state: BillingRolloutRequestedState,
  artifacts: BillingRolloutArtifactSnapshot,
): boolean {
  return state.activeCatalogVersion ===
      artifacts.activeCatalogVersion &&
    state.activeCatalogHash === artifacts.activeCatalogHash &&
    state.providerBindingHash === artifacts.providerBindingHash &&
    state.couponPolicyHash === artifacts.couponPolicyHash &&
    state.copyBundleHash === artifacts.copyBundleHash
}

export function createMongoBillingRolloutRuntimeAuthority(
  dependencies: Partial<
    MongoBillingRolloutRuntimeAuthorityDependencies
  > & Pick<
    MongoBillingRolloutRuntimeAuthorityDependencies,
    'authorizeCurrentActor' | 'observeArtifacts' |
    'loadAuthoritySecretBase64' | 'rolloutSeedId'
  >,
): MongoBillingRolloutRuntimeAuthority {
  const deps: MongoBillingRolloutRuntimeAuthorityDependencies = {
    connect: connectDB,
    startSession: mongoose.startSession,
    projectionModel: BillingRolloutRuntimeProjectionModel,
    manifestModel: BillingRolloutSubjectManifestModel,
    authorizeManifestRetentionPurge: async () => {
      throw new Error(
        'Manifest retention purge approval is not configured',
      )
    },
    ...dependencies,
  }

  async function loadProjection(
    transaction: ClientSession,
  ): Promise<BillingRolloutRuntimeProjectionView | null> {
    const row = await deps.projectionModel.findOne({ key: 'singleton' })
      .session(transaction)
      .lean<ProjectionLean>()
    return row ? projectionFromLean(row) : null
  }

  async function loadManifest(
    state: BillingRolloutRequestedState,
    transaction: ClientSession,
  ): Promise<readonly string[]> {
    if (state.allowlistCount === 0) {
      if (
        state.allowlistHash !==
          billingRolloutSubjectManifestHash([])
      ) throw new Error('Empty rollout audience hash is invalid')
      return Object.freeze([])
    }
    if (!state.allowlistExpiresAt) {
      throw new Error('Rollout audience manifest expiry is missing')
    }
    const row = await deps.manifestModel.findOne({
      manifestHash: state.allowlistHash,
      expiresAt: new Date(state.allowlistExpiresAt),
    }).session(transaction).lean<ManifestLean>()
    if (!row) throw new Error('Rollout audience manifest is missing')
    const manifest = manifestFromLean(row)
    if (
      manifest.subjectCount !== state.allowlistCount ||
      manifest.expiresAt.toISOString() !== state.allowlistExpiresAt
    ) throw new Error('Rollout audience manifest does not match state')
    return manifest.subjectHashes
  }

  async function previewInTransaction(
    requestedStateInput: BillingRolloutRequestedState,
    transaction: ClientSession,
  ): Promise<BillingRolloutPreviewEvidence> {
    const requestedState =
      BillingRolloutRequestedStateSchema.parse(requestedStateInput)
    const artifacts = await deps.observeArtifacts({
      requestedState,
      transaction,
    })
    if (
      !artifactStateMatches(requestedState, artifacts) ||
      billingRolloutRequestedPolicyHash(requestedState) !==
        requestedState.rolloutPolicyHash
    ) throw new Error('Requested rollout artifacts drifted')
    const existing = await loadProjection(transaction)
    const current = existing ?? snapshot({
      persisted: false,
      configRevision: 0,
      deploymentId: artifacts.deploymentId,
      commitSha: artifacts.commitSha,
      state: inertBillingRolloutState({
        artifacts,
        rolloutSeedId: deps.rolloutSeedId,
      }),
      allowlistSubjectHashes: [],
    })
    const allowlistSubjectHashes = await loadManifest(
      requestedState,
      transaction,
    )
    const preview = snapshot({
      persisted: false,
      configRevision: current.configRevision + 1,
      deploymentId: artifacts.deploymentId,
      commitSha: artifacts.commitSha,
      state: requestedState,
      allowlistSubjectHashes,
    })
    return Object.freeze({ current, preview })
  }

  async function withOwnedSession<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    await deps.connect()
    const session = await deps.startSession()
    try {
      let result: T | undefined
      await session.withTransaction(async () => {
        result = await work(session)
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      })
      if (result === undefined) {
        throw new Error('Rollout runtime transaction returned no result')
      }
      return result
    } finally {
      await session.endSession()
    }
  }

  const ports: BillingRolloutControlPorts<ClientSession> = {
    authorizeCurrentActor: deps.authorizeCurrentActor,
    previewRequest: (command, transaction) =>
      previewInTransaction(command.requestedState, transaction),
    observeActivationBasis: (command, transaction) =>
      previewInTransaction(command.requestedState, transaction),
    async applyRequestedState(command, transaction) {
      const evidence = await previewInTransaction(
        command.requestedState,
        transaction,
      )
      if (
        evidence.current.configRevision !==
          command.expectedConfigRevision ||
        evidence.current.configHash !== command.configBeforeHash ||
        evidence.preview.configHash !== command.configAfterPreviewHash
      ) throw new Error('Rollout runtime projection changed')
      const document = {
        schemaVersion:
          BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION,
        key: 'singleton' as const,
        configRevision: evidence.preview.configRevision,
        configHash: evidence.preview.configHash,
        deploymentId: evidence.preview.deploymentId,
        commitSha: evidence.preview.commitSha,
        state: evidence.preview.state,
        allowlistSubjectHashes: [
          ...evidence.preview.allowlistSubjectHashes,
        ],
      }
      if (!('persisted' in evidence.current) ||
          !evidence.current.persisted) {
        await deps.projectionModel.create([document], {
          session: transaction,
        })
      } else {
        const updated = await deps.projectionModel.findOneAndUpdate(
          {
            key: 'singleton',
            configRevision: evidence.current.configRevision,
            configHash: evidence.current.configHash,
          },
          { $set: document },
          { new: true, runValidators: true, session: transaction },
        ).lean<ProjectionLean>()
        if (!updated) {
          throw new Error('Rollout runtime projection CAS failed')
        }
      }
      return evidence.preview
    },
    async applyEmergencyStop(_command, transaction) {
      const current = await loadProjection(transaction)
      if (!current) throw new Error('Active rollout projection is missing')
      const state: BillingRolloutRequestedState = {
        ...current.state,
        providerMode: 'none',
        sellingMode: 'off',
        enforcementMode: 'off',
        couponMode: 'off',
        allowlistCount: 0,
        allowlistHash: billingRolloutSubjectManifestHash([]),
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
        reconciliationEnabled: true,
      }
      state.rolloutPolicyHash =
        billingRolloutRequestedPolicyHash(state)
      const stopped = snapshot({
        persisted: true,
        configRevision: current.configRevision + 1,
        deploymentId: current.deploymentId,
        commitSha: current.commitSha,
        state,
        allowlistSubjectHashes: [],
      })
      const updated = await deps.projectionModel.findOneAndUpdate(
        {
          key: 'singleton',
          configRevision: current.configRevision,
          configHash: current.configHash,
        },
        {
          $set: {
            schemaVersion:
              BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION,
            configRevision: stopped.configRevision,
            configHash: stopped.configHash,
            deploymentId: stopped.deploymentId,
            commitSha: stopped.commitSha,
            state: stopped.state,
            allowlistSubjectHashes: [],
          },
        },
        { new: true, runValidators: true, session: transaction },
      ).lean<ProjectionLean>()
      if (!updated) throw new Error('Emergency-stop projection CAS failed')
      return stopped
    },
    async observeDecisionState(transaction) {
      const current = await loadProjection(transaction)
      if (!current) throw new Error('Active rollout projection is missing')
      return current
    },
    loadAuthoritySecretBase64: deps.loadAuthoritySecretBase64,
  }

  const authority: MongoBillingRolloutRuntimeAuthority = {
    ports,
    async previewRequestedState(
      input: Parameters<
        MongoBillingRolloutRuntimeAuthority[
          'previewRequestedState'
        ]
      >[0],
    ) {
      if (input.transaction) {
        return previewInTransaction(
          input.requestedState,
          input.transaction,
        )
      }
      return withOwnedSession((transaction) =>
        previewInTransaction(input.requestedState, transaction))
    },
    async stageSubjectManifest(
      input: Parameters<
        MongoBillingRolloutRuntimeAuthority[
          'stageSubjectManifest'
        ]
      >[0],
    ) {
      const now = input.now ?? new Date()
      return withOwnedSession(async (transaction) => {
        await deps.authorizeCurrentActor({
          actor: input.actor,
          action: 'request',
          ownerRole: 'product_rollout',
          freshAuthenticationRequired: true,
        }, transaction)
        const prepared = prepareBillingRolloutSubjectManifest({
          command: input.command,
          actorUserId: input.actor.userId,
          authoritySecretBase64:
            deps.loadAuthoritySecretBase64(),
          now,
        })
        const replay = await deps.manifestModel.findOne({
          commandId: prepared.commandId,
        }).session(transaction).lean<ManifestLean>()
        if (replay) {
          const existing = manifestFromLean(replay)
          if (!sameManifestCommandSemantics(existing, prepared)) {
            throw new Error('Manifest command ID was reused')
          }
          return existing
        }
        await deps.manifestModel.create([{
          ...prepared,
          subjectHashes: [...prepared.subjectHashes],
          stagedByUserId:
            new mongoose.Types.ObjectId(prepared.stagedByUserId),
        }], { session: transaction })
        return prepared
      })
    },
    async purgeRetainedSubjectManifests(
      input: Parameters<
        MongoBillingRolloutRuntimeAuthority[
          'purgeRetainedSubjectManifests'
        ]
      >[0],
    ) {
      const now = input.now ?? new Date()
      if (!Number.isFinite(now.getTime())) {
        throw new Error('Manifest retention time is invalid')
      }
      const command =
        PurgeBillingRolloutSubjectManifestsCommandSchema.parse(
          input.command,
        )
      if (
        command.confirmation !==
          billingRolloutSubjectManifestPurgeConfirmation(command)
      ) throw new Error('Exact manifest purge confirmation is required')
      const retentionFloor = new Date(
        now.getTime() -
          BILLING_ROLLOUT_SUBJECT_MANIFEST_RETENTION_DAYS *
            24 * 60 * 60 * 1_000,
      )
      const retentionCutoff = new Date(command.retentionCutoff)
      if (retentionCutoff > retentionFloor) {
        throw new Error(
          'Manifest purge cutoff violates the retention floor',
        )
      }
      const commandDigest = billingRolloutDigest({
        domain: BILLING_ROLLOUT_SUBJECT_MANIFEST_PURGE_SCHEMA_VERSION,
        command,
      })
      return withOwnedSession(async (transaction) => {
        await deps.authorizeCurrentActor({
          actor: input.actor,
          action: 'request',
          ownerRole: 'product_rollout',
          freshAuthenticationRequired: true,
        }, transaction)
        await deps.authorizeManifestRetentionPurge({
          actor: input.actor,
          command,
          commandDigest,
        }, transaction)
        const active = await loadProjection(transaction)
        if (
          !active ||
          active.configHash !== command.expectedActiveConfigHash
        ) throw new Error('Active rollout projection changed')
        const protectedManifest =
          await deps.manifestModel.findOne({
            manifestHash: active.state.allowlistHash,
            expiresAt: { $lte: retentionCutoff },
          }).session(transaction).lean<ManifestLean>()
        if (protectedManifest) {
          throw new Error(
            'Active rollout audience is not eligible for purge',
          )
        }
        const rows = await deps.manifestModel.find({
          expiresAt: { $lte: retentionCutoff },
          manifestHash: { $ne: active.state.allowlistHash },
        }).sort({ expiresAt: 1, _id: 1 })
          .limit(command.maxDeleteCount)
          .session(transaction)
          .lean<ManifestLean[]>()
        const manifests = rows.map(manifestFromLean)
        const ids = rows.map((row) => {
          const id = String(row._id).toLowerCase()
          if (!mongoose.isObjectIdOrHexString(id)) {
            throw new Error('Invalid persisted manifest ID')
          }
          return new mongoose.Types.ObjectId(id)
        })
        const deleted = ids.length === 0
          ? 0
          : (await deps.manifestModel.collection.deleteMany({
              _id: { $in: ids },
              expiresAt: { $lte: retentionCutoff },
              manifestHash: { $ne: active.state.allowlistHash },
            }, { session: transaction })).deletedCount
        if (deleted !== manifests.length) {
          throw new Error('Manifest purge lost its exact delete fence')
        }
        return Object.freeze({
          schemaVersion:
            BILLING_ROLLOUT_SUBJECT_MANIFEST_PURGE_SCHEMA_VERSION,
          commandId: command.commandId,
          correlationId: command.correlationId,
          commandDigest,
          activeConfigHash: active.configHash,
          retentionCutoff,
          retentionFloor,
          examinedCount: manifests.length,
          purgedCount: deleted,
          purgedEvidenceHashes: Object.freeze(
            manifests.map(manifestPurgeEvidenceHash),
          ),
          performedAt: new Date(now),
        })
      })
    },
  }
  return Object.freeze(authority)
}
