/**
 * Persist telemetry bundles from a matrix report to run output files.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeTelemetry } from './assertions.mjs'

/**
 * @param {string} outDir - e.g. modules/qa/output/runs/<reportId>
 * @param {import('./types.mjs').TelemetryBundle[]} telemetry
 */
export function writeTelemetryArtifacts(outDir, telemetry) {
  if (!telemetry?.length) return null

  mkdirSync(join(outDir, 'activities'), { recursive: true })

  const summary = summarizeTelemetry(telemetry)
  const jsonl = telemetry.map((t) => JSON.stringify(t)).join('\n') + '\n'
  writeFileSync(join(outDir, 'telemetry.jsonl'), jsonl, 'utf-8')
  writeFileSync(join(outDir, 'telemetry-summary.json'), JSON.stringify(summary, null, 2), 'utf-8')

  for (const bundle of telemetry) {
    const safe = bundle.activityId.replace(/[/\\:]/g, '__')
    writeFileSync(join(outDir, 'activities', safe + '.json'), JSON.stringify(bundle, null, 2), 'utf-8')
  }

  return summary
}

export function telemetryCsvRows(telemetry) {
  return telemetry.map((t) =>
    [
      t.activityId,
      t.matrixKey,
      t.stage,
      t.step,
      t.verdict,
      t.durationMs,
      t.apiResult?.status ?? '',
      t.sessionId ?? '',
      t.assertions.filter((a) => !a.pass).map((a) => a.id).join(';'),
    ].join(','),
  )
}

export { summarizeTelemetry }
