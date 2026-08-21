import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { HireConsentReceipt } from '../models/HireConsentReceipt'
import { HireGuestSession } from '../models/HireGuestSession'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireInterviewResult } from '../models/HireInterviewResult'
import { HireMediaAsset } from '../models/HireMediaAsset'
import {
  HirePrivacyRequest,
  activeHirePrivacyRequestFilter,
} from '../models/HirePrivacyRequest'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_DISCLOSURE_DIGEST,
  HIRE_AI_DISCLOSURES,
  HIRE_AI_V2_CONSENT_VERSION,
  HIRE_AI_V2_DISCLOSURE_DIGEST,
  HIRE_AI_V3_CONSENT_VERSION,
  HIRE_AI_V3_DISCLOSURE_DIGEST,
  HIRE_AI_V4_CONSENT_VERSION,
  HIRE_AI_V4_DISCLOSURE_DIGEST,
  HIRE_AI_V5_CONSENT_VERSION,
  HIRE_AI_V5_DISCLOSURE_DIGEST,
  HireConsentError,
  assertCompleteHireConsent,
  isRecognizedHireConsentSnapshot,
  isRecognizedHireConsentVersion,
  supportsHireDisplayCapture,
  supportsHireMultimodalObservations,
} from '../policies/aiInterviewConsent'
import {
  InvalidHireMediaKeyError,
  assertHireMediaKeyScope,
  hireMediaKey,
  parseHireMediaKey,
} from '../services/hireMediaStorage'
import { getHireGuestCookieName } from '../services/identityConsentService'
import {
  MAX_IDENTITY_PHOTO_EDGE,
  normalizeIdentityPhoto,
} from '../services/identityMediaService'

const IDS = {
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  roundId: '333333333333333333333333',
  attemptId: '444444444444444444444444',
  assetId: '555555555555555555555555',
}
const OBJECT_KEY_NONCE = 'a'.repeat(64)

describe('Hire AI consent contract', () => {
  it('requires explicit acceptance of every disclosed activity', () => {
    expect(() =>
      assertCompleteHireConsent({
        recording: true,
        identityPhoto: true,
        attentionMonitoring: false,
        aiEvaluation: true,
      }),
    ).toThrow(HireConsentError)
    expect(() =>
      assertCompleteHireConsent({
        recording: true,
        identityPhoto: true,
        attentionMonitoring: true,
        aiEvaluation: true,
      }),
    ).not.toThrow()
  })

  it('pins V6 to compulsory entire-display capture, validation, Hire analysis, selfie, AI, and retention copy', () => {
    expect(HIRE_AI_CONSENT_VERSION).toBe('hire-ai-v6-2026-08-20')
    expect(HIRE_AI_DISCLOSURE_DIGEST).toMatch(/^[a-f0-9]{64}$/)
    expect(HIRE_AI_DISCLOSURES.recording).toMatch(/entire-display share are required/i)
    expect(HIRE_AI_DISCLOSURES.recording).toMatch(/recorded/i)
    expect(HIRE_AI_DISCLOSURES.recording).toMatch(/shared with the hiring team/i)
    expect(HIRE_AI_DISCLOSURES.recording).toMatch(/entire display/i)
    expect(HIRE_AI_DISCLOSURES.recording).toMatch(/Hire interview review/i)
    expect(HIRE_AI_DISCLOSURES.identityPhoto).toMatch(/selfie/i)
    expect(HIRE_AI_DISCLOSURES.attentionMonitoring).toMatch(/full-screen mode/i)
    expect(HIRE_AI_DISCLOSURES.attentionMonitoring).toMatch(/camera or microphone capture is interrupted/i)
    expect(HIRE_AI_DISCLOSURES.attentionMonitoring).toMatch(/wrong display surface is shared/i)
    expect(HIRE_AI_DISCLOSURES.attentionMonitoring).toMatch(/display sharing is interrupted/i)
    expect(HIRE_AI_DISCLOSURES.attentionMonitoring).toMatch(/never make a hiring decision, stage, ranking, recommendation, or export/i)
    expect(HIRE_AI_DISCLOSURES.aiEvaluation).toMatch(/corroborated by the visible candidate/i)
    expect(HIRE_AI_DISCLOSURES.aiEvaluation).toMatch(/does not establish who was speaking/i)
    expect(HIRE_AI_DISCLOSURES.aiEvaluation).toMatch(/human/i)
    expect(HIRE_AI_DISCLOSURES.retention).toMatch(/six calendar months/i)
  })

  it('recognizes only exact historical V2–V5 receipt pairs for active legacy attempts', () => {
    expect(HIRE_AI_V5_DISCLOSURE_DIGEST).toBe(
      '4770e6cfe3c0b0e36bb132353748b79d9479b6c0a0fa1f95ab736368c6227658',
    )
    expect(
      isRecognizedHireConsentSnapshot({
        consentVersion: HIRE_AI_V2_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_V2_DISCLOSURE_DIGEST,
      }),
    ).toBe(true)
    expect(
      isRecognizedHireConsentSnapshot({
        consentVersion: HIRE_AI_V5_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_V5_DISCLOSURE_DIGEST,
      }),
    ).toBe(true)
    expect(
      isRecognizedHireConsentSnapshot({
        consentVersion: HIRE_AI_V4_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_V4_DISCLOSURE_DIGEST,
      }),
    ).toBe(true)
    expect(
      isRecognizedHireConsentSnapshot({
        consentVersion: HIRE_AI_V3_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_V3_DISCLOSURE_DIGEST,
      }),
    ).toBe(true)
    expect(
      isRecognizedHireConsentSnapshot({
        consentVersion: HIRE_AI_V2_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_DISCLOSURE_DIGEST,
      }),
    ).toBe(false)
    expect(
      isRecognizedHireConsentSnapshot({
        consentVersion: HIRE_AI_V4_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_V2_DISCLOSURE_DIGEST,
      }),
    ).toBe(false)
  })

  it('enables Hire-native observations for V5 and V6, but display capture only for V6', () => {
    expect(supportsHireMultimodalObservations(HIRE_AI_CONSENT_VERSION)).toBe(true)
    expect(supportsHireMultimodalObservations(HIRE_AI_V5_CONSENT_VERSION)).toBe(true)
    expect(supportsHireMultimodalObservations(HIRE_AI_V4_CONSENT_VERSION)).toBe(false)
    expect(supportsHireMultimodalObservations(HIRE_AI_V3_CONSENT_VERSION)).toBe(false)
    expect(supportsHireMultimodalObservations(HIRE_AI_V2_CONSENT_VERSION)).toBe(false)
    expect(supportsHireDisplayCapture(HIRE_AI_CONSENT_VERSION)).toBe(true)
    expect(supportsHireDisplayCapture(HIRE_AI_V5_CONSENT_VERSION)).toBe(false)
    expect(supportsHireDisplayCapture(HIRE_AI_V4_CONSENT_VERSION)).toBe(false)
  })

  it('exposes the recognized version set only as a runtime coarse gate', () => {
    expect(isRecognizedHireConsentVersion(HIRE_AI_CONSENT_VERSION)).toBe(true)
    expect(isRecognizedHireConsentVersion(HIRE_AI_V5_CONSENT_VERSION)).toBe(true)
    expect(isRecognizedHireConsentVersion(HIRE_AI_V4_CONSENT_VERSION)).toBe(true)
    expect(isRecognizedHireConsentVersion(HIRE_AI_V3_CONSENT_VERSION)).toBe(true)
    expect(isRecognizedHireConsentVersion(HIRE_AI_V2_CONSENT_VERSION)).toBe(true)
    expect(isRecognizedHireConsentVersion('hire-ai-v999')).toBe(false)
    expect(isRecognizedHireConsentVersion(undefined)).toBe(false)
  })

  it('rejects a persisted receipt whose acknowledgement is false', () => {
    const receipt = new HireConsentReceipt({
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      jobId: '666666666666666666666666',
      candidateId: '777777777777777777777777',
      roundId: IDS.roundId,
      attemptId: IDS.attemptId,
      consentVersion: HIRE_AI_CONSENT_VERSION,
      disclosureDigest: HIRE_AI_DISCLOSURE_DIGEST,
      accepted: {
        recording: true,
        identityPhoto: true,
        attentionMonitoring: false,
        aiEvaluation: true,
      },
      acceptedAt: new Date(),
    })
    expect(receipt.validateSync()?.errors['accepted.attentionMonitoring']).toBeDefined()
  })
})

describe('Hire-owned schema boundaries', () => {
  it('keeps the v2 object-key nonce immutable and out of default projections', () => {
    const nonce = HireMediaAsset.schema.path('objectKeyNonce')
    expect(nonce.options.immutable).toBe(true)
    expect(nonce.options.select).toBe(false)
    expect(nonce.options.minlength).toBe(64)
    expect(nonce.options.maxlength).toBe(64)
    const required = nonce.options.required as (this: {
      objectKey: string
    }) => boolean
    expect(required.call({ objectKey: `hire-media/v2/${'a'.repeat(64)}` })).toBe(
      true,
    )
    expect(
      required.call({
        objectKey: `hire-media/${IDS.workspaceId}/${IDS.applicationId}/${IDS.roundId}/${IDS.attemptId}/${IDS.assetId}-identity-photo.jpg`,
      }),
    ).toBe(false)

    const mediaFields = {
      ...IDS,
      jobId: '666666666666666666666666',
      candidateId: '777777777777777777777777',
      kind: 'identity_photo' as const,
      state: 'staging' as const,
      contentType: 'image/jpeg',
      bytes: 1,
      sha256: 'b'.repeat(64),
      capturedAt: new Date('2026-08-21T00:00:00.000Z'),
    }
    const v2WithoutNonce = new HireMediaAsset({
      ...mediaFields,
      objectKey: `hire-media/v2/${'a'.repeat(64)}`,
    })
    expect(
      v2WithoutNonce.validateSync()?.errors.objectKeyNonce,
    ).toBeDefined()

    const legacyWithoutNonce = new HireMediaAsset({
      ...mediaFields,
      objectKey: `hire-media/${IDS.workspaceId}/${IDS.applicationId}/${IDS.roundId}/${IDS.attemptId}/${IDS.assetId}-identity-photo.jpg`,
    })
    expect(legacyWithoutNonce.validateSync()).toBeUndefined()
  })

  it('treats only processing or unexpired verification requests as active', () => {
    const now = new Date('2026-08-15T12:00:00.000Z')

    expect(activeHirePrivacyRequestFilter(now)).toEqual({
      live: true,
      $or: [
        { status: 'processing' },
        {
          status: 'pending_verification',
          verificationExpiresAt: { $gt: now },
        },
      ],
    })
  })

  it.each([
    HireConsentReceipt,
    HireGuestSession,
    HireInterviewAttempt,
    HireMediaAsset,
    HireInterviewResult,
    HirePrivacyRequest,
  ])('$modelName requires immutable workspaceId', (model) => {
    const workspacePath = model.schema.path('workspaceId')
    expect(workspacePath).toBeDefined()
    expect(workspacePath.options.required).toBe(true)
    expect(workspacePath.options.immutable).toBe(true)
  })

  it('contains no candidate relation to B2C User or InterviewSession', () => {
    const sourceFiles = [
      'models/HireConsentReceipt.ts',
      'models/HireGuestSession.ts',
      'models/HireInterviewAttempt.ts',
      'models/HireMediaAsset.ts',
      'models/HireInterviewResult.ts',
      'models/HirePrivacyRequest.ts',
      'services/identityConsentService.ts',
      'services/identityMediaService.ts',
      'services/mediaAccessService.ts',
      'services/mediaLifecycleService.ts',
      'services/privacyService.ts',
      'services/evidenceService.ts',
    ]
    for (const relative of sourceFiles) {
      const source = fs.readFileSync(path.join(process.cwd(), 'modules/hire', relative), 'utf8')
      expect(source).not.toMatch(/from ['"]@shared\/db\/models(?:\/User|\/InterviewSession)?['"]/)
      expect(source).not.toMatch(/from ['"]@interview(?:\/|['"])/)
    }
  })
})

describe('Hire media storage and selfie normalization', () => {
  it('uses a Secure __Host cookie only in production and a browser-safe local name', () => {
    expect(getHireGuestCookieName('production')).toBe('__Host-hire_guest')
    expect(getHireGuestCookieName('development')).toBe('hire_guest')
    expect(getHireGuestCookieName('test')).toBe('hire_guest')
  })

  it('mints an opaque v2 key, dual-reads v1, and rejects scope tampering', () => {
    const key = hireMediaKey(IDS, 'identity-photo', OBJECT_KEY_NONCE)
    const screenKey = hireMediaKey(IDS, 'screen-recording', OBJECT_KEY_NONCE)
    expect(key).toMatch(/^hire-media\/v2\/[a-f0-9]{64}$/)
    expect(key).not.toContain(IDS.workspaceId)
    expect(key).not.toContain(IDS.applicationId)
    expect(key).not.toContain(IDS.roundId)
    expect(key).not.toContain(IDS.attemptId)
    expect(key).not.toContain(IDS.assetId)
    expect(key).not.toContain('identity-photo')
    expect(parseHireMediaKey(key)).toEqual({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(parseHireMediaKey(screenKey)).toEqual({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(parseHireMediaKey(`hire-media/v2/${'A'.repeat(64)}`)).toBeNull()
    expect(() =>
      assertHireMediaKeyScope(
        key,
        IDS,
        'identity-photo',
        OBJECT_KEY_NONCE,
      ),
    ).not.toThrow()
    expect(() =>
      assertHireMediaKeyScope(
        key,
        { ...IDS, workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        'identity-photo',
        OBJECT_KEY_NONCE,
      ),
    ).toThrow(InvalidHireMediaKeyError)
    expect(() =>
      assertHireMediaKeyScope(
        `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`,
        IDS,
        'identity-photo',
        OBJECT_KEY_NONCE,
      ),
    ).toThrow(InvalidHireMediaKeyError)
    expect(() =>
      assertHireMediaKeyScope(
        key,
        { ...IDS, assetId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        'identity-photo',
        OBJECT_KEY_NONCE,
      ),
    ).toThrow(InvalidHireMediaKeyError)
    expect(() =>
      assertHireMediaKeyScope(
        key,
        IDS,
        'screen-recording',
        OBJECT_KEY_NONCE,
      ),
    ).toThrow(InvalidHireMediaKeyError)
    expect(() =>
      assertHireMediaKeyScope(key, IDS, 'identity-photo', 'b'.repeat(64)),
    ).toThrow(InvalidHireMediaKeyError)
    expect(() =>
      assertHireMediaKeyScope(key, IDS, 'identity-photo', undefined),
    ).toThrow(InvalidHireMediaKeyError)
    const legacyKey = [
      'hire-media',
      IDS.workspaceId,
      IDS.applicationId,
      IDS.roundId,
      IDS.attemptId,
      `${IDS.assetId}-identity-photo.jpg`,
    ].join('/')
    expect(parseHireMediaKey(legacyKey)).toEqual({
      ...IDS,
      kind: 'identity-photo',
    })
    expect(() =>
      assertHireMediaKeyScope(
        legacyKey,
        IDS,
        'identity-photo',
        undefined,
      ),
    ).not.toThrow()
    expect(parseHireMediaKey('hire-media/../../secret')).toBeNull()
  })

  it('re-encodes to bounded JPEG and strips source metadata', async () => {
    const source = await sharp({
      create: {
        width: 1800,
        height: 900,
        channels: 3,
        background: { r: 30, g: 120, b: 180 },
      },
    })
      .withMetadata({ orientation: 1 })
      .png()
      .toBuffer()
    const normalized = await normalizeIdentityPhoto({
      body: source,
      declaredContentType: 'image/png',
    })
    const metadata = await sharp(normalized.body).metadata()
    expect(metadata.format).toBe('jpeg')
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(
      MAX_IDENTITY_PHOTO_EDGE,
    )
    expect(metadata.exif).toBeUndefined()
    expect(normalized.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects SVG and declared non-image content', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    await expect(
      normalizeIdentityPhoto({ body: svg, declaredContentType: 'image/svg+xml' }),
    ).rejects.toMatchObject({ code: 'PHOTO_TYPE_INVALID', status: 415 })
  })
})
