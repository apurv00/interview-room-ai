import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(moduleRoot, 'config', 'strongAnswers.json')

const STRONG_CONFIG_RE =
  /const STRONG_ANSWERS_CONFIG = [\s\S]*?\n  function pickStrongAnswer/

/**
 * Inline strongAnswers.json into qa-matrix-runner.js source (Playwright + inject build).
 * @param {string} runnerSource
 * @returns {string}
 */
export function bakeStrongAnswersIntoRunner(runnerSource) {
  const strongConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  const bucketCount = Object.keys(strongConfig.byBucket ?? {}).length
  if (bucketCount === 0) {
    throw new Error(
      'strongAnswers.json has empty byBucket — run npm run qa:validate:answers or fix config',
    )
  }
  if (!STRONG_CONFIG_RE.test(runnerSource)) {
    throw new Error(
      'qa-matrix-runner.js missing STRONG_ANSWERS_CONFIG marker — cannot bake strong answers',
    )
  }
  return runnerSource.replace(
    STRONG_CONFIG_RE,
    `const STRONG_ANSWERS_CONFIG = ${JSON.stringify(strongConfig)}\n  function pickStrongAnswer`,
  )
}
