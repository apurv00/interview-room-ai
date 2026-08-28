import { describe, expect, it } from 'vitest'
import JobScreeningPage from '../page'

describe('screening workspace page boundary', () => {
  it('keys the client workspace to the job boundary', async () => {
    const jobId = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    const page = await JobScreeningPage({
      params: Promise.resolve({ jobId }),
    })

    expect(page.props.children[2].key).toBe(jobId)
  })
})
