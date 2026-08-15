/** Phase 5 report-domain contracts. Lifecycle, routes, and jobs remain separate. */
export * from './types'
export * from './models'
export * from './validators/hireReports'
export * from './services/reportSnapshotBuilders'
export {
  HirePipelineStatusReport,
  type HirePipelineStatusReportProps,
} from './components/HirePipelineStatusReport'
export {
  HireJobCloseoutReport,
  type HireJobCloseoutReportProps,
} from './components/HireJobCloseoutReport'
export { connectHireReportDB } from './services/hireReportBoundary'
export {
  generateHireReportPdf,
  hireReportPdfFilename,
  renderHireReportHtml,
  type ChromiumLaunch,
} from './services/hireReportPdfService'
export {
  generateHireReportXlsx,
  hireReportXlsxFilename,
  neutralizeHireReportSpreadsheetText,
} from './services/hireReportXlsxService'
export {
  hireReportExportStorage,
  isHireReportExportStorageConfigured,
  HIRE_REPORT_EXPORT_CONTENT_TYPES,
  type HireReportExportStoragePort,
} from './services/hireReportExportStorage'
export {
  createHireJobCloseoutReport,
  dispatchHireReportExport,
  downloadHireReportExport,
  getHireReportExportStatus,
  kickHireReportExport,
  listHireReportExports,
  listDueHireReportExportIds,
  listHireReportExportWorkspaceIdsForSweep,
  markHireReportExportCancelledForLifecycle,
  processHireReportExport,
  requestHirePipelineStatusReport,
  HIRE_REPORT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE,
  type CreateHireJobCloseoutReportInput,
  type HirePipelineStatusSnapshotFactory,
  type HireReportExportDownload,
  type HireReportExportMemberView,
  type HireReportExportProcessResult,
  type HireReportExportRequestResult,
  type HireReportRequesterActor,
  type RequestHirePipelineStatusReportInput,
} from './services/hireReportExportService'
export {
  buildHirePipelineStatusReportSnapshotFromControlRecords,
  buildHirePipelineStatusReportSnapshotFromSafeRows,
} from './services/hirePipelineStatusReportSnapshotFactory'
export {
  buildHireJobCloseoutReportSnapshotInputFromControlRecords,
} from './services/hireJobCloseoutReportSnapshotFactory'
export {
  cancelHireReportExportsForLifecycle,
  cancelHirePipelineStatusReportsForTerminalTransition,
  createHireJobCloseoutReportForLifecycle,
  type HireReportCloseoutLifecycleJob,
  type HireReportLifecycleScope,
} from './services/hireReportLifecycleService'
export {
  ensureHireReportExportCleanupTombstone,
  listDueHireReportExportCleanupIds,
  processHireReportExportCleanup,
  hireReportExportCleanupNotBeforeAt,
  type HireReportExportCleanupProcessResult,
} from './services/hireReportExportCleanupService'
