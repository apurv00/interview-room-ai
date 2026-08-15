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
  HireConsentError,
  assertCompleteHireConsent,
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

  it('pins a versioned digest to recording, selfie, attention, AI, and retention copy', () => {
    expect(HIRE_AI_CONSENT_VERSION).toMatch(/^hire-ai-v\d-/)
    expect(HIRE_AI_DISCLOSURE_DIGEST).toMatch(/^[a-f0-9]{64}$/)
    expect(HIRE_AI_DISCLOSURES.recording).toMatch(/recorded/i)
    expect(HIRE_AI_DISCLOSURES.identityPhoto).toMatch(/selfie/i)
    expect(HIRE_AI_DISCLOSURES.attentionMonitoring).toMatch(/not scores/i)
    expect(HIRE_AI_DISCLOSURES.aiEvaluation).toMatch(/human/i)
    expect(HIRE_AI_DISCLOSURES.retention).toMatch(/six calendar months/i)
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

  it('mints a coordinate-bound key and rejects cross-workspace authority', () => {
    const key = hireMediaKey(IDS, 'identity-photo')
    expect(parseHireMediaKey(key)).toEqual({ ...IDS, kind: 'identity-photo' })
    expect(() => assertHireMediaKeyScope(key, IDS)).not.toThrow()
    expect(() =>
      assertHireMediaKeyScope(key, { ...IDS, workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }),
    ).toThrow(InvalidHireMediaKeyError)
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
