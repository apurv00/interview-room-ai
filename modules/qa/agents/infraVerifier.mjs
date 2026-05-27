import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MongoClient, ObjectId } from 'mongodb'
import { runOutputDir } from '../orchestrator/runManifest.mjs'
import { checkInngestEndpoint, CRITICAL_FUNCTION_IDS } from './inngestCheck.mjs'

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
 * @param {string} [opts.baseUrl]
 * @param {boolean} [opts.prod]
 */
export async function verifyRunInfra(opts) {
  const { reportId, prod = false } = opts
  const baseUrl = opts.baseUrl ?? (prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000')
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

  if (mongoUri && sessionIds.length) {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 })
    try {
      await client.connect()
      const col = client.db().collection('multimodalanalyses')
      const oids = sessionIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)).map((id) => new ObjectId(id))
      const docs = await col
        .find({ sessionId: { $in: oids } })
        .project({ status: 1, sessionId: 1, error: 1 })
        .toArray()

      let failed = 0
      let completed = 0
      let pending = 0
      let missing = sessionIds.length

      const bySession = new Map(docs.map((d) => [d.sessionId.toString(), d]))
      for (const sid of sessionIds) {
        const doc = bySession.get(sid)
        if (!doc) continue
        missing--
        const st = doc.status
        if (st === 'failed') failed++
        else if (st === 'completed') completed++
        else pending++
      }

      const analyzed = failed + completed + pending
      const failRate = analyzed > 0 ? failed / analyzed : 0
      const ok = failRate <= 0.05 && missing <= Math.ceil(sessionIds.length * 0.5)

      checks.push({
        id: 'analysis-failure-rate',
        ok,
        severity: ok ? 'none' : failRate > 0.05 ? 'P1' : 'P2',
        message: `Multimodal analysis: ${completed} completed, ${failed} failed, ${pending} pending, ${missing} no record (fail rate ${Math.round(failRate * 100)}%)`,
        detail: { completed, failed, pending, missing, failRate, analyzed, total: sessionIds.length },
      })
    } catch (err) {
      checks.push({
        id: 'analysis-failure-rate',
        ok: false,
        severity: 'P2',
        message: `Analysis batch query failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      await client.close().catch(() => {})
    }
  }

  try {
    const inngestCheck = await checkInngestEndpoint({ baseUrl })
    checks.push(inngestCheck)
  } catch (err) {
    checks.push({
      id: 'inngest-endpoint',
      ok: false,
      severity: prod ? 'P0' : 'P1',
      message: `Inngest check failed: ${err instanceof Error ? err.message : String(err)}`,
      detail: { criticalFunctions: CRITICAL_FUNCTION_IDS },
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
