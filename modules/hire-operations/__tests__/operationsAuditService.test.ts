import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectHireControlDB: vi.fn(),
  testDriveExclusionStages: vi.fn(),
  candidateAggregate: vi.fn(),
  privacyRequestFind: vi.fn(),
  privacyFilter: vi.fn(),
  applicationAggregate: vi.fn(),
  jobAggregate: vi.fn(),
  reportAggregate: vi.fn(),
  statusLinkAggregate: vi.fn(),
  digestOutboxAggregate: vi.fn(),
  onboardingTestDriveAggregate: vi.fn(),
}));

function privacyRequestMatchesFilter(
  filter: Record<string, any>,
  request: { status: string; verificationExpiresAt: Date },
): boolean {
  if (filter.live !== true) return false;
  if (!Array.isArray(filter.$or)) return true;
  return filter.$or.some((condition: Record<string, any>) => {
    if (condition.status !== request.status) return false;
    if (!condition.verificationExpiresAt) return true;
    return request.verificationExpiresAt > condition.verificationExpiresAt.$gt;
  });
}

vi.mock("@hire-operations-boundary", () => ({
  connectHireControlDB: mocks.connectHireControlDB,
  HireCandidate: { aggregate: mocks.candidateAggregate },
  HirePrivacyRequest: { find: mocks.privacyRequestFind },
  activeHirePrivacyRequestFilter: mocks.privacyFilter,
  HireApplication: { aggregate: mocks.applicationAggregate },
  HireJob: { aggregate: mocks.jobAggregate },
}));

vi.mock("@/modules/hire-reports/models/HireReportExport", () => ({
  HireReportExport: { aggregate: mocks.reportAggregate },
}));

vi.mock("@/modules/hire-status/models/HireCandidateStatusLink", () => ({
  HireCandidateStatusLink: { aggregate: mocks.statusLinkAggregate },
}));

vi.mock("@/modules/hire-digest/models/HireDigestOutbox", () => ({
  HireDigestOutbox: { aggregate: mocks.digestOutboxAggregate },
}));

vi.mock("@/modules/hire-onboarding/models/HireOnboardingTestDrive", () => ({
  HireOnboardingTestDrive: { aggregate: mocks.onboardingTestDriveAggregate },
}));

vi.mock("@/modules/hire-onboarding/services/testDriveService", () => ({
  buildHireOnboardingTestDriveExclusionStages: mocks.testDriveExclusionStages,
}));

import {
  HireOperationsAuditError,
  parseHireOperationsAuditCursor,
  readHireWorkspaceAudit,
} from "../services/operationsAuditService";

const WORKSPACE_ID = "1".repeat(24);
const FOREIGN_WORKSPACE_ID = "2".repeat(24);
const ACTIVE_CANDIDATE_ID = "3".repeat(24);
const ANONYMIZED_CANDIDATE_ID = "4".repeat(24);
const APPLICATION_ID = "5".repeat(24);
const ANONYMIZED_APPLICATION_ID = "6".repeat(24);
const JOB_ID = "7".repeat(24);
const FOREIGN_JOB_ID = "8".repeat(24);
const REPORT_ID = "9".repeat(24);
const REDACTED_REPORT_ID = "a".repeat(24);
const STATUS_LINK_ID = "b".repeat(24);
const ANONYMIZED_STATUS_LINK_ID = "c".repeat(24);
const PRIVACY_PENDING_CANDIDATE_ID = "d".repeat(24);
const PRIVACY_PENDING_APPLICATION_ID = "e".repeat(24);
const PRIVACY_PENDING_STATUS_LINK_ID = "f".repeat(24);
const DIGEST_OUTBOX_ID = "0".repeat(24);
const TEST_DRIVE_ID = "e".repeat(24);

function query<T>(value: T) {
  const result = {
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  };
  result.select.mockReturnValue(result);
  return result;
}

function applicationEvent(overrides: Record<string, unknown> = {}) {
  return {
    auditId: `application:${APPLICATION_ID}:0`,
    workspaceId: WORKSPACE_ID,
    candidateId: ACTIVE_CANDIDATE_ID,
    source: "application",
    eventType: "stage_move",
    occurredAt: new Date("2026-08-10T12:00:00.000Z"),
    actorName: "Hiring Admin",
    targetId: APPLICATION_ID,
    ...overrides,
  };
}

function jobEvent(overrides: Record<string, unknown> = {}) {
  return {
    auditId: `job:${JOB_ID}:0`,
    workspaceId: WORKSPACE_ID,
    source: "job",
    eventType: "status_change",
    occurredAt: new Date("2026-08-11T12:00:00.000Z"),
    actorName: "System",
    targetId: JOB_ID,
    ...overrides,
  };
}

function reportEvent(overrides: Record<string, unknown> = {}) {
  return {
    auditId: `report:${REPORT_ID}:0`,
    workspaceId: WORKSPACE_ID,
    source: "report",
    eventType: "ready",
    occurredAt: new Date("2026-08-12T12:00:00.000Z"),
    targetId: REPORT_ID,
    ...overrides,
  };
}

function statusLinkEvent(overrides: Record<string, unknown> = {}) {
  return {
    auditId: `status_link:${STATUS_LINK_ID}:0`,
    workspaceId: WORKSPACE_ID,
    candidateId: ACTIVE_CANDIDATE_ID,
    source: "status_link",
    eventType: "issued",
    occurredAt: new Date("2026-08-13T12:00:00.000Z"),
    actorName: "Hiring Admin",
    targetId: STATUS_LINK_ID,
    ...overrides,
  };
}

function digestOutboxEvent(overrides: Record<string, unknown> = {}) {
  return {
    auditId: `digest_outbox:${DIGEST_OUTBOX_ID}:1`,
    workspaceId: WORKSPACE_ID,
    source: "digest_outbox",
    eventType: "sent",
    occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    targetId: DIGEST_OUTBOX_ID,
    ...overrides,
  };
}

function onboardingTestDriveEvent(overrides: Record<string, unknown> = {}) {
  return {
    auditId: `onboarding_test_drive:${TEST_DRIVE_ID}:0`,
    workspaceId: WORKSPACE_ID,
    source: "onboarding_test_drive",
    eventType: "started",
    occurredAt: new Date("2026-08-15T12:00:00.000Z"),
    actorName: "Onboarding Member",
    targetId: TEST_DRIVE_ID,
    ...overrides,
  };
}

describe("Phase-5 operations audit projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectHireControlDB.mockResolvedValue(undefined);
    mocks.testDriveExclusionStages.mockImplementation((input) => [
      {
        $lookup: {
          from: "hireonboardingtestdrives",
          as: `__testDrive_${input.coordinate}`,
        },
      },
      { $match: { [`__testDrive_${input.coordinate}.0`]: { $exists: false } } },
    ]);
    mocks.candidateAggregate.mockResolvedValue([{ _id: ACTIVE_CANDIDATE_ID }]);
    mocks.privacyRequestFind.mockReturnValue(query([]));
    mocks.privacyFilter.mockImplementation((now: Date) => ({
      live: true,
      $or: [
        { status: "processing" },
        { status: "pending_verification", verificationExpiresAt: { $gt: now } },
      ],
    }));
    mocks.applicationAggregate.mockResolvedValue([]);
    mocks.jobAggregate.mockResolvedValue([]);
    mocks.reportAggregate.mockResolvedValue([]);
    mocks.statusLinkAggregate.mockResolvedValue([]);
    mocks.digestOutboxAggregate.mockResolvedValue([]);
    mocks.onboardingTestDriveAggregate.mockResolvedValue([]);
  });

  it("keeps expired verifications but returns only allowlisted, workspace-scoped safe event DTOs", async () => {
    mocks.candidateAggregate.mockResolvedValue([
      { _id: ACTIVE_CANDIDATE_ID },
      { _id: PRIVACY_PENDING_CANDIDATE_ID },
    ]);
    const requests = [
      {
        candidateId: ACTIVE_CANDIDATE_ID,
        status: "pending_verification",
        verificationExpiresAt: new Date("2026-08-14T00:00:00.000Z"),
      },
      {
        candidateId: PRIVACY_PENDING_CANDIDATE_ID,
        status: "processing",
        verificationExpiresAt: new Date("2026-08-16T00:00:00.000Z"),
      },
    ];
    mocks.privacyRequestFind.mockImplementation((filter: Record<string, any>) =>
      query(
        requests
          .filter((request) => privacyRequestMatchesFilter(filter, request))
          .map(({ candidateId }) => ({ candidateId })),
      ),
    );
    mocks.applicationAggregate.mockResolvedValue([
      applicationEvent({
        candidateName: "PRIVATE_CANDIDATE_NAME",
        candidateEmail: "private@example.com",
        note: "PRIVATE_DECISION_NOTE",
        resumeText: "PRIVATE_RESUME",
        capability: "PRIVATE_CAPABILITY",
      }),
      applicationEvent({
        auditId: `application:${ANONYMIZED_APPLICATION_ID}:0`,
        candidateId: ANONYMIZED_CANDIDATE_ID,
        targetId: ANONYMIZED_APPLICATION_ID,
      }),
      applicationEvent({ eventType: "unreviewed_new_event" }),
      applicationEvent({
        auditId: `application:${PRIVACY_PENDING_APPLICATION_ID}:0`,
        candidateId: PRIVACY_PENDING_CANDIDATE_ID,
        targetId: PRIVACY_PENDING_APPLICATION_ID,
      }),
    ]);
    mocks.jobAggregate.mockResolvedValue([
      jobEvent({
        workspaceId: FOREIGN_WORKSPACE_ID,
        auditId: `job:${FOREIGN_JOB_ID}:0`,
        targetId: FOREIGN_JOB_ID,
      }),
      jobEvent({
        note: "PRIVATE_JOB_NOTE",
        actorUserId: "PRIVATE_B2C_POINTER",
      }),
    ]);
    mocks.reportAggregate.mockResolvedValue([
      reportEvent({
        objectKey: "PRIVATE_OBJECT_KEY",
        reportSnapshot: { candidateName: "PRIVATE_REPORT_NAME" },
        failureCode: "PRIVATE_PROVIDER_ERROR",
        affectedCandidateIds: [ACTIVE_CANDIDATE_ID],
      }),
      reportEvent({
        auditId: `report:${REDACTED_REPORT_ID}:0`,
        targetId: REDACTED_REPORT_ID,
        privacyRedactedAt: new Date("2026-08-14T00:00:00.000Z"),
      }),
    ]);
    mocks.statusLinkAggregate.mockResolvedValue([
      statusLinkEvent({
        secretHash: "PRIVATE_SECRET_HASH",
        revocationReason: "PRIVATE_REASON",
      }),
      statusLinkEvent({
        auditId: `status_link:${ANONYMIZED_STATUS_LINK_ID}:0`,
        candidateId: ANONYMIZED_CANDIDATE_ID,
        targetId: ANONYMIZED_STATUS_LINK_ID,
      }),
      statusLinkEvent({
        auditId: `status_link:${PRIVACY_PENDING_STATUS_LINK_ID}:0`,
        candidateId: PRIVACY_PENDING_CANDIDATE_ID,
        targetId: PRIVACY_PENDING_STATUS_LINK_ID,
      }),
    ]);
    mocks.digestOutboxAggregate.mockResolvedValue([
      digestOutboxEvent({
        recipientEmail: "PRIVATE_DIGEST_RECIPIENT@example.com",
        recipientName: "PRIVATE_DIGEST_RECIPIENT_NAME",
        payload: { candidateName: "PRIVATE_DIGEST_CANDIDATE" },
        providerMessageId: "PRIVATE_DIGEST_PROVIDER_ID",
        failureCode: "PRIVATE_DIGEST_FAILURE_CODE",
        claimToken: "PRIVATE_DIGEST_CLAIM",
      }),
      digestOutboxEvent({ workspaceId: FOREIGN_WORKSPACE_ID }),
    ]);
    mocks.onboardingTestDriveAggregate.mockResolvedValue([
      onboardingTestDriveEvent({
        candidateId: "PRIVATE_TEST_DRIVE_CANDIDATE",
        applicationId: "PRIVATE_TEST_DRIVE_APPLICATION",
        jobId: "PRIVATE_TEST_DRIVE_JOB",
        roundId: "PRIVATE_TEST_DRIVE_ROUND",
        operationId: "PRIVATE_TEST_DRIVE_OPERATION",
        cleanupClaimToken: "PRIVATE_TEST_DRIVE_CLEANUP_CLAIM",
      }),
      onboardingTestDriveEvent({
        auditId: `onboarding_test_drive:${TEST_DRIVE_ID}:1`,
        eventType: "ready",
        occurredAt: new Date("2026-08-15T12:05:00.000Z"),
      }),
      onboardingTestDriveEvent({
        auditId: `onboarding_test_drive:${TEST_DRIVE_ID}:2`,
        eventType: "removed",
        occurredAt: new Date("2026-08-15T12:10:00.000Z"),
        actorName: "Removal Member",
      }),
      onboardingTestDriveEvent({ workspaceId: FOREIGN_WORKSPACE_ID }),
    ]);

    const page = await readHireWorkspaceAudit({
      workspaceId: WORKSPACE_ID,
      limit: 10,
    });

    expect(page.items).toEqual([
      {
        kind: "onboarding_test_drive_removed",
        occurredAt: "2026-08-15T12:10:00.000Z",
        actor: { kind: "member", name: "Removal Member" },
        target: { kind: "onboarding_test_drive", id: TEST_DRIVE_ID },
      },
      {
        kind: "onboarding_test_drive_ready",
        occurredAt: "2026-08-15T12:05:00.000Z",
        actor: { kind: "member", name: "Onboarding Member" },
        target: { kind: "onboarding_test_drive", id: TEST_DRIVE_ID },
      },
      {
        kind: "onboarding_test_drive_started",
        occurredAt: "2026-08-15T12:00:00.000Z",
        actor: { kind: "member", name: "Onboarding Member" },
        target: { kind: "onboarding_test_drive", id: TEST_DRIVE_ID },
      },
      {
        kind: "digest_delivery_sent",
        occurredAt: "2026-08-14T12:00:00.000Z",
        actor: { kind: "system", name: "System" },
        target: { kind: "digest_outbox", id: DIGEST_OUTBOX_ID },
      },
      {
        kind: "status_link_issued",
        occurredAt: "2026-08-13T12:00:00.000Z",
        actor: { kind: "member", name: "Hiring Admin" },
        target: { kind: "status_link", id: STATUS_LINK_ID },
      },
      {
        kind: "report_ready",
        occurredAt: "2026-08-12T12:00:00.000Z",
        actor: { kind: "system", name: "System" },
        target: { kind: "report", id: REPORT_ID },
      },
      {
        kind: "job_status_changed",
        occurredAt: "2026-08-11T12:00:00.000Z",
        actor: { kind: "system", name: "System" },
        target: { kind: "job", id: JOB_ID },
      },
      {
        kind: "application_stage_changed",
        occurredAt: "2026-08-10T12:00:00.000Z",
        actor: { kind: "member", name: "Hiring Admin" },
        target: { kind: "application", id: APPLICATION_ID },
      },
    ]);

    const pageJson = JSON.stringify(page);
    expect(pageJson).not.toContain(`application:${APPLICATION_ID}:0`);
    for (const deniedValue of [
      "PRIVATE_CANDIDATE_NAME",
      "private@example.com",
      "PRIVATE_DECISION_NOTE",
      "PRIVATE_RESUME",
      "PRIVATE_CAPABILITY",
      "PRIVATE_JOB_NOTE",
      "PRIVATE_B2C_POINTER",
      "PRIVATE_OBJECT_KEY",
      "PRIVATE_REPORT_NAME",
      "PRIVATE_PROVIDER_ERROR",
      "PRIVATE_SECRET_HASH",
      "PRIVATE_REASON",
      "PRIVATE_DIGEST_RECIPIENT@example.com",
      "PRIVATE_DIGEST_RECIPIENT_NAME",
      "PRIVATE_DIGEST_CANDIDATE",
      "PRIVATE_DIGEST_PROVIDER_ID",
      "PRIVATE_DIGEST_FAILURE_CODE",
      "PRIVATE_DIGEST_CLAIM",
      "PRIVATE_TEST_DRIVE_CANDIDATE",
      "PRIVATE_TEST_DRIVE_APPLICATION",
      "PRIVATE_TEST_DRIVE_JOB",
      "PRIVATE_TEST_DRIVE_ROUND",
      "PRIVATE_TEST_DRIVE_OPERATION",
      "PRIVATE_TEST_DRIVE_CLEANUP_CLAIM",
    ]) {
      expect(pageJson).not.toContain(deniedValue);
    }

    const [candidatePipeline] = mocks.candidateAggregate.mock.calls[0];
    expect(candidatePipeline[0].$match.workspaceId.toString()).toBe(
      WORKSPACE_ID,
    );
    expect(candidatePipeline[0].$match.piiAnonymizedAt).toEqual({
      $exists: false,
    });
    expect(JSON.stringify(candidatePipeline)).toContain(
      "hireonboardingtestdrives",
    );
    const privacyFilter = mocks.privacyRequestFind.mock.calls[0][0];
    expect(privacyFilter.workspaceId.toString()).toBe(WORKSPACE_ID);
    expect(privacyFilter.live).toBe(true);
    expect(privacyFilter.$or).toEqual([
      { status: "processing" },
      {
        status: "pending_verification",
        verificationExpiresAt: { $gt: expect.any(Date) },
      },
    ]);
    expect(mocks.privacyFilter).toHaveBeenCalledOnce();

    const [applicationPipeline] = mocks.applicationAggregate.mock.calls[0];
    expect(applicationPipeline[0]).toMatchObject({
      $match: { candidateId: { $in: [ACTIVE_CANDIDATE_ID] } },
    });
    expect(applicationPipeline[0].$match.workspaceId.toString()).toBe(
      WORKSPACE_ID,
    );
    expect(JSON.stringify(applicationPipeline)).not.toContain("note");
    expect(JSON.stringify(applicationPipeline)).not.toContain("resume");
    expect(JSON.stringify(applicationPipeline)).not.toContain("candidateName");
    expect(JSON.stringify(applicationPipeline)).toContain(
      "hireonboardingtestdrives",
    );

    const [jobPipeline] = mocks.jobAggregate.mock.calls[0];
    expect(JSON.stringify(jobPipeline)).toContain("hireonboardingtestdrives");

    const [reportPipeline] = mocks.reportAggregate.mock.calls[0];
    expect(reportPipeline[0]).toMatchObject({
      $match: { privacyRedactedAt: { $exists: false } },
    });
    expect(JSON.stringify(reportPipeline)).not.toContain("reportSnapshot");
    expect(JSON.stringify(reportPipeline)).not.toContain("objectKey");
    expect(JSON.stringify(reportPipeline)).not.toContain("failureCode");
    expect(JSON.stringify(reportPipeline)).not.toContain(
      "affectedCandidateIds",
    );
    expect(JSON.stringify(reportPipeline)).toContain("requestedByName");

    const [statusPipeline] = mocks.statusLinkAggregate.mock.calls[0];
    expect(statusPipeline[0]).toMatchObject({
      $match: { privacyRedactedAt: { $exists: false } },
    });
    expect(JSON.stringify(statusPipeline)).not.toContain("secretHash");
    expect(JSON.stringify(statusPipeline)).not.toContain("revocationReason");
    expect(JSON.stringify(statusPipeline)).toContain("issuedByName");
    expect(JSON.stringify(statusPipeline)).toContain("revokedByName");
    expect(JSON.stringify(statusPipeline)).toContain(
      "hireonboardingtestdrives",
    );

    const [digestPipeline] = mocks.digestOutboxAggregate.mock.calls[0];
    for (const deniedField of [
      "recipientEmail",
      "recipientName",
      "payload",
      "providerMessageId",
      "failureCode",
      "claimToken",
      "leaseExpiresAt",
    ]) {
      expect(JSON.stringify(digestPipeline)).not.toContain(deniedField);
    }
    const [onboardingPipeline] =
      mocks.onboardingTestDriveAggregate.mock.calls[0];
    expect(onboardingPipeline[0].$match.workspaceId.toString()).toBe(
      WORKSPACE_ID,
    );
    for (const deniedField of [
      "candidateId",
      "applicationId",
      "jobId",
      "roundId",
      "operationId",
      "cleanupClaimToken",
    ]) {
      expect(JSON.stringify(onboardingPipeline)).not.toContain(deniedField);
    }
    expect(JSON.stringify(onboardingPipeline)).toContain("issuedByName");
    expect(JSON.stringify(onboardingPipeline)).toContain("removedByName");
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "candidateId",
    });
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "applicationId",
    });
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "jobId",
    });
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "applicationId",
      sourceIdField: "applicationId",
    });
  });

  it("uses an opaque, stable descending cursor without replaying prior items", async () => {
    const tiedAt = new Date("2026-08-14T12:00:00.000Z");
    const rows = {
      applications: [applicationEvent({ occurredAt: tiedAt })],
      jobs: [jobEvent({ occurredAt: tiedAt })],
      reports: [reportEvent({ occurredAt: tiedAt })],
      statusLinks: [statusLinkEvent({ occurredAt: tiedAt })],
    };
    mocks.applicationAggregate.mockResolvedValue(rows.applications);
    mocks.jobAggregate.mockResolvedValue(rows.jobs);
    mocks.reportAggregate.mockResolvedValue(rows.reports);
    mocks.statusLinkAggregate.mockResolvedValue(rows.statusLinks);

    const first = await readHireWorkspaceAudit({
      workspaceId: WORKSPACE_ID,
      limit: 2,
    });
    const second = await readHireWorkspaceAudit({
      workspaceId: WORKSPACE_ID,
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });

    expect(first.items.map((item) => item.kind)).toEqual([
      "status_link_issued",
      "report_ready",
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain("report");
    expect(second.items.map((item) => item.kind)).toEqual([
      "job_status_changed",
      "application_stage_changed",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.target.id))
        .size,
    ).toBe(4);
    expect(
      parseHireOperationsAuditCursor(first.nextCursor ?? undefined),
    ).toEqual(expect.objectContaining({ id: `report:${REPORT_ID}:0` }));
  });

  it("does not query candidate-associated sources when the privacy-safe candidate set is empty", async () => {
    mocks.candidateAggregate.mockResolvedValue([]);
    mocks.jobAggregate.mockResolvedValue([jobEvent()]);
    mocks.reportAggregate.mockResolvedValue([reportEvent()]);
    mocks.onboardingTestDriveAggregate.mockResolvedValue([
      onboardingTestDriveEvent(),
    ]);

    const page = await readHireWorkspaceAudit({ workspaceId: WORKSPACE_ID });

    expect(mocks.applicationAggregate).not.toHaveBeenCalled();
    expect(mocks.statusLinkAggregate).not.toHaveBeenCalled();
    expect(page.items.map((item) => item.kind)).toEqual([
      "onboarding_test_drive_started",
      "report_ready",
      "job_status_changed",
    ]);
  });

  it("rejects malformed or overlong cursor coordinates", () => {
    expect(() => parseHireOperationsAuditCursor("not-a-cursor")).toThrow(
      HireOperationsAuditError,
    );
    expect(() => parseHireOperationsAuditCursor("a".repeat(513))).toThrow(
      "Audit cursor is invalid",
    );
  });
});
