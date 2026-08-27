import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HireApplication,
  HireCandidate,
  HireHumanRound,
  HireHumanScorecard,
  HireJob,
  HireRound,
  HireWorkspace,
} from "@hire-operations-boundary";
import type {
  HireJobCandidateNormalizedQuery,
  HireJobCandidateQuery,
} from "../candidateTypes";
import {
  HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS,
  HireJobCandidateReadError,
  readHireJobCandidateSummary,
  readHireJobCandidates,
} from "../services/candidateListService";
import { connectHireOperationsDB } from "../services/hireOperationsBoundary";

const enabled = process.env.HIRE_CANDIDATE_SCALE_MONGO_TEST === "1";
const uri = process.env.HIRE_CANDIDATE_SCALE_MONGO_TEST_URI;

function databaseName(mongoUri: string | undefined): string | null {
  const match = mongoUri?.match(
    /^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?#]+)(?:[?#]|$)/i,
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const database = databaseName(uri);

if (enabled && (!uri || !database?.endsWith("_test"))) {
  throw new Error(
    "HIRE_CANDIDATE_SCALE_MONGO_TEST_URI must name an isolated database ending in _test when the real-Mongo gate is enabled",
  );
}

const mongoSuite = describe.skipIf(!enabled);
const NOW = new Date("2026-08-25T12:00:00.000Z");
const CREATED_AT = new Date("2026-08-01T00:00:00.000Z");
const APPLICATION_COUNT = 1_000;
const FRESH_SCORE_COUNT = 700;
const PAGE_LIMIT = 50;
const TECHNICAL_WRITE_AT = new Date("2026-09-25T12:00:00.000Z");

function query(cursor?: string): HireJobCandidateQuery {
  return {
    view: "all",
    stage: [],
    source: [],
    scoreState: [],
    humanReview: [],
    aiInterview: [],
    sort: "rank",
    direction: "asc",
    limit: PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
  };
}

function summaryQuery(): HireJobCandidateNormalizedQuery {
  return {
    view: "all",
    stage: [],
    source: [],
    scoreState: [],
    humanReview: [],
    aiInterview: [],
    sort: "rank",
    direction: "asc",
  };
}

function activityQuery(): HireJobCandidateQuery {
  return {
    view: "all",
    stage: [],
    source: [],
    scoreState: [],
    humanReview: [],
    aiInterview: [],
    sort: "last_activity",
    direction: "desc",
    limit: 20,
  };
}

function enrichedQuery(
  overrides: Partial<HireJobCandidateQuery>,
): HireJobCandidateQuery {
  return {
    ...activityQuery(),
    sort: "name",
    direction: "asc",
    ...overrides,
  };
}

type AggregateProfile = {
  millis?: number;
  docsExamined?: number;
  keysExamined?: number;
  responseLength?: number;
  planSummary?: string;
  command?: {
    aggregate?: string;
    maxTimeMS?: number;
    pipeline?: unknown[];
  };
};

function indexNames(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) indexNames(item, found);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "indexName" && typeof item === "string") found.add(item);
    else indexNames(item, found);
  }
  return found;
}

describe("Hire candidate scale fixture schemas", () => {
  it("keeps representative enriched documents schema-valid without Mongo", () => {
    const workspaceId = new mongoose.Types.ObjectId();
    const jobId = new mongoose.Types.ObjectId();
    const applicationId = new mongoose.Types.ObjectId();
    const candidateId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    const humanRoundId = new mongoose.Types.ObjectId();
    const submittedAt = new Date(CREATED_AT.getTime() + 60 * 60 * 1_000);

    const documents = [
      new HireApplication({
        workspaceId,
        jobId,
        candidateId,
        stage: "new",
        offerDecision: {
          outcome: "accepted",
          actorName: "Scale reviewer",
          at: submittedAt,
        },
        applicantSubmissions: [{
          resumeText: "Schema-valid scale acceptance resume.",
          submittedAt,
        }],
        events: [{ type: "created", actorName: "System", at: CREATED_AT }],
      }),
      new HireHumanRound({
        _id: humanRoundId,
        workspaceId,
        jobId,
        applicationId,
        candidateId,
        mode: "member_room",
        status: "completed",
        creationOperationId: "candidate-scale-human-representative",
        briefSnapshot: {
          candidateName: "Candidate representative",
          jobTitle: "Platform engineer",
        },
        createdByMemberId: memberId,
        createdByName: "Scale reviewer",
        scorecardSubmittedAt: submittedAt,
      }),
      new HireHumanScorecard({
        workspaceId,
        jobId,
        applicationId,
        candidateId,
        humanRoundId,
        reviewerKind: "member",
        reviewerKey: `member:${memberId.toString()}`,
        memberId,
        reviewerName: "Scale reviewer",
        status: "submitted",
        dimensions: [
          { key: "role_capability", rating: 4, evidence: "Relevant role evidence" },
          { key: "problem_solving", rating: 4, evidence: "Relevant problem evidence" },
          { key: "communication", rating: 4, evidence: "Relevant communication evidence" },
          { key: "collaboration", rating: 4, evidence: "Relevant collaboration evidence" },
        ],
        recommendation: "yes",
        overallComment: "Proceed based on the structured evidence.",
        submittedAt,
      }),
      new HireRound({
        workspaceId,
        jobId,
        applicationId,
        candidateId,
        candidateEmail: "candidate-representative@scale.example",
        candidateName: "Candidate representative",
        kind: "ai",
        status: "completed",
        authMode: "magic_link",
        inviteTokenHash: "b".repeat(64),
        inviteTokenExpiry: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
        invitedAt: CREATED_AT,
        config: {
          role: "Platform engineer",
          interviewType: "technical",
          experience: "5",
          duration: 30,
        },
        jdHash: "a".repeat(64),
        jdSnapshot: "Build reliable multi-tenant hiring systems.",
        createdByMemberId: memberId,
        createdByName: "Scale reviewer",
        results: { overallScore: 80, sessionCompletedAt: submittedAt },
      }),
    ];

    for (const document of documents) {
      expect(document.validateSync()).toBeUndefined();
    }
  });
});

mongoSuite("Hire candidate list on real Mongo", () => {
  const ids = {
    workspaceId: new mongoose.Types.ObjectId(),
    jobId: new mongoose.Types.ObjectId(),
    departmentId: new mongoose.Types.ObjectId(),
    creatorId: new mongoose.Types.ObjectId(),
  };
  const jdText = "Build reliable multi-tenant hiring systems.";
  const jdHash = createHash("sha256").update(jdText).digest("hex");
  const applicationIds: mongoose.Types.ObjectId[] = [];

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXTAUTH_SECRET", "candidate-scale-mongo-test-secret-123456");
    vi.stubEnv("IPG_SURFACE", "hire-control");
    vi.stubEnv("MONGODB_URI", uri as string);
    vi.stubEnv("HIRE_CONTROL_DATABASE_NAME", database as string);
    vi.stubEnv("B2C_DATABASE_NAME", "ipg_candidate_scale_b2c_test");
    vi.stubEnv("HIRE_RUNTIME_DATABASE_NAME", "ipg_candidate_scale_runtime_test");

    await connectHireOperationsDB();
    if (mongoose.connection.name !== database || !database?.endsWith("_test")) {
      throw new Error("refusing to prepare a non-isolated candidate-scale database");
    }
    await mongoose.connection.dropDatabase();

    await Promise.all([
      HireApplication.collection.createIndex(
        { workspaceId: 1, jobId: 1, createdAt: 1, _id: 1 },
        { name: "hire_candidate_workspace_job_snapshot_read" },
      ),
      HireApplication.collection.createIndex(
        { workspaceId: 1, candidateId: 1, jobId: 1 },
        { name: "hire_candidate_workspace_history_lookup" },
      ),
      HireCandidate.collection.createIndex(
        { workspaceId: 1, email: 1 },
        { name: "workspaceId_1_email_1", unique: true },
      ),
      HireHumanRound.collection.createIndex(
        { workspaceId: 1, applicationId: 1, createdAt: -1 },
        { name: "workspaceId_1_applicationId_1_createdAt_-1" },
      ),
      HireHumanScorecard.collection.createIndex(
        { workspaceId: 1, applicationId: 1, status: 1, createdAt: -1 },
        { name: "workspaceId_1_applicationId_1_status_1_createdAt_-1" },
      ),
      HireRound.collection.createIndex(
        { workspaceId: 1, applicationId: 1, createdAt: -1 },
        { name: "workspaceId_1_applicationId_1_createdAt_-1" },
      ),
    ]);

    await HireWorkspace.collection.insertOne({
      _id: ids.workspaceId,
      name: "Candidate scale acceptance",
      guestAuthMode: "magic_link",
      lifecycleState: "active",
      authorityVersion: 1,
      writeFenceVersion: 0,
      privacyAggregateFenceVersion: 11,
      lifecycleEvents: [],
      adminTransferEvents: [],
      createdBy: ids.creatorId,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    await HireJob.collection.insertOne({
      _id: ids.jobId,
      workspaceId: ids.workspaceId,
      departmentId: ids.departmentId,
      title: "Platform engineer",
      jdText,
      status: "open",
      intakeWriteVersion: 7,
      applyPageEnabled: true,
      events: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });

    const candidates = [];
    const applications = [];
    const humanRounds = [];
    const scorecards = [];
    const aiRounds = [];
    const pastApplications = [];
    for (let index = 0; index < APPLICATION_COUNT; index += 1) {
      const candidateId = new mongoose.Types.ObjectId();
      const applicationId = new mongoose.Types.ObjectId();
      const createdAt = new Date(CREATED_AT.getTime() + index * 1_000);
      applicationIds.push(applicationId);
      candidates.push({
        _id: candidateId,
        workspaceId: ids.workspaceId,
        name: `Candidate ${String(index).padStart(4, "0")}`,
        email: `candidate-${index}@scale.example`,
        source: "apply_page",
        sourceHistory: ["apply_page"],
        privacyWriteFenceVersion: 0,
        createdAt,
        updatedAt: createdAt,
      });
      applications.push({
        _id: applicationId,
        workspaceId: ids.workspaceId,
        jobId: ids.jobId,
        candidateId,
        stage: index % 5 === 0 ? "shortlist" : "new",
        ...(index < FRESH_SCORE_COUNT
          ? {
              resumeMatch: {
                score: 100 - index / 10,
                strengths: [],
                gaps: [],
                scoredAt: createdAt,
                jdHash,
                resumeHash: "a".repeat(64),
                stale: false,
              },
            }
          : {}),
        events: [],
        createdAt,
        updatedAt: createdAt,
      });
      let humanRoundId: mongoose.Types.ObjectId | undefined;
      if (index % 4 === 0 || index % 5 === 0) {
        humanRoundId = new mongoose.Types.ObjectId();
        humanRounds.push({
          _id: humanRoundId,
          workspaceId: ids.workspaceId,
          jobId: ids.jobId,
          applicationId,
          candidateId,
          mode: "member_room",
          status: "completed",
          creationOperationId: `candidate-scale-human-${index}`,
          briefSnapshot: {
            candidateName: `Candidate ${String(index).padStart(4, "0")}`,
            jobTitle: "Platform engineer",
          },
          createdByMemberId: ids.creatorId,
          createdByName: "Scale reviewer",
          scorecardSubmittedAt: new Date(createdAt.getTime() + 60 * 60 * 1_000),
          createdAt,
          updatedAt: TECHNICAL_WRITE_AT,
        });
      }
      if (index % 5 === 0) {
        scorecards.push({
          _id: new mongoose.Types.ObjectId(),
          workspaceId: ids.workspaceId,
          jobId: ids.jobId,
          applicationId,
          candidateId,
          humanRoundId: humanRoundId!,
          reviewerKind: "member",
          reviewerKey: `member:${ids.creatorId.toString()}`,
          memberId: ids.creatorId,
          reviewerName: "Scale reviewer",
          status: "submitted",
          dimensions: [
            { key: "role_capability", rating: 4, evidence: "Relevant role evidence" },
            { key: "problem_solving", rating: 4, evidence: "Relevant problem evidence" },
            { key: "communication", rating: 4, evidence: "Relevant communication evidence" },
            { key: "collaboration", rating: 4, evidence: "Relevant collaboration evidence" },
          ],
          recommendation: "yes",
          overallComment: "Proceed based on the structured evidence.",
          submittedAt: new Date(createdAt.getTime() + 45 * 60 * 1_000),
          createdAt,
          updatedAt: TECHNICAL_WRITE_AT,
        });
      }
      if (index % 3 === 0) {
        aiRounds.push({
          _id: new mongoose.Types.ObjectId(),
          workspaceId: ids.workspaceId,
          jobId: ids.jobId,
          applicationId,
          candidateId,
          candidateEmail: `candidate-${index}@scale.example`,
          candidateName: `Candidate ${String(index).padStart(4, "0")}`,
          kind: "ai",
          status: "completed",
          authMode: "magic_link",
          inviteTokenHash: "b".repeat(64),
          inviteTokenExpiry: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
          consentAt: new Date(createdAt.getTime() + 5 * 60 * 1_000),
          preparedAt: new Date(createdAt.getTime() + 10 * 60 * 1_000),
          linkedAt: new Date(createdAt.getTime() + 20 * 60 * 1_000),
          results: {
            overallScore: 80,
            sessionCompletedAt: new Date(createdAt.getTime() + 30 * 60 * 1_000),
          },
          invitedAt: createdAt,
          config: {
            role: "Platform engineer",
            interviewType: "technical",
            experience: "5",
            duration: 30,
          },
          jdHash,
          jdSnapshot: jdText,
          createdByMemberId: ids.creatorId,
          createdByName: "Scale reviewer",
          createdAt,
          updatedAt: TECHNICAL_WRITE_AT,
        });
      }
      if (index % 10 === 0) {
        pastApplications.push({
          _id: new mongoose.Types.ObjectId(),
          workspaceId: ids.workspaceId,
          jobId: new mongoose.Types.ObjectId("999999999999999999999999"),
          candidateId,
          stage: "withdrawn",
          events: [],
          createdAt: new Date(createdAt.getTime() - 24 * 60 * 60 * 1_000),
          updatedAt: createdAt,
        });
      }
    }
    await HireCandidate.collection.insertMany(candidates, { ordered: true });
    await HireApplication.insertMany([...applications, ...pastApplications], { ordered: true });
    await Promise.all([
      HireHumanRound.insertMany(humanRounds, { ordered: true }),
      HireHumanScorecard.insertMany(scorecards, { ordered: true }),
      HireRound.insertMany(aiRounds, { ordered: true }),
    ]);

    const semanticActivity = Array.from({ length: 7 }, (_, index) =>
      new Date(NOW.getTime() - (index + 1) * 60_000));
    await Promise.all([
      HireApplication.collection.updateOne(
        { _id: applicationIds[0] },
        { $set: { updatedAt: TECHNICAL_WRITE_AT } },
      ),
      HireApplication.updateOne(
        { _id: applicationIds[1] },
        {
          $set: {
            offerDecision: {
              outcome: "accepted",
              actorName: "Scale reviewer",
              at: semanticActivity[0],
            },
          },
        },
        { runValidators: true },
      ),
      HireApplication.updateOne(
        { _id: applicationIds[2] },
        {
          $set: {
            events: [{
              type: "created",
              actorName: "System",
              at: semanticActivity[1],
            }],
          },
        },
        { runValidators: true },
      ),
      HireApplication.updateOne(
        { _id: applicationIds[3] },
        {
          $set: {
            applicantSubmissions: [{
              resumeText: "Schema-valid scale acceptance résumé.",
              submittedAt: semanticActivity[2],
            }],
          },
        },
        { runValidators: true },
      ),
      HireHumanRound.updateOne(
        { applicationId: applicationIds[4] },
        { $set: { scorecardSubmittedAt: semanticActivity[3], updatedAt: TECHNICAL_WRITE_AT } },
        { runValidators: true, timestamps: false },
      ),
      HireHumanScorecard.updateOne(
        { applicationId: applicationIds[5] },
        { $set: { submittedAt: semanticActivity[4], updatedAt: TECHNICAL_WRITE_AT } },
        { runValidators: true, timestamps: false },
      ),
      HireRound.updateOne(
        { applicationId: applicationIds[6] },
        { $set: { "results.sessionCompletedAt": semanticActivity[5], updatedAt: TECHNICAL_WRITE_AT } },
        { runValidators: true, timestamps: false },
      ),
      HireApplication.updateOne(
        { _id: applicationIds[7] },
        { $set: { "resumeMatch.scoredAt": semanticActivity[6] } },
        { runValidators: true },
      ),
    ]);
    await mongoose.connection.db?.command({ profile: 2, slowms: 0 });
  }, 60_000);

  afterAll(async () => {
    try {
      if (
        mongoose.connection.readyState === 1 &&
        mongoose.connection.name === database &&
        database?.endsWith("_test")
      ) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
      vi.unstubAllEnvs();
    }
  });

  it(
    "keeps every page bounded while traversing 1,000 applications with global ranks and a stale revision fence",
    async () => {
      const rows = [];
      const pageElapsedMs: number[] = [];
      const pageRowCounts: number[] = [];
      let cursor: string | undefined;
      let firstCursor: string | undefined;
      let pageCount = 0;

      const summary = await readHireJobCandidateSummary({
        workspaceId: ids.workspaceId.toString(),
        jobId: ids.jobId.toString(),
        query: summaryQuery(),
        now: NOW,
      });
      expect(summary.counts).toMatchObject({
        total: APPLICATION_COUNT,
        matching: APPLICATION_COUNT,
        stages: { new: 800, shortlist: 200 },
        jdMatch: { fresh: FRESH_SCORE_COUNT, unscored: 300, stale: 0, pending: 0 },
        savedViews: {
          all: APPLICATION_COUNT,
          scoring_attention: 300,
          screening_attention: 800,
          interview_attention: 0,
          decision_ready: 200,
          offers: 0,
        },
      });
      expect(summary.rankContext).toEqual({
        freshScoredTotal: FRESH_SCORE_COUNT,
        stale: 0,
        unscored: 300,
        pending: 0,
      });

      do {
        const startedAt = performance.now();
        const page = await readHireJobCandidates({
          workspaceId: ids.workspaceId.toString(),
          jobId: ids.jobId.toString(),
          query: query(cursor),
          now: NOW,
        });
        pageElapsedMs.push(performance.now() - startedAt);
        pageRowCounts.push(page.rows.length);
        pageCount += 1;
        expect(page.rows.length).toBeGreaterThan(0);
        expect(page.rows.length).toBeLessThanOrEqual(PAGE_LIMIT);
        expect(page.pageInfo.limit).toBe(PAGE_LIMIT);
        if (pageCount === 1) firstCursor = page.pageInfo.nextCursor ?? undefined;
        rows.push(...page.rows);
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);

      expect(pageCount).toBe(APPLICATION_COUNT / PAGE_LIMIT);
      expect(rows).toHaveLength(APPLICATION_COUNT);
      expect(new Set(rows.map(({ applicationId }) => applicationId)).size).toBe(
        APPLICATION_COUNT,
      );
      expect(
        rows.slice(0, FRESH_SCORE_COUNT).map(({ jdMatch }) => jdMatch.rank),
      ).toEqual(Array.from({ length: FRESH_SCORE_COUNT }, (_, index) => index + 1));
      expect(
        new Set(
          rows
            .slice(0, FRESH_SCORE_COUNT)
            .map(({ jdMatch }) => jdMatch.denominator),
        ),
      ).toEqual(new Set([FRESH_SCORE_COUNT]));
      expect(
        rows.slice(FRESH_SCORE_COUNT).every(
          ({ jdMatch }) =>
            jdMatch.state === "unscored" &&
            jdMatch.rank === null &&
            jdMatch.denominator === null,
        ),
      ).toBe(true);

      const db = mongoose.connection.db;
      if (!db) throw new Error("candidate-scale database disconnected during acceptance");
      const buildInfo = await db.command<{ version: string }>({ buildInfo: 1 });
      expect(buildInfo.version).toMatch(/^8\.2\./);
      const aggregateProfiles = await db
        .collection<AggregateProfile>("system.profile")
        .find({ op: "command", "command.aggregate": HireApplication.collection.name })
        .toArray();
      const pageProfiles = aggregateProfiles.filter(({ command }) =>
        JSON.stringify(command?.pipeline).includes("$setWindowFields"),
      );
      expect(pageProfiles).toHaveLength(pageCount);
      expect(pageProfiles.every(({ command }) =>
        command?.maxTimeMS === HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS,
      )).toBe(true);
      expect(pageProfiles.every(({ millis }) =>
        typeof millis === "number" &&
        millis < HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS,
      )).toBe(true);
      const firstPipeline = pageProfiles[0]?.command?.pipeline;
      if (!firstPipeline) throw new Error("candidate page pipeline was not profiled");
      const explain = await db.command({
        explain: {
          aggregate: HireApplication.collection.name,
          pipeline: firstPipeline,
          cursor: {},
          maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS,
        },
        verbosity: "executionStats",
      });
      const usedIndexes = indexNames(explain);
      expect(usedIndexes).toContain("hire_candidate_workspace_job_snapshot_read");

      const sortedElapsed = [...pageElapsedMs].sort((left, right) => left - right);
      const p95Index = Math.max(0, Math.ceil(sortedElapsed.length * 0.95) - 1);
      console.info(JSON.stringify({
        event: "hire_candidate_scale_mongo_acceptance",
        mongoVersion: buildInfo.version,
        applicationCount: rows.length,
        pageCount,
        maxRowsPerPage: Math.max(...pageRowCounts),
        uniqueApplications: new Set(rows.map(({ applicationId }) => applicationId)).size,
        freshRankDenominator: FRESH_SCORE_COUNT,
        clientPageElapsedMs: {
          max: Math.round(Math.max(...pageElapsedMs)),
          p95: Math.round(sortedElapsed[p95Index] ?? 0),
        },
        serverPageMillis: {
          max: Math.max(...pageProfiles.map(({ millis }) => millis ?? 0)),
        },
        maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS,
        usedIndexes: [...usedIndexes].sort(),
      }));

      expect(firstCursor).toBeTruthy();
      await HireWorkspace.collection.updateOne(
        { _id: ids.workspaceId },
        { $inc: { privacyAggregateFenceVersion: 1 } },
      );
      await expect(
        readHireJobCandidates({
          workspaceId: ids.workspaceId.toString(),
          jobId: ids.jobId.toString(),
          query: query(firstCursor),
          now: new Date(NOW.getTime() + 1_000),
        }),
      ).rejects.toMatchObject<Partial<HireJobCandidateReadError>>({
        code: "JOB_CANDIDATES_CURSOR_STALE",
        statusCode: 409,
      });
    },
    120_000,
  );

  it("orders by semantic activity while ignoring newer technical writes", async () => {
    const page = await readHireJobCandidates({
      workspaceId: ids.workspaceId.toString(),
      jobId: ids.jobId.toString(),
      query: activityQuery(),
      now: NOW,
    });

    expect(page.rows.slice(0, 7).map(({ candidate }) => candidate.name)).toEqual([
      "Candidate 0001",
      "Candidate 0002",
      "Candidate 0003",
      "Candidate 0004",
      "Candidate 0005",
      "Candidate 0006",
      "Candidate 0007",
    ]);
    expect(page.rows.slice(0, 7).map(({ lastActivityAt }) => lastActivityAt)).toEqual(
      Array.from({ length: 7 }, (_, index) =>
        new Date(NOW.getTime() - (index + 1) * 60_000).toISOString()),
    );
    expect(page.rows.slice(0, 7).map(({ candidate }) => candidate.name)).not.toContain(
      "Candidate 0000",
    );
  });

  it("executes enriched human, AI, and returning-candidate filters with bounded pages", async () => {
    const [human, ai, returning] = await Promise.all([
      readHireJobCandidates({
        workspaceId: ids.workspaceId.toString(),
        jobId: ids.jobId.toString(),
        query: enrichedQuery({ humanReview: ["complete"] }),
        now: NOW,
      }),
      readHireJobCandidates({
        workspaceId: ids.workspaceId.toString(),
        jobId: ids.jobId.toString(),
        query: enrichedQuery({ aiInterview: ["completed"] }),
        now: NOW,
      }),
      readHireJobCandidates({
        workspaceId: ids.workspaceId.toString(),
        jobId: ids.jobId.toString(),
        query: enrichedQuery({ history: "returning" }),
        now: NOW,
      }),
    ]);

    expect(human.rows).toHaveLength(20);
    expect(human.rows.every(({ humanReview }) =>
      humanReview.state === "complete" && humanReview.submitted === 1)).toBe(true);
    expect(ai.rows).toHaveLength(20);
    expect(ai.rows.every(({ aiInterview }) =>
      aiInterview.state === "completed" && aiInterview.overallScore === 80)).toBe(true);
    expect(returning.rows).toHaveLength(20);
    expect(returning.rows.map(({ candidate }) => candidate.name)).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        `Candidate ${String(index * 10).padStart(4, "0")}`),
    );
    expect(returning.rows.every(({ workspaceHistory }) =>
      workspaceHistory.previousApplications === 1)).toBe(true);
  });
});
