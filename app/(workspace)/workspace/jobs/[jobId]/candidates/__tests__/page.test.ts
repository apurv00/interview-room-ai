import { describe, expect, it } from 'vitest'
import JobCandidatesPage from '../page'

describe('candidate workspace page boundary', () => {
  it('keys the client workspace to the job boundary', async () => {
    const jobId = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    const page = await JobCandidatesPage({
      params: Promise.resolve({ jobId }),
    })

    expect(page.props.children.key).toBe(jobId)
  })
})
