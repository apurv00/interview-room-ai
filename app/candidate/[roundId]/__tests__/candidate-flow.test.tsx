import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HIRE_AI_INTERVIEW_DISCLOSURES } from '@shared/contracts/hireAiInterviewConsentDisclosure'

import CandidateFlow from '../CandidateFlow'

const ROUND_ID = 'a'.repeat(24)
const CAPABILITY = `${'1'.repeat(24)}.${'bc'.repeat(32)}`

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderFlow(
  authMode: 'magic_link' | 'otp' = 'magic_link',
  legacyConsentAttempt = false,
) {
  render(
    <CandidateFlow
      roundId={ROUND_ID}
      capability={CAPABILITY}
      authMode={authMode}
      consentAlreadyGiven={false}
      legacyConsentAttempt={legacyConsentAttempt}
      emailHint="c***@example.com"
      workspaceName="Example Co"
    />,
  )
}

function acceptAllConsents() {
  for (const checkbox of screen.getAllByRole('checkbox')) {
    fireEvent.click(checkbox)
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('candidate saved-photo resume', () => {
  it('uses the begin response to bypass recapture when the photo is already saved', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ ok: true, csrfToken: 'csrf-token', next: 'resume' }),
    )
    renderFlow()
    acceptAllConsents()

    fireEvent.click(screen.getByRole('button', { name: 'Consent and continue' }))

    expect(
      await screen.findByRole('heading', { name: 'Your identity photo is saved' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume secure interview' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Capture photo' })).toBeNull()
  })

  it('uses the verification response to resume an OTP-authenticated candidate', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true, otpRequired: true }))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, csrfToken: 'csrf-token', next: 'resume' }),
      )
    renderFlow('otp')
    acceptAllConsents()

    fireEvent.click(screen.getByRole('button', { name: 'Consent and send code' }))
    const codeInput = await screen.findByLabelText('Enter your 6-digit code')
    fireEvent.change(codeInput, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }))

    expect(
      await screen.findByRole('heading', { name: 'Your identity photo is saved' }),
    ).toBeTruthy()
  })

  it('returns to the saved-photo resume action when starting is retryable', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, csrfToken: 'csrf-token', next: 'resume' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: 'The interview runtime is temporarily unavailable.' }, 503),
      )
    renderFlow()
    acceptAllConsents()
    fireEvent.click(screen.getByRole('button', { name: 'Consent and continue' }))

    fireEvent.click(
      await screen.findByRole('button', { name: 'Resume secure interview' }),
    )

    expect(
      await screen.findByText('The interview runtime is temporarily unavailable.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume secure interview' })).toBeTruthy()
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `/api/candidate/${ROUND_ID}/start`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-hire-csrf': 'csrf-token' },
      }),
    )
  })
})

describe('candidate consent versions', () => {
  it('renders the shared current V4 disclosure before a new attempt is consented', () => {
    renderFlow()

    for (const disclosure of Object.values(HIRE_AI_INTERVIEW_DISCLOSURES)) {
      expect(screen.getByText(disclosure)).toBeTruthy()
    }
    expect(
      screen.getByText(/sharing the interview recording and review with the hiring team/i),
    ).toBeTruthy()
  })

  it('continues a server-identified historical attempt without displaying or minting V4 consent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ ok: true, csrfToken: 'csrf-token', next: 'identity_photo' }),
    )
    renderFlow('magic_link', true)

    expect(screen.getByRole('heading', { name: 'Continue your interview' })).toBeTruthy()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(
      screen.queryByText(/structured facial-landmark and browser-window observations/i),
    ).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue your interview' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const [, options] = vi.mocked(fetch).mock.calls[0]
    expect(options).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(options?.body))).toEqual({
      capability: CAPABILITY,
      accepted: {
        recording: true,
        identityPhoto: true,
        attentionMonitoring: true,
        aiEvaluation: true,
      },
    })
  })
})

describe('candidate identity photo preview', () => {
  it('renders a CSP-compatible data URL after capturing the live frame', async () => {
    const stop = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop }],
        }),
      },
    })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,cHJldmlldw==',
    )
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        csrfToken: 'csrf-token',
        next: 'identity_photo',
      }),
    )
    renderFlow()
    acceptAllConsents()
    fireEvent.click(screen.getByRole('button', { name: 'Consent and continue' }))

    const capture = await screen.findByRole('button', { name: 'Capture photo' })
    await waitFor(() => expect(capture).not.toBeDisabled())
    fireEvent.click(capture)

    const preview = await screen.findByAltText('Captured identity selfie preview')
    expect(preview).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,cHJldmlldw==',
    )
    expect(stop).toHaveBeenCalled()
  })
})
