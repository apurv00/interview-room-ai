import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MongoClient, ObjectId } from 'mongodb'
import { runOutputDir } from '../orchestrator/runManifest.mjs'

const REQUIRED_INNGEST_FUNCTIONS = [
  'pathway-regenerate',
  'analysis-job',
  'email-digest',
  'regenerate-plans',
]

/**
 * @param {string} reportId
 */
export function loadSessionIdsFromRun(reportId) {
  const reportPath = join(runOutputDir(reportId), 'matrix-report.json')
  if (!existsSync(reportPath)) {
    throw new Error(`Missing ${reportPath} — run matrix first`)
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
  return (report.runs ?? [])
    .map((r) => r.sessionId)
    .filter(Boolean)
}

/**
 * @param {object} opts
 * @param {string} opts.reportId
 * @param {string} [opts.mongoUri]
 * @param {boolean} [opts.prod]
 */
export async function verifyRunInfra(opts) {
  const { reportId, prod = false } = opts
  const mongoUri =
    opts.mongoUri ?? (prod ? process.env.MONGODB_URI_PROD : null) ?? process.env.MONGODB_URI
  const sessionIds = loadSessionIdsFromRun(reportId)
  const checks = []
  const outDir = runOutputDir(reportId)

  if (!mongoUri) {
    checks.push({
      id: 'mongo-uri',
      ok: false,
      severity: 'P0',
      message: prod
        ? 'MONGODB_URI_PROD or MONGODB_URI not set — cannot verify pathway status in prod Mongo'
        : 'MONGODB_URI not set — cannot verify pathway status in Mongo',
    })
  } else if (!sessionIds.length) {
    checks.push({
      id: 'session-ids',
      ok: false,
      severity: 'P1',
      message: 'No sessionIds in matrix-report.json',
    })
  } else {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 })
    try {
      await client.connect()
      const col = client.db().collection('interviewsessions')
      const oids = sessionIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)).map((id) => new ObjectId(id))
      const docs = await col
        .find({ _id: { $in: oids } })
        .project({
          pathwayGenerationStatus: 1,
          pathwayGenerationStartedAt: 1,
          pathwayGenerationAttempts: 1,
          pathwayGenerationError: 1,
          completedAt: 1,
        })
        .toArray()

      const byId = new Map(docs.map((d) => [d._id.toString(), d]))
      let succeeded = 0
      let pending = 0
      let failed = 0
      let missing = 0
      const stuck = []

      for (const sid of sessionIds) {
        const doc = byId.get(sid)
        if (!doc) {
          missing++
          continue
        }
        const st = doc.pathwayGenerationStatus ?? null
        if (st === 'succeeded' || st === 'skipped') succeeded++
        else if (st === 'failed') failed++
        else if (st === 'pending' || st === 'running' || st == null) {
          pending++
          const ageMin = doc.completedAt
            ? (Date.now() - new Date(doc.completedAt).getTime()) / 60_000
            : null
          if (st === 'pending' && (doc.pathwayGenerationAttempts ?? 0) === 0 && ageMin != null && ageMin > 5) {
            stuck.push({ sessionId: sid, ageMin: Math.round(ageMin), attempts: doc.pathwayGenerationAttempts ?? 0 })
          }
        }
      }

      const ok = pending === 0 && missing === 0 && failed === 0
      checks.push({
        id: 'pathway-mongo-batch',
        ok,
        severity: ok ? 'none' : pending > 0 || stuck.length ? 'P0' : 'P1',
        message: `pathway: ${succeeded} succeeded/skipped, ${pending} pending/running, ${failed} failed, ${missing} missing`,
        detail: { succeeded, pending, failed, missing, stuck, total: sessionIds.length },
      })
    } catch (err) {
      checks.push({
        id: 'pathway-mongo-batch',
        ok: false,
        severity: 'P0',
        message: `Mongo connection failed: ${err instanceof Error ? err.message : String(err)}`,
        detail: {
          hint: prod
            ? 'Set MONGODB_URI_PROD in .env.local to your Atlas prod cluster (read-only user recommended)'
            : 'Ensure MONGODB_URI points to a reachable cluster',
        },
      })
    } finally {
      await client.close().catch(() => {})
    }
  }

  if (prod) {
    checks.push({
      id: 'inngest-cloud-manual',
      ok: true,
      severity: 'none',
      message:
        'Verify Inngest Cloud dashboard: 8 functions including pathway-regenerate (automated API check requires signing key)',
      detail: { requiredFunctions: REQUIRED_INNGEST_FUNCTIONS },
    })
  }

  const failedChecks = checks.filter((c) => !c.ok)
  return {
    reportId,
    verifiedAt: new Date().toISOString(),
    ok: failedChecks.length === 0,
    checks,
    sessionCount: sessionIds.length,
    outDir,
  }
}
