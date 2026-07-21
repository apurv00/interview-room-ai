import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllInterviewStorage,
  clearInterviewStorageForOAuthSignIn,
  JOBS_STORAGE_KEYS,
  STORAGE_KEYS,
} from '@shared/storageKeys'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('clearAllInterviewStorage', () => {
  it('clears scoped interview and Jobs account state without touching unrelated preferences', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, 'private config')
    localStorage.setItem(`${STORAGE_KEYS.INTERVIEW_DATA}:session-1`, 'private transcript state')
    localStorage.setItem('JOBS_RETURN_posting-1', 'private apply arm')
    localStorage.setItem('jobs:future-account-state', 'private jobs state')
    localStorage.setItem('resume:draft:user-1:new', 'private authenticated resume draft')
    localStorage.setItem('resume:draft:user-2:resume-1', 'private prior-account resume draft')
    localStorage.setItem('resume:draft:anon', 'anonymous builder draft')
    localStorage.setItem('wizardDraft:user-1', 'private wizard draft')
    localStorage.setItem('wizardDraft:user-2', 'private prior-account wizard draft')
    localStorage.setItem('wizardDraft', 'unscoped legacy wizard draft')
    localStorage.setItem('ipg_distinct_id', 'user-1')
    localStorage.setItem('theme', 'dark')
    sessionStorage.setItem('JOBS_TARGET', 'resume-derived target')
    sessionStorage.setItem('JOBS_CAP_NOTICE', '1')
    sessionStorage.setItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION, 'private tailored result')
    sessionStorage.setItem('feedback-session:session-1', 'private feedback snapshot')
    sessionStorage.setItem('recording-url:v2:camera:session-1', 'private presigned URL')
    sessionStorage.setItem('peerData:backend:3-6', 'aggregate comparison')
    sessionStorage.setItem('navigation-tab', 'settings')

    await clearAllInterviewStorage()

    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    expect(localStorage.getItem(`${STORAGE_KEYS.INTERVIEW_DATA}:session-1`)).toBeNull()
    expect(localStorage.getItem('JOBS_RETURN_posting-1')).toBeNull()
    expect(localStorage.getItem('jobs:future-account-state')).toBeNull()
    expect(localStorage.getItem('resume:draft:user-1:new')).toBeNull()
    expect(localStorage.getItem('resume:draft:user-2:resume-1')).toBeNull()
    expect(localStorage.getItem('wizardDraft:user-1')).toBeNull()
    expect(localStorage.getItem('wizardDraft:user-2')).toBeNull()
    expect(localStorage.getItem('wizardDraft')).toBeNull()
    expect(localStorage.getItem('ipg_distinct_id')).toBeNull()
    // Anonymous builder continuity is intentionally account-independent. The
    // builder requires an explicit import/discard decision after sign-in.
    expect(localStorage.getItem('resume:draft:anon')).toBe('anonymous builder draft')
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(sessionStorage.getItem('JOBS_CAP_NOTICE')).toBeNull()
    expect(sessionStorage.getItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION)).toBeNull()
    expect(sessionStorage.getItem('feedback-session:session-1')).toBeNull()
    expect(sessionStorage.getItem('recording-url:v2:camera:session-1')).toBeNull()
    expect(sessionStorage.getItem('peerData:backend:3-6')).toBe('aggregate comparison')
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(sessionStorage.getItem('navigation-tab')).toBe('settings')
  })
})

describe('clearInterviewStorageForOAuthSignIn', () => {
  it('removes the Tailor OAuth handoff by default', async () => {
    sessionStorage.setItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION, 'short-lived Tailor handoff')

    await clearInterviewStorageForOAuthSignIn()

    expect(sessionStorage.getItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION)).toBeNull()
  })

  it('preserves only the validated Tailor OAuth handoff while clearing other private state', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, 'private config')
    localStorage.setItem('jobs:future-account-state', 'private jobs state')
    localStorage.setItem('resume:draft:user-1:new', 'private authenticated resume draft')
    localStorage.setItem('resume:draft:anon', 'anonymous builder draft')
    localStorage.setItem('wizardDraft:user-1', 'private wizard draft')
    localStorage.setItem('ipg_distinct_id', 'user-1')
    sessionStorage.setItem('JOBS_TARGET', 'resume-derived target')
    sessionStorage.setItem('jobs:future-account-state', 'private jobs state')
    sessionStorage.setItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION, 'short-lived Tailor handoff')
    sessionStorage.setItem('feedback-session:session-1', 'private feedback snapshot')
    sessionStorage.setItem('recording-url:v2:audio:session-1', 'private presigned URL')
    sessionStorage.setItem('navigation-tab', 'settings')

    await clearInterviewStorageForOAuthSignIn({ preserveTailorContinuation: true })

    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    expect(localStorage.getItem('jobs:future-account-state')).toBeNull()
    expect(localStorage.getItem('resume:draft:user-1:new')).toBeNull()
    expect(localStorage.getItem('wizardDraft:user-1')).toBeNull()
    expect(localStorage.getItem('ipg_distinct_id')).toBeNull()
    expect(localStorage.getItem('resume:draft:anon')).toBe('anonymous builder draft')
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(sessionStorage.getItem('jobs:future-account-state')).toBeNull()
    expect(sessionStorage.getItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION)).toBe('short-lived Tailor handoff')
    expect(sessionStorage.getItem('feedback-session:session-1')).toBeNull()
    expect(sessionStorage.getItem('recording-url:v2:audio:session-1')).toBeNull()
    expect(sessionStorage.getItem('navigation-tab')).toBe('settings')
  })
})
