import { describe, expect, it, vi } from "vitest";

const {
  mockServe,
  paymentRecoveryJob,
  retentionJob,
  sourceValidateJob,
  trackerStatusSweepJob,
  hireLifecycleRetentionJob,
  hireIntakeRequestedJob,
  hireIntakeRecoveryJob,
  hireScreeningInvitationRequestedJob,
  hireScreeningInvitationRecoveryJob,
  hireHumanKitDeliveryRequestedJob,
  hireHumanKitDeliveryRecoveryJob,
  hireAssessmentExportRequestedJob,
  hireAssessmentExportRecoveryJob,
  hireReportExportRequestedJob,
  hireReportExportRecoveryJob,
  hireDailyDigestRequestedJob,
  hireDailyDigestScheduleJob,
  hireDailyDigestRecoveryJob,
  hireOnboardingTestDriveCleanupRequestedJob,
  hireOnboardingTestDriveCleanupRecoveryJob,
  hireRuntimeMultimodalAnalysisPublisherJob,
  hireMultimodalAnalysisJob,
  hireMultimodalAnalysisRecoveryJob,
} = vi.hoisted(() => ({
  mockServe: vi.fn(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() })),
  paymentRecoveryJob: { id: "payment-recovery-sentinel" },
  retentionJob: { id: "retention-sentinel" },
  sourceValidateJob: { id: "source-validate-sentinel" },
  trackerStatusSweepJob: { id: "tracker-status-sweep-sentinel" },
  hireLifecycleRetentionJob: { id: "hire-lifecycle-retention-sentinel" },
  hireIntakeRequestedJob: { id: "hire-intake-requested-sentinel" },
  hireIntakeRecoveryJob: { id: "hire-intake-recovery-sentinel" },
  hireScreeningInvitationRequestedJob: {
    id: "hire-screening-invitation-requested-sentinel",
  },
  hireScreeningInvitationRecoveryJob: {
    id: "hire-screening-invitation-recovery-sentinel",
  },
  hireHumanKitDeliveryRequestedJob: {
    id: "hire-human-kit-delivery-requested-sentinel",
  },
  hireHumanKitDeliveryRecoveryJob: {
    id: "hire-human-kit-delivery-recovery-sentinel",
  },
  hireAssessmentExportRequestedJob: {
    id: "hire-assessment-export-requested-sentinel",
  },
  hireAssessmentExportRecoveryJob: {
    id: "hire-assessment-export-recovery-sentinel",
  },
  hireReportExportRequestedJob: { id: "hire-report-export-requested-sentinel" },
  hireReportExportRecoveryJob: { id: "hire-report-export-recovery-sentinel" },
  hireDailyDigestRequestedJob: { id: "hire-daily-digest-requested-sentinel" },
  hireDailyDigestScheduleJob: { id: "hire-daily-digest-schedule-sentinel" },
  hireDailyDigestRecoveryJob: { id: "hire-daily-digest-recovery-sentinel" },
  hireOnboardingTestDriveCleanupRequestedJob: {
    id: "hire-onboarding-test-drive-cleanup-requested-sentinel",
  },
  hireOnboardingTestDriveCleanupRecoveryJob: {
    id: "hire-onboarding-test-drive-cleanup-recovery-sentinel",
  },
  hireRuntimeMultimodalAnalysisPublisherJob: {
    id: "hire-runtime-multimodal-analysis-publisher",
  },
  hireMultimodalAnalysisJob: { id: "hire-multimodal-analysis" },
  hireMultimodalAnalysisRecoveryJob: { id: "hire-multimodal-analysis-recovery" },
}));

vi.mock("inngest/next", () => ({ serve: mockServe }));
vi.mock("@shared/services/inngest", () => ({ inngest: { id: "client" } }));
vi.mock("@interview/jobs/analysisJob", () => ({
  analysisJob: { id: "analysis" },
}));
vi.mock("@interview/jobs/enrichFeedbackJob", () => ({
  enrichFeedbackJob: { id: "feedback" },
}));
vi.mock("@learn/jobs/emailDigestJob", () => ({
  emailDigestJob: { id: "digest" },
}));
vi.mock("@learn/jobs/regeneratePlansJob", () => ({
  regeneratePlansJob: { id: "plans" },
}));
vi.mock("@learn/jobs/keepMongoWarm", () => ({
  keepMongoWarmJob: { id: "warm" },
}));
vi.mock("@interview/jobs/recordingRetentionJob", () => ({
  recordingRetentionJob: { id: "recording-retention" },
}));
vi.mock("@learn/jobs/pathwayJob", () => ({ pathwayJob: { id: "pathway" } }));
vi.mock("@jobs/jobs/ingestJobs", () => ({
  jobsIngestSchedulerJob: { id: "ingest" },
  jobsSourceSyncJob: { id: "sync" },
  jobsSourceValidateJob: sourceValidateJob,
  jobsBoardProbeJob: { id: "board" },
}));
vi.mock("@jobs/jobs/evaluatePostingsJob", () => ({
  jobsEvaluatePostingsJob: { id: "evaluate" },
  jobsVerdictSweeperJob: { id: "verdict" },
}));
vi.mock("@jobs/jobs/atsCheckJob", () => ({ jobsAtsCheckJob: { id: "ats" } }));
vi.mock("@jobs/jobs/emailJobs", () => ({
  jobsEmailE0Job: { id: "email-e0" },
  jobsEmailSweepJob: { id: "email-sweep" },
}));
vi.mock("@jobs/jobs/evidenceAttributionJob", () => ({
  jobsEvidenceAttributionJob: { id: "evidence" },
  jobsEvidenceReconcileJob: { id: "evidence-reconcile" },
}));
vi.mock("@jobs/jobs/linkCheckJobs", () => ({
  jobsLinkCheckJob: { id: "link-check" },
}));
vi.mock("@jobs/jobs/retentionSweepJob", () => ({
  jobsRetentionSweepJob: retentionJob,
}));
vi.mock("@jobs/jobs/trackerStatusSweepJob", () => ({
  jobsTrackerStatusSweepJob: trackerStatusSweepJob,
}));
vi.mock("@payments/jobs/paymentRecoveryJob", () => ({ paymentRecoveryJob }));
vi.mock("@hire/jobs/emailOutboxJob", () => ({
  hireEmailOutboxJob: { id: "hire-email" },
}));
vi.mock("@hire/jobs/mediaRetentionJob", () => ({
  hireMediaRetentionJob: { id: "hire-media" },
}));
vi.mock("@hire/jobs/engineRevocationJob", () => ({
  hireEngineRevocationJob: { id: "hire-revoke" },
}));
vi.mock("@hire/jobs/lifecycleRetentionJob", () => ({
  hireLifecycleRetentionJob,
}));
vi.mock("@hire/jobs/intakeJob", () => ({
  hireIntakeRequestedJob,
  hireIntakeRecoveryJob,
}));
vi.mock("@hire/jobs/screeningInvitationJob", () => ({
  hireScreeningInvitationRequestedJob,
  hireScreeningInvitationRecoveryJob,
}));
vi.mock("@hire/jobs/humanKitDeliveryJob", () => ({
  hireHumanKitDeliveryRequestedJob,
  hireHumanKitDeliveryRecoveryJob,
}));
vi.mock("@hire-decisions/jobs/hireAssessmentExportJob", () => ({
  hireAssessmentExportRequestedJob,
  hireAssessmentExportRecoveryJob,
}));
vi.mock("@/modules/hire-reports/jobs/hireReportExportJob", () => ({
  hireReportExportRequestedJob,
  hireReportExportRecoveryJob,
}));
vi.mock("@/modules/hire-digest/jobs/hireDigestJob", () => ({
  hireDailyDigestRequestedJob,
  hireDailyDigestScheduleJob,
  hireDailyDigestRecoveryJob,
}));
vi.mock("@/modules/hire-onboarding/jobs/testDriveCleanupJob", () => ({
  hireOnboardingTestDriveCleanupRequestedJob,
  hireOnboardingTestDriveCleanupRecoveryJob,
}));
vi.mock("@modules/hire-runtime/jobs/feedbackRecoveryJob", () => ({
  hireRuntimeFeedbackRecoveryJob: { id: "hire-runtime-feedback" },
}));
vi.mock("@modules/hire-runtime/jobs/resultPublisherJob", () => ({
  hireRuntimeResultPublisherJob: { id: "hire-runtime-result" },
}));
vi.mock("@modules/hire-runtime/jobs/multimodalObservationPublisherJob", () => ({
  hireRuntimeMultimodalObservationPublisherJob: {
    id: "hire-runtime-multimodal-observation-publisher",
  },
}));
vi.mock("@modules/hire-runtime/jobs/multimodalAnalysisPublisherJob", () => ({
  hireRuntimeMultimodalAnalysisPublisherJob,
}));
vi.mock("@modules/hire-multimodal/jobs/hireMultimodalAnalysisJob", () => ({
  hireMultimodalAnalysisJob,
  hireMultimodalAnalysisRecoveryJob,
}));

import "../route";

describe("Inngest route registration", () => {
  it("serves the Jobs retention sweep exactly once", () => {
    expect(mockServe).toHaveBeenCalledOnce();
    const options = mockServe.mock.calls[0][0] as { functions: unknown[] };
    expect(options.functions.filter((fn) => fn === retentionJob)).toHaveLength(
      1,
    );
  });

  it("serves the Jobs tracker status sweep exactly once", () => {
    expect(mockServe).toHaveBeenCalledOnce();
    const options = mockServe.mock.calls[0][0] as { functions: unknown[] };
    expect(
      options.functions.filter((fn) => fn === trackerStatusSweepJob),
    ).toHaveLength(1);
  });

  it("serves the Jobs source validation worker exactly once", () => {
    expect(mockServe).toHaveBeenCalledOnce();
    const options = mockServe.mock.calls[0][0] as { functions: unknown[] };
    expect(
      options.functions.filter((fn) => fn === sourceValidateJob),
    ).toHaveLength(1);
  });

  it("serves the payment recovery worker exactly once", () => {
    expect(mockServe).toHaveBeenCalledOnce();
    const options = mockServe.mock.calls[0][0] as { functions: unknown[] };
    expect(
      options.functions.filter((fn) => fn === paymentRecoveryJob),
    ).toHaveLength(1);
  });

  it("registers lifecycle retention only on the Hire control surface", async () => {
    const previousSurface = process.env.IPG_SURFACE;
    try {
      process.env.IPG_SURFACE = "hire-control";
      mockServe.mockClear();
      vi.resetModules();
      await import("../route");
      const options = mockServe.mock.calls[0][0] as { functions: unknown[] };
      expect(
        options.functions.filter((fn) => fn === hireLifecycleRetentionJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter((fn) => fn === hireIntakeRequestedJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter((fn) => fn === hireIntakeRecoveryJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireScreeningInvitationRequestedJob,
        ),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireScreeningInvitationRecoveryJob,
        ),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireHumanKitDeliveryRequestedJob,
        ),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireHumanKitDeliveryRecoveryJob,
        ),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireAssessmentExportRequestedJob,
        ),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireAssessmentExportRecoveryJob,
        ),
      ).toHaveLength(1);
      expect(
        options.functions.filter((fn) => fn === hireReportExportRequestedJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter((fn) => fn === hireReportExportRecoveryJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter((fn) => fn === hireDailyDigestRequestedJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter((fn) => fn === hireDailyDigestScheduleJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter((fn) => fn === hireDailyDigestRecoveryJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireOnboardingTestDriveCleanupRequestedJob,
        ),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireOnboardingTestDriveCleanupRecoveryJob,
        ),
      ).toHaveLength(1);
      expect(options.functions).toHaveLength(21);
      expect(options.functions).not.toContain(retentionJob);
    } finally {
      if (previousSurface === undefined) delete process.env.IPG_SURFACE;
      else process.env.IPG_SURFACE = previousSurface;
    }
  });

  it("registers only Hire runtime jobs on the runtime surface", async () => {
    const previousSurface = process.env.IPG_SURFACE;
    try {
      process.env.IPG_SURFACE = "hire-engine";
      mockServe.mockClear();
      vi.resetModules();
      await import("../route");
      const options = mockServe.mock.calls[0][0] as {
        functions: Array<{ id: string }>;
      };
      expect(options.functions.map((fn) => fn.id)).toEqual([
        "hire-runtime-feedback",
        "hire-runtime-result",
        "hire-runtime-multimodal-observation-publisher",
        "hire-runtime-multimodal-analysis-publisher",
      ]);
    } finally {
      if (previousSurface === undefined) delete process.env.IPG_SURFACE;
      else process.env.IPG_SURFACE = previousSurface;
    }
  });
});
