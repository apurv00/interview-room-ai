import { describe, expect, it } from 'vitest'
import {
  planRetakeNavigation,
  retakeParentFromSearch,
} from '../utils/retakeNavigation'

const SESSION_ID = '507f1f77bcf86cd799439011'
const ROOT_ID = '507f1f77bcf86cd799439012'
const JOB_ID = '507f1f77bcf86cd799439013'

describe('retake navigation contract', () => {
  it('routes verified Jobs practice through the job page with both intents', () => {
    expect(planRetakeNavigation({
      parentSessionId: ROOT_ID,
      jobsPractice: { jobId: JOB_ID },
    }, SESSION_ID)).toEqual({
      parentSessionId: ROOT_ID,
      jobId: JOB_ID,
      href: `/jobs/${JOB_ID}?practice=1&retake=${ROOT_ID}`,
    })
  })

  it('keeps ordinary and malformed Jobs retakes in the generic setup flow', () => {
    expect(planRetakeNavigation({ parentSessionId: ROOT_ID }, SESSION_ID)).toEqual({
      parentSessionId: ROOT_ID,
      href: `/interview/setup?retake=${ROOT_ID}`,
    })
    expect(planRetakeNavigation({
      parentSessionId: 'bad-parent',
      jobsPractice: { jobId: 'javascript:alert(1)' },
    }, SESSION_ID)).toEqual({
      parentSessionId: SESSION_ID,
      href: `/interview/setup?retake=${SESSION_ID}`,
    })
  })

  it('accepts only persisted ObjectIds from the job-page retake query', () => {
    expect(retakeParentFromSearch(`?practice=1&retake=${ROOT_ID}`)).toBe(ROOT_ID)
    expect(retakeParentFromSearch('?practice=1&retake=not-an-id')).toBeUndefined()
    expect(retakeParentFromSearch('?practice=1')).toBeUndefined()
  })
})
