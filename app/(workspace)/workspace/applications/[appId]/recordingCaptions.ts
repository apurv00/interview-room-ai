export interface HireRecordingCaptionSource {
  prompt: string
  answer?: string
  questionStartedMs?: number
  answerStartedMs?: number
  answerEndedMs?: number
}

export interface HireRecordingCaption {
  startMs: number
  endMs: number
  text: string
}

const MAX_RECORDING_MS = 30 * 60 * 1_000
const MAX_CUE_TEXT = 4_000

function boundedTime(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(MAX_RECORDING_MS, Math.round(value)))
}

function cueText(speaker: 'Interviewer' | 'Candidate', value: string): string {
  const normalized = value
    .replaceAll('\0', '')
    .replaceAll('-->', '→')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CUE_TEXT)
  return `${speaker}: ${normalized}`
}

export function buildHireRecordingCaptions(
  questions: HireRecordingCaptionSource[],
): HireRecordingCaption[] {
  const cues: HireRecordingCaption[] = []
  for (const question of questions) {
    const questionStart = boundedTime(question.questionStartedMs)
    const answerStart = boundedTime(question.answerStartedMs)
    const answerEnd = boundedTime(question.answerEndedMs)
    if (
      questionStart !== null &&
      answerStart !== null &&
      answerStart > questionStart &&
      question.prompt.trim()
    ) {
      cues.push({
        startMs: questionStart,
        endMs: answerStart,
        text: cueText('Interviewer', question.prompt),
      })
    }
    if (
      answerStart !== null &&
      answerEnd !== null &&
      answerEnd > answerStart &&
      question.answer?.trim()
    ) {
      cues.push({
        startMs: answerStart,
        endMs: answerEnd,
        text: cueText('Candidate', question.answer),
      })
    }
  }
  return cues.sort((left, right) => left.startMs - right.startMs)
}

function vttTime(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const millis = total % 1_000
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':') + `.${String(millis).padStart(3, '0')}`
}

function vttCueText(value: string): string {
  return value
    .replaceAll('\0', '')
    .replaceAll('-->', '→')
    .replace(/\s+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .trim()
    .slice(0, MAX_CUE_TEXT + 20)
}

export function hireRecordingCaptionsToVtt(
  captions: HireRecordingCaption[],
): string {
  return [
    'WEBVTT',
    '',
    ...captions.flatMap((caption, index) => [
      String(index + 1),
      `${vttTime(caption.startMs)} --> ${vttTime(caption.endMs)}`,
      vttCueText(caption.text),
      '',
    ]),
  ].join('\n')
}

export const __recordingCaptions = { vttTime, vttCueText }
