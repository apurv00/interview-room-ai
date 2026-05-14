import { buildFailedAnswerEvaluation } from '@interview/hooks/useInterviewAPI'
import { useInterviewAPI } from '@interview/hooks/useInterviewAPI'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('useInterviewAPI fallback evaluations', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('marks timeout fallback scores as status="failed"', () => {
    const evaluation = buildFailedAnswerEvaluation('Question?', 'Answer', 2, {
      relevance: 50,
      structure: 50,
      specificity: 50,
      ownership: 50,
    }, {
      source: 'client',
      reason: 'client_timeout',
      timeoutMs: 10000,
      taskSlot: 'interview.evaluate-answer',
    })

    expect(evaluation).toMatchObject({
      questionIndex: 2,
      relevance: 50,
      structure: 50,
      specificity: 50,
      ownership: 50,
      status: 'failed',
      failure: {
        source: 'client',
        reason: 'client_timeout',
        timeoutMs: 10000,
        taskSlot: 'interview.evaluate-answer',
      },
      probeDecision: { shouldProbe: false },
    })
  })

  it('returns client_http_non_ok failure metadata when evaluate-answer is non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    const { result } = renderHook(() => useInterviewAPI({ config: { role: 'sdet', interviewType: 'behavioral' } as any }))
    const evaluation = await result.current.evaluateAnswer('Question?', 'Answer', 1)

    expect(evaluation).toMatchObject({
      questionIndex: 1,
      relevance: 60,
      structure: 55,
      specificity: 55,
      ownership: 60,
      status: 'failed',
      failure: {
        source: 'client',
        reason: 'client_http_non_ok',
        httpStatus: 503,
        taskSlot: 'interview.evaluate-answer',
      },
    })
  })

  it('returns client_fetch_error failure metadata when evaluate-answer fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { result } = renderHook(() => useInterviewAPI({ config: { role: 'sdet', interviewType: 'behavioral' } as any }))
    const evaluation = await result.current.evaluateAnswer('Question?', 'Answer', 1)

    expect(evaluation).toMatchObject({
      questionIndex: 1,
      status: 'failed',
      failure: {
        source: 'client',
        reason: 'client_fetch_error',
        message: 'network down',
        taskSlot: 'interview.evaluate-answer',
      },
    })
  })

  it('returns client_timeout failure metadata when evaluate-answer aborts on timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }),
    ))

    const { result } = renderHook(() => useInterviewAPI({ config: { role: 'sdet', interviewType: 'behavioral' } as any }))
    const promise = result.current.evaluateAnswer('Question?', 'Answer', 1, undefined, undefined, undefined, undefined, 25)

    await vi.advanceTimersByTimeAsync(25)
    const evaluation = await promise

    expect(evaluation).toMatchObject({
      questionIndex: 1,
      relevance: 50,
      structure: 50,
      specificity: 50,
      ownership: 50,
      status: 'failed',
      failure: {
        source: 'client',
        reason: 'client_timeout',
        timeoutMs: 25,
        taskSlot: 'interview.evaluate-answer',
      },
    })
  })
})
