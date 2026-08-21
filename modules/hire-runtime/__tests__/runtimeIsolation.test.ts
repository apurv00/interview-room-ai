import { afterEach, describe, expect, it } from 'vitest'
import { HireRuntimeBinding } from '../models/HireRuntimeBinding'
import { HireRuntimeMultimodalAnalysisOutbox } from '../models/HireRuntimeMultimodalAnalysisOutbox'
import { HireRuntimeMultimodalObservationOutbox } from '../models/HireRuntimeMultimodalObservationOutbox'
import { runtimeLandmarkV2Key } from '../services/runtimeMediaManifest'
import { assertHireRuntimeSurface } from '../services/runtimeBoundary'
import { runtimePrincipalEmail } from '../services/runtimePrincipalService'

const originalSurface = process.env.IPG_SURFACE

afterEach(() => {
  if (originalSurface === undefined) delete process.env.IPG_SURFACE
  else process.env.IPG_SURFACE = originalSurface
})

describe('Hire runtime identity isolation', () => {
  it('fails closed outside the dedicated runtime deployment', () => {
    process.env.IPG_SURFACE = 'hire-control'
    expect(() => assertHireRuntimeSurface()).toThrow(/outside the isolated runtime/)
  })

  it('binding schema has no candidate or B2C identity fields', () => {
    expect(HireRuntimeBinding.schema.path('candidateEmail')).toBeUndefined()
    expect(HireRuntimeBinding.schema.path('candidateName')).toBeUndefined()
    expect(HireRuntimeBinding.schema.path('b2cUserId')).toBeUndefined()
    expect(HireRuntimeBinding.schema.path('workspaceId')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('applicationId')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('roundId')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketGeneration')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketHandoffNonce')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketState')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketDigest')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketExpiresAt')).toBeDefined()
    expect(
      HireRuntimeBinding.schema.path('resultPayloadSnapshotProtocolVersion'),
    ).toBeDefined()
  })

  it('uses only a non-routable, round-scoped pseudonym', () => {
    const email = runtimePrincipalEmail('A'.repeat(24))
    expect(email).toBe(`round-${'a'.repeat(24)}@guests.interviewprep.internal`)
    expect(email).not.toContain('example.com')
  })

  it('stores optional recorder clock bindings inside the isolated observation report', () => {
    expect(
      HireRuntimeMultimodalObservationOutbox.schema.path(
        'report.playbackClock.protocolVersion',
      ),
    ).toBeDefined()
    expect(
      HireRuntimeMultimodalObservationOutbox.schema.path(
        'report.playbackClock.cameraRecorderStartOffsetMs',
      ),
    ).toBeDefined()
    expect(
      HireRuntimeMultimodalObservationOutbox.schema.path(
        'report.playbackClock.screenRecorderStartOffsetMs',
      ),
    ).toBeDefined()
  })

  it('requires temporary nonce authority for every persisted digest-only v2 landmark key', () => {
    const principalId = 'a'.repeat(24)
    const runtimeSessionId = 'b'.repeat(24)
    const objectKeyNonce = 'c'.repeat(64)
    const sourceKey = runtimeLandmarkV2Key({
      principalId,
      runtimeSessionId,
      objectKeyNonce,
    })
    const artifact = {
      sourceKey,
      contentType: 'application/json',
      sizeBytes: 1,
      sha256: 'd'.repeat(64),
    }
    const capability = {
      key: sourceKey,
      runtimeSessionId,
      expiresAt: new Date('2026-08-21T00:00:00.000Z'),
    }

    expect(new HireRuntimeMultimodalAnalysisOutbox({
      landmarkArtifact: artifact,
    }).validateSync(['landmarkArtifact'])).toBeDefined()
    expect(new HireRuntimeMultimodalAnalysisOutbox({
      landmarkArtifact: { ...artifact, objectKeyNonce },
    }).validateSync(['landmarkArtifact'])).toBeUndefined()

    expect(new HireRuntimeBinding({
      issuedObjectCapabilities: [capability],
    }).validateSync(['issuedObjectCapabilities'])).toBeDefined()
    expect(new HireRuntimeBinding({
      issuedObjectCapabilities: [{ ...capability, objectKeyNonce }],
    }).validateSync(['issuedObjectCapabilities'])).toBeUndefined()
  })

  it('forbids retaining a v2 nonce beside a coordinate-bound legacy landmark key', () => {
    const legacySourceKey =
      `landmarks/${'a'.repeat(24)}/${'b'.repeat(24)}-${'d'.repeat(32)}.json`
    expect(new HireRuntimeMultimodalAnalysisOutbox({
      landmarkArtifact: {
        sourceKey: legacySourceKey,
        objectKeyNonce: 'c'.repeat(64),
        contentType: 'application/json',
        sizeBytes: 1,
        sha256: 'd'.repeat(64),
      },
    }).validateSync(['landmarkArtifact'])).toBeDefined()
  })
})
