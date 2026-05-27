import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mergeMatrixReports } from './retryPolicy.mjs'
import { runOutputDir } from './runManifest.mjs'
import { writeTelemetryArtifacts } from '../runner/telemetry.mjs'

/**
 * Merge shard matrix-report.json files into one parent run directory.
 * @param {string} parentReportId
 * @param {string[]} shardReportIds
 */
export function mergeShardReports(parentReportId, shardReportIds) {
  const outDir = runOutputDir(parentReportId)
  mkdirSync(outDir, { recursive: true })

  let merged = null
  for (const shardId of shardReportIds) {
    const path = join(runOutputDir(shardId), 'matrix-report.json')
    if (!existsSync(path)) {
      throw new Error(`Missing shard report: ${path}`)
    }
    const report = JSON.parse(readFileSync(path, 'utf-8'))
    merged = merged ? mergeMatrixReports(merged, report) : { ...report, reportId: parentReportId }
  }

  if (!merged) throw new Error('No shard reports to merge')

  merged.reportId = parentReportId
  merged.parallelShards = shardReportIds
  merged.mergedAt = new Date().toISOString()

  writeFileSync(join(outDir, 'matrix-report.json'), JSON.stringify(merged, null, 2), 'utf-8')

  if (merged.telemetry?.length) {
    writeTelemetryArtifacts(outDir, merged.telemetry)
  }

  return { outDir, report: merged }
}
