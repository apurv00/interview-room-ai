import { describe, expect, it, vi } from 'vitest'

// Regression for legacy suite-load isolation: Phase-4 decision/export code
// must not transitively evaluate the broad Hire barrel (and its validators).
vi.mock('@hire', () => {
  throw new Error('Phase-4 decision boundary must not load the broad @hire barrel')
})
import {
  claimHireCandidatePiiWriteFence,
  claimNonTerminalHireApplicationDispatchFence,
  connectHireControlDB,
  decodeWorkspaceResourceCapability,
  encodeWorkspaceResourceCapability,
  withActiveHireWorkspaceWriteTransaction,
} from '@hire-decision-boundary'
import {
  buildHireDecisionView,
  buildSharePacketSnapshot,
  connectHireDecisionDB,
  hireAssessmentExportObjectKey,
  hireAssessmentExportStorage,
  requestHireAssessmentExport,
} from '@hire-decisions'

describe('Phase-4 public module boundaries', () => {
  it('uses the focused Hire decision boundary for control/transaction/capability seams', () => {
    expect(connectHireControlDB).toBeTypeOf('function')
    expect(withActiveHireWorkspaceWriteTransaction).toBeTypeOf('function')
    expect(claimHireCandidatePiiWriteFence).toBeTypeOf('function')
    expect(claimNonTerminalHireApplicationDispatchFence).toBeTypeOf('function')
    expect(encodeWorkspaceResourceCapability).toBeTypeOf('function')
    expect(decodeWorkspaceResourceCapability).toBeTypeOf('function')
  })

  it('exports the typed decision read and immutable snapshot constructors', () => {
    expect(connectHireDecisionDB).toBeTypeOf('function')
    expect(buildHireDecisionView).toBeTypeOf('function')
    expect(buildSharePacketSnapshot).toBeTypeOf('function')
  })

  it('exports a Hire-only private assessment export boundary without a signing surface', () => {
    expect(hireAssessmentExportObjectKey).toBeTypeOf('function')
    expect(hireAssessmentExportStorage.upload).toBeTypeOf('function')
    expect(hireAssessmentExportStorage.download).toBeTypeOf('function')
    expect(hireAssessmentExportStorage.delete).toBeTypeOf('function')
    expect((hireAssessmentExportStorage as Record<string, unknown>).signDownload).toBeUndefined()
    expect(requestHireAssessmentExport).toBeTypeOf('function')
  })
})
