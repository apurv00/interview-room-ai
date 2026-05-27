import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {object} init
 */
export function createRunManifest(init) {
  return {
    version: 1,
    reportId: init.reportId,
    mode: init.mode,
    questions: init.questions,
    baseUrl: init.baseUrl,
    harnessVersion: init.harnessVersion ?? null,
    status: init.status ?? 'pending',
    startedAt: init.startedAt ?? new Date().toISOString(),
    finishedAt: null,
    passedRuns: null,
    totalRuns: null,
    error: null,
    resume: { offset: 0, completedCells: [], cellRetry: 1, quotaAborted: false },
  }
}

export function runOutputDir(reportId) {
  return join(root, 'output', 'runs', reportId)
}

export function manifestPath(reportId) {
  return join(runOutputDir(reportId), 'run-manifest.json')
}

export function loadManifest(reportId) {
  const path = manifestPath(reportId)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/**
 * @param {string} reportId
 * @param {Partial<ReturnType<typeof createRunManifest>>} patch
 */
export function saveManifest(reportId, patch) {
  const dir = runOutputDir(reportId)
  mkdirSync(dir, { recursive: true })
  const existing = loadManifest(reportId) ?? createRunManifest({ reportId, mode: 'unknown', questions: 0, baseUrl: '' })
  const next = { ...existing, ...patch }
  writeFileSync(manifestPath(reportId), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

export function defaultAuthPath(prod = false) {
  return join(root, '.auth', prod ? 'prod-qa.json' : 'local-qa.json')
}
