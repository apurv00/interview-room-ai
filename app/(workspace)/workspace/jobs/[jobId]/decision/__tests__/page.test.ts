import { describe, expect, it } from 'vitest'
import DecisionWorkspacePage from '../page'
import { decisionHandoff } from '../decisionHandoff'

const APP_A = '111111111111111111111111'
const APP_B = '222222222222222222222222'
const APP_C = '333333333333333333333333'

describe('decision page candidate handoff', () => {
  it('keys the client workspace to the job boundary', async () => {
    const jobId = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    const page = await DecisionWorkspacePage({
      params: Promise.resolve({ jobId }),
    })

    expect(page.props.children[1].key).toBe(jobId)
  })

  it('preserves exactly two or three unique valid application coordinates', () => {
    expect(decisionHandoff([APP_C, APP_A, APP_B])).toEqual({
      applicationIds: [APP_C, APP_A, APP_B],
    })
    expect(decisionHandoff([APP_B, APP_A])).toEqual({
      applicationIds: [APP_B, APP_A],
    })
  })

  it.each([
    [APP_A],
    [APP_A, APP_A],
    [APP_A, APP_B, APP_C, '444444444444444444444444'],
    [APP_A, 'not-an-application-id'],
  ])('fails closed on an invalid or mixed handoff: %j', (applicationIds) => {
    expect(decisionHandoff(applicationIds)).toEqual({
      applicationIds: [],
      error:
        'The comparison handoff was invalid. Select exactly two or three unique candidates again.',
    })
  })
})
