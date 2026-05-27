import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bakeStrongAnswersIntoRunner } from '../bakeRunnerStrongAnswers.mjs'

const runnerPath = join(process.cwd(), 'modules/qa/browser/qa-matrix-runner.js')

describe('bakeStrongAnswersIntoRunner', () => {
  it('inlines byBucket entries from strongAnswers.json', () => {
    const raw = readFileSync(runnerPath, 'utf8')
    const baked = bakeStrongAnswersIntoRunner(raw)
    expect(baked).toContain('"accessibility":')
    expect(baked).not.toMatch(/"byBucket":\{\}/)
  })
})
