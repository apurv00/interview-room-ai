import type { HarnessConfig, PersonaKind, SimulationStage } from '../agent/types'
import {
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  DEFAULT_PATHWAY_TIMEOUT_MS,
  DEFAULT_POLL_MS,
} from '../config/thresholds'

export interface CliArgs {
  dryRun: boolean
  mode: 'smoke' | 'full' | 'single'
  domain?: string
  depth?: string
  personas: PersonaKind[]
  stages: SimulationStage[]
  duration: number
  questions?: number
  concurrency: number
  outputDir: string
  baseUrl: string
}

export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    dryRun: false,
    mode: 'smoke',
    personas: ['strong', 'weak'],
    stages: ['interview', 'feedback', 'analysis', 'pathway', 'drill'],
    duration: 10,
    concurrency: 1,
    outputDir: 'modules/qa/output',
    baseUrl: process.env.QA_BASE_URL ?? 'http://localhost:3000',
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--mode' && next) {
      out.mode = next as CliArgs['mode']
      i++
    } else if (a === '--domain' && next) {
      out.domain = next
      i++
    } else if (a === '--depth' && next) {
      out.depth = next
      i++
    } else if (a === '--persona' && next) {
      out.personas = next.split(',') as PersonaKind[]
      i++
    } else if (a === '--stages' && next) {
      out.stages = next.split(',') as SimulationStage[]
      i++
    } else if (a === '--duration' && next) {
      out.duration = parseInt(next, 10)
      i++
    } else if (a === '--questions' && next) {
      out.questions = parseInt(next, 10)
      i++
    } else if (a === '--concurrency' && next) {
      out.concurrency = parseInt(next, 10)
      i++
    } else if (a === '--output' && next) {
      out.outputDir = next
      i++
    } else if (a === '--base-url' && next) {
      out.baseUrl = next
      i++
    } else if (a === '--full') out.mode = 'full'
    else if (a === '--smoke') out.mode = 'smoke'
  }

  if (out.mode === 'single' && !out.domain) {
    out.domain = 'pm'
    out.depth = out.depth ?? 'behavioral'
  }

  return out
}

export function buildHarnessConfig(args: CliArgs): HarnessConfig {
  const cookie = process.env.QA_SESSION_COOKIE
  if (!cookie && !args.dryRun) {
    throw new Error('QA_SESSION_COOKIE is required (NextAuth session cookie from signed-in browser)')
  }
  return {
    baseUrl: args.baseUrl,
    sessionCookie: cookie ?? '',
    duration: args.duration,
    experience: (process.env.QA_EXPERIENCE as HarnessConfig['experience']) ?? '3-6',
    questionLimit: args.questions,
    stages: args.stages,
    concurrency: args.concurrency,
    mode: args.mode,
    outputDir: args.outputDir,
    pollIntervalMs: parseInt(process.env.QA_POLL_MS ?? String(DEFAULT_POLL_MS), 10),
    analysisTimeoutMs: parseInt(process.env.QA_ANALYSIS_TIMEOUT_MS ?? String(DEFAULT_ANALYSIS_TIMEOUT_MS), 10),
    pathwayTimeoutMs: parseInt(process.env.QA_PATHWAY_TIMEOUT_MS ?? String(DEFAULT_PATHWAY_TIMEOUT_MS), 10),
    judgeEnabled: Boolean(process.env.QA_JUDGE_API_KEY),
  }
}
