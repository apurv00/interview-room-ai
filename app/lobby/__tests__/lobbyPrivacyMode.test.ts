import { describe, expect, it } from 'vitest'
import type { InterviewConfig } from '@shared/types'
import {
  isLobbyPrivacyModeAvailable,
  shouldClearStaleHirePrivacyMode,
} from '../lobbyPrivacyMode'

const STANDARD_CONFIG: InterviewConfig = {
  role: 'Software Engineer',
  experience: '3-6',
  duration: 30,
}

const HIRE_CONFIG = {
  ...STANDARD_CONFIG,
  _hireRoundId: '666666666666666666666666',
} as InterviewConfig

describe('Lobby privacy-mode boundary', () => {
  it('keeps the recording opt-out available for ordinary B2C interviews', () => {
    expect(isLobbyPrivacyModeAvailable(STANDARD_CONFIG, true)).toBe(true)
    expect(isLobbyPrivacyModeAvailable(STANDARD_CONFIG, false)).toBe(false)
  })

  it('hides the B2C opt-out and clears stale privacy mode for a Hire interview', () => {
    expect(isLobbyPrivacyModeAvailable(HIRE_CONFIG, true)).toBe(false)
    expect(shouldClearStaleHirePrivacyMode(HIRE_CONFIG)).toBe(false)
    expect(
      shouldClearStaleHirePrivacyMode({
        ...HIRE_CONFIG,
        privacyMode: true,
      } as InterviewConfig),
    ).toBe(true)
  })
})
