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
  hireMultimodalAnalysisRecoveryJob: {
    id: "hire-multimodal-analysis-recovery",
  },
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
  hireRuntimeFeedbackRecoveryJob: { id: "hire-runtime-feedback-recovery" },
}));
vi.mock("@modules/hire-runtime/jobs/resultPublisherJob", () => ({
  hireRuntimeResultPublisherJob: { id: "hire-runtime-result-publisher" },
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

const sharedHireEnvironment = {
  MONGODB_URI: "mongodb://mongo.example/ipg-hire-control",
  REDIS_URL: "rediss://redis.example",
  HEALTH_CHECK_TOKEN: "health-secret",
  DEPLOYMENT_COMMIT_SHA: "a".repeat(40),
  HIRE_ENGINE_BRIDGE_KEY_ID: "hire-bridge-current",
  HIRE_ENGINE_BRIDGE_SECRET: "b".repeat(64),
  B2C_DATABASE_NAME: "ipg-b2c",
  HIRE_CONTROL_DATABASE_NAME: "ipg-hire-control",
  HIRE_RUNTIME_DATABASE_NAME: "ipg-hire-runtime",
  B2C_INNGEST_APP_ID: "ipg-b2c-production",
  HIRE_CONTROL_INNGEST_APP_ID: "ipg-hire-control-production",
  HIRE_RUNTIME_INNGEST_APP_ID: "ipg-hire-runtime-production",
  INNGEST_SIGNING_KEY: "signkey-test",
};

const controlHireEnvironment = {
  ...sharedHireEnvironment,
  IPG_SURFACE: "hire-control",
  INNGEST_APP_ID: "ipg-hire-control-production",
  INNGEST_EVENT_KEY: "event-key",
  NEXTAUTH_SECRET: "c".repeat(64),
  HIRE_HANDOFF_ISSUANCE_MODE: "open",
  HIRE_PUBLIC_URL: "https://hire.interviewprep.guru",
  HIRE_ENGINE_RUNTIME_URL: "https://engine.hire.interviewprep.guru",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "IPG Hire <hire@send.interviewprep.guru>",
  HIRE_INVITE_DELIVERY_KEY_ID: "invite-delivery-current",
  HIRE_INVITE_DELIVERY_KEY: Buffer.alloc(32, 7).toString("base64"),
  HIRE_ACCOUNT_BRIDGE_KEY_ID: "account-bridge-current",
  HIRE_ACCOUNT_BRIDGE_SECRET: "a".repeat(64),
  R2_ACCOUNT_ID: "control-account",
  R2_ACCESS_KEY_ID: "control-key",
  R2_SECRET_ACCESS_KEY: "control-secret",
  R2_BUCKET_NAME: "control-media",
  HIRE_RUNTIME_R2_ACCOUNT_ID: "runtime-account",
  HIRE_RUNTIME_R2_ACCESS_KEY_ID: "runtime-key",
  HIRE_RUNTIME_R2_SECRET_ACCESS_KEY: "runtime-secret",
  HIRE_RUNTIME_R2_BUCKET_NAME: "runtime-media",
};

const runtimeHireEnvironment = {
  ...sharedHireEnvironment,
  IPG_SURFACE: "hire-engine",
  MONGODB_URI: "mongodb://mongo.example/ipg-hire-runtime",
  INNGEST_APP_ID: "ipg-hire-runtime-production",
  INNGEST_EVENT_KEY: undefined,
  NEXTAUTH_SECRET: "middleware-secret".repeat(3),
  NEXTAUTH_URL: "https://engine.hire.interviewprep.guru",
  HIRE_RUNTIME_NEXTAUTH_SECRET: "r".repeat(64),
  HIRE_RUNTIME_FENCE_SECRET: "f".repeat(64),
  HIRE_CONTROL_URL: "https://hire.interviewprep.guru",
  HIRE_CONTROL_INTERNAL_URL: "https://hire.interviewprep.guru",
  HIRE_ENGINE_RUNTIME_URL: "https://engine.hire.interviewprep.guru",
  R2_ACCOUNT_ID: "runtime-account",
  R2_ACCESS_KEY_ID: "runtime-key",
  R2_SECRET_ACCESS_KEY: "runtime-secret",
  R2_BUCKET_NAME: "runtime-media",
  HIRE_RUNTIME_R2_ACCOUNT_ID: "runtime-account",
  HIRE_RUNTIME_R2_ACCESS_KEY_ID: "runtime-key",
  HIRE_RUNTIME_R2_SECRET_ACCESS_KEY: "runtime-secret",
  HIRE_RUNTIME_R2_BUCKET_NAME: "runtime-media",
  NEXT_PUBLIC_FEATURE_MULTIMODAL: "true",
};

async function withEnvironment(
  environment: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  try {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function expectUnavailableRoute(
  route: typeof import("../route"),
): Promise<void> {
  for (const handler of [route.GET, route.POST, route.PUT]) {
    const response = await (handler as unknown as () => Promise<Response>)();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
  }
  expect(mockServe).not.toHaveBeenCalled();
}

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
    await withEnvironment(controlHireEnvironment, async () => {
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
      expect(
        options.functions.filter((fn) => fn === hireMultimodalAnalysisJob),
      ).toHaveLength(1);
      expect(
        options.functions.filter(
          (fn) => fn === hireMultimodalAnalysisRecoveryJob,
        ),
      ).toHaveLength(1);
      expect(options.functions).toHaveLength(21);
      expect(options.functions).not.toContain(retentionJob);
    });
  });

  it("registers only Hire runtime jobs on the runtime surface", async () => {
    await withEnvironment(runtimeHireEnvironment, async () => {
      mockServe.mockClear();
      vi.resetModules();
      await import("../route");
      const options = mockServe.mock.calls[0][0] as {
        functions: Array<{ id: string }>;
      };
      expect(options.functions.map((fn) => fn.id)).toEqual([
        "hire-runtime-feedback-recovery",
        "hire-runtime-result-publisher",
        "hire-runtime-multimodal-observation-publisher",
        "hire-runtime-multimodal-analysis-publisher",
      ]);
    });
  });

  it.each([undefined, "ipg-b2c-production"])(
    "refuses Hire registration when INNGEST_APP_ID is %s",
    async (appId) => {
      await withEnvironment(
        { ...controlHireEnvironment, INNGEST_APP_ID: appId },
        async () => {
          mockServe.mockClear();
          vi.resetModules();
          const route = await import("../route");
          await expectUnavailableRoute(route);
        },
      );
    },
  );

  it.each([undefined, "hire-engnie", " hire-engine ", "   "])(
    "refuses registration for a Hire manifest with invalid surface %s",
    async (surface) => {
      const previousSurface = process.env.IPG_SURFACE;
      const previousControlDb = process.env.HIRE_CONTROL_DATABASE_NAME;
      const previousRuntimeDb = process.env.HIRE_RUNTIME_DATABASE_NAME;
      try {
        if (surface === undefined) delete process.env.IPG_SURFACE;
        else process.env.IPG_SURFACE = surface;
        process.env.HIRE_CONTROL_DATABASE_NAME = "ipg-hire-control";
        process.env.HIRE_RUNTIME_DATABASE_NAME = "ipg-hire-runtime";
        mockServe.mockClear();
        vi.resetModules();
        const route = await import("../route");
        await expectUnavailableRoute(route);
      } finally {
        if (previousSurface === undefined) delete process.env.IPG_SURFACE;
        else process.env.IPG_SURFACE = previousSurface;
        if (previousControlDb === undefined)
          delete process.env.HIRE_CONTROL_DATABASE_NAME;
        else process.env.HIRE_CONTROL_DATABASE_NAME = previousControlDb;
        if (previousRuntimeDb === undefined)
          delete process.env.HIRE_RUNTIME_DATABASE_NAME;
        else process.env.HIRE_RUNTIME_DATABASE_NAME = previousRuntimeDb;
      }
    },
  );

  it("refuses registration for a Hire-only manifest without DB markers", async () => {
    const previous = {
      surface: process.env.IPG_SURFACE,
      controlDb: process.env.HIRE_CONTROL_DATABASE_NAME,
      runtimeDb: process.env.HIRE_RUNTIME_DATABASE_NAME,
      runtimeUrl: process.env.HIRE_ENGINE_RUNTIME_URL,
    };
    try {
      delete process.env.IPG_SURFACE;
      delete process.env.HIRE_CONTROL_DATABASE_NAME;
      delete process.env.HIRE_RUNTIME_DATABASE_NAME;
      process.env.HIRE_ENGINE_RUNTIME_URL = "https://engine.example.test";
      mockServe.mockClear();
      vi.resetModules();
      const route = await import("../route");
      await expectUnavailableRoute(route);
    } finally {
      if (previous.surface === undefined) delete process.env.IPG_SURFACE;
      else process.env.IPG_SURFACE = previous.surface;
      if (previous.controlDb === undefined)
        delete process.env.HIRE_CONTROL_DATABASE_NAME;
      else process.env.HIRE_CONTROL_DATABASE_NAME = previous.controlDb;
      if (previous.runtimeDb === undefined)
        delete process.env.HIRE_RUNTIME_DATABASE_NAME;
      else process.env.HIRE_RUNTIME_DATABASE_NAME = previous.runtimeDb;
      if (previous.runtimeUrl === undefined)
        delete process.env.HIRE_ENGINE_RUNTIME_URL;
      else process.env.HIRE_ENGINE_RUNTIME_URL = previous.runtimeUrl;
    }
  });

  it("keeps B2C workers when the surface is explicitly B2C with Hire markers", async () => {
    const previousSurface = process.env.IPG_SURFACE;
    const previousControlDb = process.env.HIRE_CONTROL_DATABASE_NAME;
    try {
      process.env.IPG_SURFACE = "b2c";
      process.env.HIRE_CONTROL_DATABASE_NAME = "ipg-hire-control";
      mockServe.mockClear();
      vi.resetModules();
      await import("../route");
      const options = mockServe.mock.calls[0][0] as { functions: unknown[] };
      expect(options.functions).toContain(paymentRecoveryJob);
      expect(options.functions).toContain(retentionJob);
    } finally {
      if (previousSurface === undefined) delete process.env.IPG_SURFACE;
      else process.env.IPG_SURFACE = previousSurface;
      if (previousControlDb === undefined)
        delete process.env.HIRE_CONTROL_DATABASE_NAME;
      else process.env.HIRE_CONTROL_DATABASE_NAME = previousControlDb;
    }
  });
});
