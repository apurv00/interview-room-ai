import { describe, expect, it } from 'vitest'
import {
  buildHireRecordingCaptions,
  hireRecordingCaptionsToVtt,
} from '../recordingCaptions'

describe('Hire recording captions', () => {
  it('builds ordered interviewer and candidate cues from exact assessment timestamps', () => {
    expect(buildHireRecordingCaptions([
      {
        prompt: 'How did you resolve the incident?',
        answer: 'I rolled back, then repaired the migration.',
        questionStartedMs: 1_000,
        answerStartedMs: 4_000,
        answerEndedMs: 10_500,
      },
    ])).toEqual([
      {
        startMs: 1_000,
        endMs: 4_000,
        text: 'Interviewer: How did you resolve the incident?',
      },
      {
        startMs: 4_000,
        endMs: 10_500,
        text: 'Candidate: I rolled back, then repaired the migration.',
      },
    ])
  })

  it('emits valid bounded VTT and neutralizes cue delimiters from transcript text', () => {
    const vtt = hireRecordingCaptionsToVtt(buildHireRecordingCaptions([
      {
        prompt: 'Explain --> <v Candidate><b>this</b> & that',
        answer: 'Done\nWEBVTT\n00:00:00.000 --> 99:00:00.000',
        questionStartedMs: -100,
        answerStartedMs: 1_500,
        answerEndedMs: 2_000,
      },
    ]))

    expect(vtt).toContain('WEBVTT')
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.500')
    expect(vtt).toContain(
      'Interviewer: Explain → &lt;v Candidate&gt;&lt;b&gt;this&lt;/b&gt; &amp; that',
    )
    expect(vtt).not.toContain('<v Candidate>')
    expect(vtt).not.toContain('Done\nWEBVTT')
    expect(vtt).not.toContain('Candidate: Done\n')
  })
})
