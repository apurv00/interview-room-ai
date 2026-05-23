/**
 * @qa — External QA agent module (black-box HTTP harness).
 * Must not be imported by product modules (interview, learn, feedback, resume).
 */

export type {
  MatrixReport,
  SimulationRunResult,
  SimulationStage,
  PersonaKind,
  InterviewDepth,
  RouteCallRecord,
  QuestionEvaluationRecord,
} from './agent/types'

export { buildMatrixCells, buildRunPlan, SMOKE_CELLS } from './config/matrix'
export { buildMatrixReport, writeReports, formatMarkdownReport, PHASES } from './report/reportBuilder'
export { parseCliArgs, buildHarnessConfig } from './cli/parseArgs'
export { QaHttpClient, verifyAuth } from './client/httpClient'
export { runSingleSimulation, runMatrixWithConcurrency } from './agent/orchestrator'
export { synthesizeLiveWords } from './runners/interviewRunner'
