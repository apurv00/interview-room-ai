import { describe, expect, it, vi } from 'vitest'
import {
  genericRetakeConfig,
  persistGenericRetakeConfig,
  planRetakeNavigation,
  retakeConfigFromStoredSession,
  retakeParentFromSearch,
} from '../utils/retakeNavigation'

const SESSION_ID = '507f1f77bcf86cd799439011'
const ROOT_ID = '507f1f77bcf86cd799439012'
const JOB_ID = '507f1f77bcf86cd799439013'

describe('retake navigation contract', () => {
  it('routes verified Jobs practice through the job page with both intents', () => {
    expect(planRetakeNavigation({
      parentSessionId: ROOT_ID,
      jobsOrigin: true,
      jobsPractice: { jobId: JOB_ID },
    }, SESSION_ID)).toEqual({
      kind: 'jobs-practice',
      parentSessionId: ROOT_ID,
      jobId: JOB_ID,
      href: `/jobs/${JOB_ID}?practice=1&retake=${ROOT_ID}`,
    })
  })

  it('keeps ordinary and malformed Jobs retakes in the generic setup flow', () => {
    expect(planRetakeNavigation({ parentSessionId: ROOT_ID }, SESSION_ID)).toEqual({
      kind: 'retake',
      parentSessionId: ROOT_ID,
      href: `/interview/setup?retake=${ROOT_ID}`,
    })
    expect(planRetakeNavigation({
      parentSessionId: 'bad-parent',
      jobsPractice: { jobId: 'javascript:alert(1)' },
    }, SESSION_ID)).toEqual({
      kind: 'retake',
      parentSessionId: SESSION_ID,
      href: `/interview/setup?retake=${SESSION_ID}`,
    })
  })

  it('routes an unverified Jobs-origin fallback to new general practice without lineage', () => {
    expect(planRetakeNavigation({
      parentSessionId: ROOT_ID,
      jobsOrigin: true,
      jobsPractice: { jobId: 'not-an-object-id' },
    }, SESSION_ID)).toEqual({
      kind: 'general-practice',
      jobsFallback: true,
      href: '/interview/setup?jobsFallback=1',
    })
  })

  it('accepts only persisted ObjectIds from the job-page retake query', () => {
    expect(retakeParentFromSearch(`?practice=1&retake=${ROOT_ID}`)).toBe(ROOT_ID)
    expect(retakeParentFromSearch('?practice=1&retake=not-an-id')).toBeUndefined()
    expect(retakeParentFromSearch('?practice=1')).toBeUndefined()
  })

  it('removes revoked Jobs posting context from a generic retake but preserves resume and interview choices', () => {
    expect(genericRetakeConfig({
      role: 'backend',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
      jobDescription: 'Revoked canonical JD',
      jdFileName: 'revoked-role.pdf',
      targetCompany: 'Revoked Co',
      targetIndustry: 'restricted-sector',
      resumeText: 'Candidate-owned resume',
      resumeFileName: 'resume.pdf',
      attribution: {
        source: 'jobs',
        jobId: JOB_ID,
        applicationId: '507f1f77bcf86cd799439014',
      },
      jobsHandoffToken: 'consumed-secret-token',
    }, true)).toEqual({
      role: 'backend',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
      resumeText: 'Candidate-owned resume',
      resumeFileName: 'resume.pdf',
    })
  })

  it('preserves an ordinary retake\'s user-supplied JD context', () => {
    const config = {
      role: 'backend',
      interviewType: 'behavioral',
      experience: '3-6' as const,
      duration: 20,
      jobDescription: 'Candidate-provided JD',
      jdFileName: 'my-role.pdf',
      targetCompany: 'Candidate target',
      targetIndustry: 'software',
      resumeText: 'Candidate resume',
    }

    expect(genericRetakeConfig(config, false)).toEqual(config)
  })

  it('reconstructs setup context from the real stored-session API shape', () => {
    expect(retakeConfigFromStoredSession({
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      jobDescription: 'Candidate-provided JD',
      jdFileName: 'role.pdf',
      resumeText: 'Candidate resume',
      resumeFileName: 'resume.pdf',
    })).toEqual({
      role: 'backend',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
      jobDescription: 'Candidate-provided JD',
      jdFileName: 'role.pdf',
      resumeText: 'Candidate resume',
      resumeFileName: 'resume.pdf',
    })
  })

  it('clears stale Jobs setup state even when no replacement config is available', () => {
    const storage = {
      removeItem: vi.fn(),
      setItem: vi.fn(),
    }

    persistGenericRetakeConfig(storage, 'interviewConfig', undefined, true)

    expect(storage.removeItem).toHaveBeenCalledWith('interviewConfig')
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})
