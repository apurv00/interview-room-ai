import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HireApplication,
  HireCandidate,
  HireJob,
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

mongoSuite("Hire candidate list on real Mongo", () => {
  const ids = {
    workspaceId: new mongoose.Types.ObjectId(),
    jobId: new mongoose.Types.ObjectId(),
    departmentId: new mongoose.Types.ObjectId(),
    creatorId: new mongoose.Types.ObjectId(),
  };
  const jdText = "Build reliable multi-tenant hiring systems.";
  const jdHash = createHash("sha256").update(jdText).digest("hex");

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
    for (let index = 0; index < APPLICATION_COUNT; index += 1) {
      const candidateId = new mongoose.Types.ObjectId();
      const applicationId = new mongoose.Types.ObjectId();
      const createdAt = new Date(CREATED_AT.getTime() + index * 1_000);
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
    }
    await HireCandidate.collection.insertMany(candidates, { ordered: true });
    await HireApplication.collection.insertMany(applications, { ordered: true });
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
});
