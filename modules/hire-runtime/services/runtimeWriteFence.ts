import { isCanonicalR2Key } from '@shared/storage/r2'
import {
  HIRE_RUNTIME_STORAGE_CAPABILITY_MS,
  HIRE_RUNTIME_WRITE_DRAIN_MS,
  runtimeWriteDrainMs,
} from '@shared/contracts/hireRuntimeWriteFence'
import { HireRuntimeBinding, type IHireRuntimeBinding } from '../models/HireRuntimeBinding'
import { connectHireRuntimeDB } from './runtimeBoundary'

export class RuntimeWriteFenceError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 410 | 503,
  ) {
    super(message)
    this.name = 'RuntimeWriteFenceError'
  }
}

export { runtimeWriteDrainMs }

export async function claimRuntimeWriteCapability(input: {
  workspaceId: string
  principalId: string
  pathname: string
  method: string
  now?: Date
}): Promise<IHireRuntimeBinding> {
  const horizonMs = runtimeWriteDrainMs(input.pathname, input.method)
  if (horizonMs === null) {
    throw new RuntimeWriteFenceError('Runtime write target is not allow-listed', 404)
  }
  await connectHireRuntimeDB()
  const now = input.now ?? new Date()
  const binding = await HireRuntimeBinding.findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      status: 'active',
      runtimeSessionId: { $exists: true },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
    },
    {
      $max: { runtimeWriteDrainUntil: new Date(now.getTime() + horizonMs) },
    },
    { new: true },
  )
  if (!binding) {
    throw new RuntimeWriteFenceError('Runtime binding is revoked or unavailable', 410)
  }
  return binding
}

function assertCapabilityKey(input: {
  key: string
  principalId: string
  runtimeSessionId: string
}): void {
  if (!isCanonicalR2Key(input.key)) {
    throw new RuntimeWriteFenceError('Runtime storage capability key is not canonical', 503)
  }
  const match = /^recordings\/([a-f0-9]{24})\/([a-f0-9]{24})(?:-(?:screen|audio))?-\d{10,16}\.webm$/i
    .exec(input.key)
  if (
    !match ||
    match[1].toLowerCase() !== input.principalId.toLowerCase() ||
    match[2].toLowerCase() !== input.runtimeSessionId.toLowerCase()
  ) {
    throw new RuntimeWriteFenceError('Runtime storage capability crossed its binding', 503)
  }
}

export async function recordRuntimeStorageCapability(input: {
  workspaceId: string
  bindingId: string
  principalId: string
  runtimeSessionId: string
  key: string
  uploadId?: string
  now?: Date
}): Promise<void> {
  assertCapabilityKey(input)
  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + HIRE_RUNTIME_STORAGE_CAPABILITY_MS,
  )
  const scope = {
    _id: input.bindingId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeSessionId: input.runtimeSessionId,
    status: { $in: ['provisioned', 'active'] },
    revokedAt: { $exists: false },
    purgePersonalData: { $ne: true },
  }
  await HireRuntimeBinding.updateOne(scope, {
    $pull: {
      issuedObjectCapabilities: { key: input.key },
      ...(input.uploadId
        ? { issuedMultipartCapabilities: { uploadId: input.uploadId } }
        : {}),
    },
  })
  const recorded = await HireRuntimeBinding.updateOne(scope, {
    $push: {
      issuedObjectCapabilities: {
        key: input.key,
        runtimeSessionId: input.runtimeSessionId,
        expiresAt,
      },
      ...(input.uploadId
        ? {
            issuedMultipartCapabilities: {
              key: input.key,
              runtimeSessionId: input.runtimeSessionId,
              uploadId: input.uploadId,
              expiresAt,
            },
          }
        : {}),
    },
    $max: { runtimeWriteDrainUntil: expiresAt },
  })
  if (recorded.matchedCount !== 1) {
    throw new RuntimeWriteFenceError('Runtime binding revoked during capability issue', 410)
  }
}

export async function settleRuntimeMultipartCapability(input: {
  workspaceId: string
  bindingId: string
  uploadId: string
  key: string
  removeObjectCapability: boolean
}): Promise<void> {
  const settled = await HireRuntimeBinding.updateOne(
    { _id: input.bindingId, workspaceId: input.workspaceId },
    {
      $pull: {
        issuedMultipartCapabilities: { uploadId: input.uploadId },
        ...(input.removeObjectCapability
          ? { issuedObjectCapabilities: { key: input.key } }
          : {}),
      },
    },
  )
  if (settled.matchedCount !== 1) {
    throw new RuntimeWriteFenceError('Runtime capability settlement failed', 503)
  }
}

export function assertRuntimeWritesDrained(
  binding: Pick<IHireRuntimeBinding, 'runtimeWriteDrainUntil'>,
  now = new Date(),
): void {
  if (binding.runtimeWriteDrainUntil && binding.runtimeWriteDrainUntil > now) {
    throw new RuntimeWriteFenceError(
      'Runtime personal-data purge is waiting for issued write capabilities to drain',
      503,
    )
  }
}

export const __runtimeWriteFence = {
  RUNTIME_WRITE_DRAIN_MS: HIRE_RUNTIME_WRITE_DRAIN_MS,
  RUNTIME_STORAGE_CAPABILITY_MS: HIRE_RUNTIME_STORAGE_CAPABILITY_MS,
  assertCapabilityKey,
}
