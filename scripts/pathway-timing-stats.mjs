#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { MongoClient, ObjectId } from 'mongodb'

const root = path.resolve(import.meta.dirname, '..')
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  if (!line.trim() || line.startsWith('#')) continue
  const eq = line.indexOf('=')
  if (eq === -1) continue
  const k = line.slice(0, eq).trim()
  let v = line.slice(eq + 1).trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))
    v = v.slice(1, -1)
  if (v && !process.env[k]) process.env[k] = v
}

const uri = process.env.MONGODB_URI_PROD || process.env.MONGODB_URI
const report = process.argv[2] || 'qa-browser-full-1779806117459'
const csvPath = path.join(root, 'modules/qa/output', `${report}-sessions.csv`)
const ids = fs
  .readFileSync(csvPath, 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split(',')[4])
  .filter((id) => /^[a-f0-9]{24}$/i.test(id))

const client = new MongoClient(uri)
await client.connect()
const col = client.db().collection('interviewsessions')
const docs = await col
  .find({
    _id: { $in: ids.map((id) => new ObjectId(id)) },
    pathwayGenerationStatus: 'succeeded',
  })
  .project({
    pathwayGenerationStartedAt: 1,
    pathwayGenerationCompletedAt: 1,
    completedAt: 1,
  })
  .toArray()

const jobDurations = []
const queueDelays = []
for (const d of docs) {
  if (d.pathwayGenerationStartedAt && d.pathwayGenerationCompletedAt) {
    jobDurations.push(
      (new Date(d.pathwayGenerationCompletedAt) - new Date(d.pathwayGenerationStartedAt)) / 1000,
    )
  }
  if (d.completedAt && d.pathwayGenerationStartedAt) {
    queueDelays.push(
      (new Date(d.pathwayGenerationStartedAt) - new Date(d.completedAt)) / 1000,
    )
  }
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length * (p / 100))] : null
}
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)

console.log(`Report: ${report}`)
console.log(`Succeeded pathway jobs: ${docs.length}/${ids.length}`)
console.log('Job wall time (mark-running → mark-completed):')
console.log(
  `  p50 ${pct(jobDurations, 50)?.toFixed(1)}s | p95 ${pct(jobDurations, 95)?.toFixed(1)}s | max ${Math.max(...jobDurations).toFixed(1)}s | avg ${avg(jobDurations).toFixed(1)}s`,
)
console.log('Queue delay (session completedAt → job startedAt):')
console.log(
  `  p50 ${pct(queueDelays, 50)?.toFixed(1)}s | p95 ${pct(queueDelays, 95)?.toFixed(1)}s | max ${Math.max(...queueDelays).toFixed(1)}s | avg ${avg(queueDelays).toFixed(1)}s`,
)
console.log(
  `End-to-end p50 (queue + job): ${((pct(queueDelays, 50) ?? 0) + (pct(jobDurations, 50) ?? 0)).toFixed(1)}s`,
)
await client.close()
