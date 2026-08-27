import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import mongoose, { type ClientSession, type PipelineStage } from "mongoose";
import { AppError } from "@shared/errors";
import {
  HIRE_STAGES,
  HireApplication,
  HireCandidate,
  HireHumanRound,
  HireHumanScorecard,
  HireIntakeTask,
  HireInvitationBatch,
  HireInvitationBatchItem,
  HireJob,
  HirePrivacyRequest,
  HireRound,
  HireScreeningGate,
  HireWorkspace,
  type HireJobStatus,
  type HireStage,
} from "@hire-operations-boundary";
import { HireDepartment } from "@hire-departments/models";
import { buildHireOnboardingTestDriveExclusionStages } from "@/modules/hire-onboarding/services/testDriveService";
import {
  HIRE_JOB_CANDIDATE_AI_INTERVIEW_STATES,
  HIRE_JOB_CANDIDATE_ATTENTION_KINDS,
  HIRE_JOB_CANDIDATE_HUMAN_REVIEW_STATES,
  HIRE_JOB_CANDIDATE_JD_STATES,
  HIRE_JOB_CANDIDATE_SOURCES,
  HIRE_JOB_CANDIDATE_VIEWS,
  HIRE_JOB_CANDIDATE_SELECTION_MAX,
  type HireJobCandidateAiInterviewState,
  type HireJobCandidateAttentionKind,
  type HireJobCandidateCounts,
  type HireJobCandidateHumanReview,
  type HireJobCandidateHumanReviewState,
  type HireJobCandidateFreshness,
  type HireJobCandidateFreshnessQuery,
  type HireJobCandidateIdentityPage,
  type HireJobCandidateIdentityQuery,
  type HireJobCandidateJdState,
  type HireJobCandidateNormalizedQuery,
  type HireJobCandidatePage,
  type HireJobCandidateQuery,
  type HireJobCandidateRow,
  type HireJobCandidateSource,
  type HireJobCandidateSummary,
  type HireJobOverview,
  type HireJobOverviewActivityKind,
} from "../candidateTypes";
import {
  candidateNormalizedQuery,
  canonicalCandidateQuery,
} from "../validators/candidateWorkspace";
import { connectHireOperationsDB } from "./hireOperationsBoundary";

export const HIRE_JOB_CANDIDATE_DEFAULT_LIMIT = 50;
export const HIRE_JOB_CANDIDATE_MAX_LIMIT = 100;
export const HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS = 5_000;

const CURSOR_VERSION = 2;
const CURSOR_IV_BYTES = 12;
const CURSOR_AUTH_TAG_BYTES = 16;
const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const CURSOR_FUTURE_SKEW_MS = 60_000;

type IdLike = mongoose.Types.ObjectId | string;
type SortCoordinate = string | number;
type CandidateRevision = { j: number; d: number };

type CandidateCursor = {
  v: 2;
  h: string;
  a: number;
  p: SortCoordinate;
  i: string;
} & CandidateRevision;

type CandidateJobRecord = {
  _id: IdLike;
  departmentId: IdLike;
  title: string;
  jdText: string;
  status: HireJobStatus;
  applyPageEnabled?: boolean;
  candidateReadVersion?: number;
  createdAt: Date;
};

type RawCandidateRow = {
  _id: IdLike;
  applicationId: string;
  candidate: { id: string; name: string; email: string };
  stage: HireStage;
  source: HireJobCandidateSource;
  sourceHistory: HireJobCandidateSource[];
  appliedAt: Date;
  lastActivityAt: Date;
  attention: HireJobCandidateAttentionKind[];
  jdMatch: {
    state: HireJobCandidateJdState;
    score: number | null;
    rank: number | null;
    denominator: number | null;
    scoredAt: Date | null;
  };
  humanReview: HireJobCandidateHumanReview;
  aiInterview: {
    state: HireJobCandidateAiInterviewState;
    overallScore: number | null;
    updatedAt: Date | null;
  };
  workspaceHistory: { previousApplications: number };
  _sortPrimary: SortCoordinate;
};

type RawCandidateIdentity = {
  _id: IdLike; applicationId: string;
  candidateName: string; candidateEmail: string;
  _sortPrimary: string;
};

type RawCounts = {
  total: Array<{ count: number }>;
  matching: Array<{ count: number }>;
  stages: Array<{ _id: HireStage; count: number }>;
  jdMatch: Array<{ _id: HireJobCandidateJdState; count: number }>;
  savedViews: Array<Record<string, number>>;
};

export class HireJobCandidateReadError extends AppError {
  constructor(
    message: string,
    readonly code:
      | "JOB_CANDIDATES_INVALID_SCOPE"
      | "JOB_CANDIDATES_SCOPE_NOT_FOUND"
      | "JOB_CANDIDATES_INVALID_CURSOR"
      | "JOB_CANDIDATES_CURSOR_STALE"
      | "JOB_CANDIDATES_SELECTION_TOO_LARGE",
    status: 400 | 404 | 409 = 400,
  ) {
    super(message, status, code);
    this.name = "HireJobCandidateReadError";
  }
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new HireJobCandidateReadError(
      `Invalid ${label}`,
      "JOB_CANDIDATES_INVALID_SCOPE",
    );
  }
  return new mongoose.Types.ObjectId(value);
}

function recordId(value: IdLike): string {
  return value.toString();
}

function normalizedNow(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new HireJobCandidateReadError(
      "Invalid candidate-list timestamp",
      "JOB_CANDIDATES_INVALID_SCOPE",
    );
  }
  return now;
}

function cursorSecret(): string {
  const configured = process.env.NEXTAUTH_SECRET?.trim();
  if (
    configured &&
    (process.env.NODE_ENV !== "production" || configured.length >= 16)
  ) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXTAUTH_SECRET must be configured with at least 16 characters for Hire candidate cursors",
    );
  }
  return "dev-only-hire-job-candidate-cursor-secret";
}

function cursorKey(): Buffer {
  return createHash("sha256")
    .update(`hire-job-candidate-cursor:v${CURSOR_VERSION}\0`)
    .update(cursorSecret())
    .digest();
}

function canonicalQuery(
  workspaceId: string,
  jobId: string,
  query: HireJobCandidateNormalizedQuery,
  limit: number,
): string {
  return JSON.stringify({
    workspaceId,
    jobId,
    q: query.q ?? "",
    view: query.view,
    stage: [...query.stage].sort(),
    source: [...query.source].sort(),
    scoreState: [...query.scoreState].sort(),
    scoreMin: query.scoreMin ?? null,
    scoreMax: query.scoreMax ?? null,
    humanReview: [...query.humanReview].sort(),
    aiInterview: [...query.aiInterview].sort(),
    history: query.history ?? "",
    appliedFrom: query.appliedFrom ?? "",
    appliedTo: query.appliedTo ?? "",
    sort: query.sort,
    direction: query.direction,
    limit,
  });
}

function queryFingerprint(
  workspaceId: string,
  jobId: string,
  query: HireJobCandidateNormalizedQuery,
  limit: number,
): string {
  return createHash("sha256")
    .update(canonicalQuery(workspaceId, jobId, query, limit))
    .digest("hex");
}

function invalidCursor(): HireJobCandidateReadError {
  return new HireJobCandidateReadError(
    "Candidate cursor is invalid or does not match this query",
    "JOB_CANDIDATES_INVALID_CURSOR",
  );
}

function staleCursor(): HireJobCandidateReadError {
  return new HireJobCandidateReadError(
    "Candidate results changed; refresh the list",
    "JOB_CANDIDATES_CURSOR_STALE",
    409,
  );
}

function decodeCursorPart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  const decoded = Buffer.from(value, "base64url");
  // Reject alternate encodings with non-zero/ignored padding bits so a token
  // has one canonical representation as well as authenticated bytes.
  if (decoded.toString("base64url") !== value) throw invalidCursor();
  return decoded;
}

function parseCursor(
  token: string | undefined,
  expectedFingerprint: string,
  now: Date,
  sort: HireJobCandidateNormalizedQuery["sort"],
  revision: CandidateRevision,
): CandidateCursor | null {
  if (token === undefined) return null;
  if (!token || token.length > 2048) throw invalidCursor();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw invalidCursor();
  let value: unknown;
  try {
    const iv = decodeCursorPart(parts[0]);
    const ciphertext = decodeCursorPart(parts[1]);
    const authTag = decodeCursorPart(parts[2]);
    if (
      iv.length !== CURSOR_IV_BYTES ||
      authTag.length !== CURSOR_AUTH_TAG_BYTES ||
      ciphertext.length === 0
    ) {
      throw invalidCursor();
    }
    const decipher = createDecipheriv("aes-256-gcm", cursorKey(), iv);
    decipher.setAAD(Buffer.from(`hire-job-candidate-cursor:v${CURSOR_VERSION}`));
    decipher.setAuthTag(authTag);
    value = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      ),
    );
  } catch (error) {
    if (error instanceof HireJobCandidateReadError) throw error;
    throw invalidCursor();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCursor();
  }
  const cursor = value as Record<string, unknown>;
  const primary = cursor.p;
  const nameSort = sort === "name";
  if (
    Object.keys(cursor).sort().join(",") !== "a,d,h,i,j,p,v" ||
    cursor.v !== CURSOR_VERSION ||
    cursor.h !== expectedFingerprint ||
    typeof cursor.a !== "number" ||
    !Number.isFinite(cursor.a) ||
    cursor.a > now.getTime() + CURSOR_FUTURE_SKEW_MS ||
    cursor.a < now.getTime() - CURSOR_MAX_AGE_MS ||
    typeof cursor.i !== "string" ||
    !mongoose.Types.ObjectId.isValid(cursor.i) ||
    typeof cursor.j !== "number" || !Number.isSafeInteger(cursor.j) || cursor.j < 0 ||
    typeof cursor.d !== "number" || !Number.isSafeInteger(cursor.d) || cursor.d < 0 ||
    (nameSort
      ? typeof primary !== "string" || primary.length > 254
      : typeof primary !== "number" || !Number.isFinite(primary))
  ) {
    throw invalidCursor();
  }
  const parsed = cursor as CandidateCursor;
  if (parsed.j !== revision.j || parsed.d !== revision.d) throw staleCursor();
  return parsed;
}

function encodeCursor(
  row: Pick<RawCandidateRow, "_id" | "_sortPrimary">,
  fingerprint: string,
  snapshotAt: Date,
  revision: CandidateRevision,
): string {
  const payload: CandidateCursor = {
    v: CURSOR_VERSION,
    h: fingerprint,
    a: snapshotAt.getTime(),
    p: row._sortPrimary,
    i: recordId(row._id),
    ...revision,
  };
  const iv = randomBytes(CURSOR_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", cursorKey(), iv);
  cipher.setAAD(Buffer.from(`hire-job-candidate-cursor:v${CURSOR_VERSION}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

function excludeHireOnboardingTestDrives(): PipelineStage[] {
  return buildHireOnboardingTestDriveExclusionStages({
    coordinate: "applicationId",
  }) as unknown as PipelineStage[];
}

function candidateLookup(includeIdentity: boolean): PipelineStage {
  return {
    $lookup: {
      from: HireCandidate.collection.name,
      let: { candidateId: "$candidateId", workspaceId: "$workspaceId" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ["$_id", "$$candidateId"] },
                { $eq: ["$workspaceId", "$$workspaceId"] },
              ],
            },
            piiAnonymizedAt: { $exists: false },
          },
        },
        {
          $project: {
            _id: 1,
            source: 1,
            sourceHistory: 1,
            ...(includeIdentity ? { name: 1, email: 1 } : {}),
          },
        },
      ],
      as: "_candidate",
    },
  } as PipelineStage;
}

function livePrivacyLookup(now: Date): PipelineStage {
  return {
    $lookup: {
      from: HirePrivacyRequest.collection.name,
      let: { candidateId: "$candidateId", workspaceId: "$workspaceId" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ["$candidateId", "$$candidateId"] },
                { $eq: ["$workspaceId", "$$workspaceId"] },
              ],
            },
            live: true,
            $or: [
              { status: "processing" },
              {
                status: "pending_verification",
                verificationExpiresAt: { $gt: now },
              },
            ],
          },
        },
        { $limit: 1 },
        { $project: { _id: 1 } },
      ],
      as: "_livePrivacyRequest",
    },
  } as PipelineStage;
}

function baseCandidatePipeline(input: {
  workspaceId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  jdHash: string;
  snapshotAt: Date;
  includeIdentity: boolean;
  includeDetails?: boolean;
  includeRank?: boolean;
  createdAfter?: Date;
  applicationIds?: mongoose.Types.ObjectId[];
}): PipelineStage[] {
  const scoringPipeline: PipelineStage[] = [
    {
      $match: {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        createdAt: input.createdAfter
          ? { $gte: input.createdAfter, $lte: input.snapshotAt }
          : { $lt: input.snapshotAt },
        ...(input.applicationIds ? { _id: { $in: input.applicationIds } } : {}),
      },
    },
    {
      // Drop resume bodies, event arrays, decision notes, and unrelated fields
      // before windowing or any per-row join. A 1,000-row list must not carry
      // the write aggregate's large evidence payload through memory.
      $project: {
        _id: 1,
        workspaceId: 1,
        jobId: 1,
        candidateId: 1,
        stage: 1,
        "resumeMatch.score": 1,
        "resumeMatch.stale": 1,
        "resumeMatch.jdHash": 1,
        "resumeMatch.scoredAt": 1,
        createdAt: 1,
        _applicationActivityAt: {
          $max: [
            "$createdAt",
            "$resumeMatch.scoredAt",
            "$offerDecision.at",
            { $max: "$events.at" },
            { $max: "$applicantSubmissions.submittedAt" },
          ],
        },
      },
    },
    ...excludeHireOnboardingTestDrives(),
    candidateLookup(input.includeIdentity),
    { $unwind: "$_candidate" },
    livePrivacyLookup(input.snapshotAt),
    { $match: { _livePrivacyRequest: { $eq: [] } } },
    {
      $lookup: {
        from: HireIntakeTask.collection.name,
        let: {
          applicationId: "$_id",
          jobId: "$jobId",
          workspaceId: "$workspaceId",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$applicationId", "$$applicationId"] },
                  { $eq: ["$jobId", "$$jobId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                ],
              },
              status: { $in: ["queued", "processing"] },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "_pendingScoring",
      },
    } as PipelineStage,
    {
      $set: {
        _jdScore: {
          $cond: [
            {
              $and: [
                { $eq: [{ $size: "$_pendingScoring" }, 0] },
                { $isNumber: "$resumeMatch.score" },
              ],
            },
            "$resumeMatch.score",
            null,
          ],
        },
        _jdState: {
          $switch: {
            branches: [
              {
                case: { $gt: [{ $size: "$_pendingScoring" }, 0] },
                then: "pending",
              },
              {
                case: { $not: [{ $isNumber: "$resumeMatch.score" }] },
                then: "unscored",
              },
              {
                case: {
                  $or: [
                    { $eq: ["$resumeMatch.stale", true] },
                    { $ne: ["$resumeMatch.jdHash", input.jdHash] },
                  ],
                },
                then: "stale",
              },
            ],
            default: "fresh",
          },
        },
      },
    },
  ];
  if (input.includeDetails === false) return scoringPipeline;
  return [
    ...scoringPipeline,
    ...(input.includeRank === false
      ? []
      : [
          {
            $setWindowFields: {
              partitionBy: "$_jdState",
              sortBy: { _jdScore: -1 },
              output: {
                _partitionRank: { $rank: {} },
                _partitionCount: {
                  $count: {},
                  window: { documents: ["unbounded", "unbounded"] },
                },
              },
            },
          } as PipelineStage,
          {
            $set: {
              _globalRank: {
                $cond: [
                  { $eq: ["$_jdState", "fresh"] },
                  "$_partitionRank",
                  null,
                ],
              },
            },
          } as PipelineStage,
        ]),
    {
      $lookup: {
        from: HireHumanRound.collection.name,
        let: {
          applicationId: "$_id",
          jobId: "$jobId",
          workspaceId: "$workspaceId",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$applicationId", "$$applicationId"] },
                  { $eq: ["$jobId", "$$jobId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                ],
              },
              privacyRedactedAt: { $exists: false },
            },
          },
          {
            $group: {
              _id: null,
              total: {
                $sum: { $cond: [{ $ne: ["$status", "revoked"] }, 1, 0] },
              },
              completed: {
                $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
              },
              pending: {
                $sum: {
                  $cond: [{ $eq: ["$status", "pending_scorecard"] }, 1, 0],
                },
              },
              activityAt: {
                $max: {
                  $max: [
                    "$createdAt",
                    "$openedAt",
                    "$scorecardSubmittedAt",
                    "$revokedAt",
                  ],
                },
              },
            },
          },
        ],
        as: "_humanRounds",
      },
    } as PipelineStage,
    {
      $lookup: {
        from: HireHumanScorecard.collection.name,
        let: {
          applicationId: "$_id",
          jobId: "$jobId",
          workspaceId: "$workspaceId",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$applicationId", "$$applicationId"] },
                  { $eq: ["$jobId", "$$jobId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                ],
              },
              status: "submitted",
              privacyRedactedAt: { $exists: false },
            },
          },
          {
            $group: {
              _id: null,
              submitted: { $sum: 1 },
              strongYes: {
                $sum: {
                  $cond: [{ $eq: ["$recommendation", "strong_yes"] }, 1, 0],
                },
              },
              yes: {
                $sum: { $cond: [{ $eq: ["$recommendation", "yes"] }, 1, 0] },
              },
              no: {
                $sum: { $cond: [{ $eq: ["$recommendation", "no"] }, 1, 0] },
              },
              strongNo: {
                $sum: {
                  $cond: [{ $eq: ["$recommendation", "strong_no"] }, 1, 0],
                },
              },
              activityAt: { $max: "$submittedAt" },
            },
          },
        ],
        as: "_scorecards",
      },
    } as PipelineStage,
    {
      $lookup: {
        from: HireRound.collection.name,
        let: {
          applicationId: "$_id",
          jobId: "$jobId",
          workspaceId: "$workspaceId",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$applicationId", "$$applicationId"] },
                  { $eq: ["$jobId", "$$jobId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                ],
              },
            },
          },
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 1 },
          {
            $project: {
              _id: 1,
              status: 1,
              "results.overallScore": 1,
              activityAt: {
                $max: [
                  "$createdAt", "$invitedAt", "$consentAt", "$preparedAt",
                  "$linkedAt", "$revokedAt", "$results.sessionCompletedAt",
                ],
              },
            },
          },
        ],
        as: "_latestAiRound",
      },
    } as PipelineStage,
    {
      $lookup: {
        from: HireApplication.collection.name,
        let: {
          candidateId: "$candidateId",
          jobId: "$jobId",
          workspaceId: "$workspaceId",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$candidateId", "$$candidateId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                  { $ne: ["$jobId", "$$jobId"] },
                ],
              },
            },
          },
          { $project: { _id: 1, workspaceId: 1 } },
          ...excludeHireOnboardingTestDrives(),
          { $count: "count" },
        ],
        as: "_workspaceHistory",
      },
    } as PipelineStage,
    {
      $set: {
        _humanRound: {
          $ifNull: [{ $arrayElemAt: ["$_humanRounds", 0] }, {}],
        },
        _scorecard: {
          $ifNull: [{ $arrayElemAt: ["$_scorecards", 0] }, {}],
        },
        _aiRound: { $arrayElemAt: ["$_latestAiRound", 0] },
        _historyCount: {
          $ifNull: [
            {
              $getField: {
                field: "count",
                input: { $arrayElemAt: ["$_workspaceHistory", 0] },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $set: {
        _humanDisagreement: {
          $and: [
            {
              $gt: [
                {
                  $add: [
                    { $ifNull: ["$_scorecard.strongYes", 0] },
                    { $ifNull: ["$_scorecard.yes", 0] },
                  ],
                },
                0,
              ],
            },
            {
              $gt: [
                {
                  $add: [
                    { $ifNull: ["$_scorecard.no", 0] },
                    { $ifNull: ["$_scorecard.strongNo", 0] },
                  ],
                },
                0,
              ],
            },
          ],
        },
        _humanState: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [
                    { $gt: [{ $ifNull: ["$_humanRound.pending", 0] }, 0] },
                    { $gt: [{ $ifNull: ["$_scorecard.submitted", 0] }, 0] },
                  ],
                },
                then: "mixed",
              },
              {
                case: {
                  $gt: [{ $ifNull: ["$_humanRound.pending", 0] }, 0],
                },
                then: "pending",
              },
              {
                case: {
                  $gt: [{ $ifNull: ["$_scorecard.submitted", 0] }, 0],
                },
                then: "complete",
              },
            ],
            default: "none",
          },
        },
        _aiState: {
          $switch: {
            branches: [
              { case: { $eq: ["$_aiRound.status", "revoked"] }, then: "revoked" },
              {
                case: { $eq: ["$_aiRound.status", "completed"] },
                then: "completed",
              },
              { case: { $eq: ["$_aiRound.status", "invited"] }, then: "invited" },
              {
                case: { $ne: [{ $type: "$_aiRound.status" }, "missing"] },
                then: "in_progress",
              },
            ],
            default: "not_invited",
          },
        },
      },
    },
    {
      $set: {
        _attention: {
          $concatArrays: [
            {
              $cond: [
                { $eq: ["$_jdState", "pending"] },
                ["scoring_pending"],
                [],
              ],
            },
            {
              $cond: [
                { $eq: ["$_jdState", "stale"] },
                ["scoring_stale"],
                [],
              ],
            },
            {
              $cond: [
                { $eq: ["$_jdState", "unscored"] },
                ["scoring_unscored"],
                [],
              ],
            },
            { $cond: [{ $eq: ["$stage", "new"] }, ["screening_pending"], []] },
            {
              $cond: [
                {
                  $and: [
                    { $eq: ["$stage", "interviewing"] },
                    { $ne: ["$_aiState", "completed"] },
                  ],
                },
                ["interview_pending"],
                [],
              ],
            },
            {
              $cond: [
                { $gt: [{ $ifNull: ["$_humanRound.pending", 0] }, 0] },
                ["human_scorecard_pending"],
                [],
              ],
            },
            { $cond: [{ $eq: ["$stage", "shortlist"] }, ["decision_ready"], []] },
            { $cond: [{ $eq: ["$stage", "offer"] }, ["offer_pending"], []] },
          ],
        },
        _attentionPriority: {
          $max: [
            { $cond: [{ $eq: ["$_jdState", "pending"] }, 80, 0] },
            { $cond: [{ $eq: ["$_jdState", "stale"] }, 70, 0] },
            { $cond: [{ $eq: ["$_jdState", "unscored"] }, 60, 0] },
            {
              $cond: [
                { $gt: [{ $ifNull: ["$_humanRound.pending", 0] }, 0] },
                50,
                0,
              ],
            },
            { $cond: [{ $eq: ["$stage", "interviewing"] }, 40, 0] },
            { $cond: [{ $eq: ["$stage", "new"] }, 30, 0] },
            { $cond: [{ $eq: ["$stage", "shortlist"] }, 20, 0] },
            { $cond: [{ $eq: ["$stage", "offer"] }, 10, 0] },
          ],
        },
        _lastActivityAt: {
          $max: [
            "$_applicationActivityAt",
            "$_humanRound.activityAt",
            "$_scorecard.activityAt",
            "$_aiRound.activityAt",
          ],
        },
      },
    },
  ];
}

function viewMatch(view: HireJobCandidateNormalizedQuery["view"]): Record<string, unknown> {
  if (view === "scoring_attention") return { _jdState: { $ne: "fresh" } };
  if (view === "screening_attention") return { stage: "new" };
  if (view === "interview_attention") return { stage: "interviewing" };
  if (view === "decision_ready") return { stage: "shortlist" };
  if (view === "offers") return { stage: "offer" };
  return {};
}

function filterMatch(query: HireJobCandidateNormalizedQuery): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  const selectedView = viewMatch(query.view);
  if (Object.keys(selectedView).length > 0) clauses.push(selectedView);
  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const search = new RegExp(escaped, "i");
    clauses.push({
      $or: [{ "_candidate.name": search }, { "_candidate.email": search }],
    });
  }
  if (query.stage.length > 0) clauses.push({ stage: { $in: query.stage } });
  if (query.source.length > 0) {
    clauses.push({
      $or: [
        { "_candidate.source": { $in: query.source } },
        { "_candidate.sourceHistory": { $in: query.source } },
      ],
    });
  }
  if (query.scoreState.length > 0) {
    clauses.push({ _jdState: { $in: query.scoreState } });
  }
  if (query.scoreMin !== undefined || query.scoreMax !== undefined) {
    clauses.push({
      _jdState: "fresh",
      _jdScore: {
        ...(query.scoreMin !== undefined ? { $gte: query.scoreMin } : {}),
        ...(query.scoreMax !== undefined ? { $lte: query.scoreMax } : {}),
      },
    });
  }
  if (query.humanReview.length > 0) {
    const states = query.humanReview.filter(
      (state): state is Exclude<HireJobCandidateHumanReviewState, "disagreement"> =>
        state !== "disagreement",
    );
    clauses.push({
      $or: [
        ...(states.length > 0 ? [{ _humanState: { $in: states } }] : []),
        ...(query.humanReview.includes("disagreement")
          ? [{ _humanDisagreement: true }]
          : []),
      ],
    });
  }
  if (query.aiInterview.length > 0) {
    clauses.push({ _aiState: { $in: query.aiInterview } });
  }
  if (query.history === "first_time") clauses.push({ _historyCount: 0 });
  if (query.history === "returning") clauses.push({ _historyCount: { $gt: 0 } });
  if (query.appliedFrom || query.appliedTo) {
    const createdAt: Record<string, Date> = {};
    if (query.appliedFrom) {
      createdAt.$gte = new Date(`${query.appliedFrom}T00:00:00.000Z`);
    }
    if (query.appliedTo) {
      const exclusive = new Date(`${query.appliedTo}T00:00:00.000Z`);
      exclusive.setUTCDate(exclusive.getUTCDate() + 1);
      createdAt.$lt = exclusive;
    }
    clauses.push({ createdAt });
  }
  return clauses.length === 0 ? {} : { $and: clauses };
}

function sortPrimaryExpression(
  sort: HireJobCandidateNormalizedQuery["sort"],
): unknown {
  if (sort === "name") return { $toLower: { $ifNull: ["$_candidate.name", ""] } };
  if (sort === "stage") return { $indexOfArray: [HIRE_STAGES, "$stage"] };
  if (sort === "jd_match") {
    return { $cond: [{ $eq: ["$_jdState", "fresh"] }, "$_jdScore", -1] };
  }
  if (sort === "rank") return { $ifNull: ["$_globalRank", 2_147_483_647] };
  if (sort === "human_review") {
    return {
      $switch: {
        branches: [
          { case: "$_humanDisagreement", then: 5 },
          { case: { $eq: ["$_humanState", "pending"] }, then: 4 },
          { case: { $eq: ["$_humanState", "mixed"] }, then: 3 },
          { case: { $eq: ["$_humanState", "complete"] }, then: 2 },
        ],
        default: 1,
      },
    };
  }
  if (sort === "last_activity") return { $toLong: "$_lastActivityAt" };
  if (sort === "newest" || sort === "oldest") return { $toLong: "$createdAt" };
  return "$_attentionPriority";
}

function sortDirection(query: HireJobCandidateNormalizedQuery): 1 | -1 {
  return query.direction === "asc" ? 1 : -1;
}

function orderedRowsPipeline(input: {
  query: HireJobCandidateNormalizedQuery;
  cursor: CandidateCursor | null;
  take: number;
  includeIdentity: boolean;
  identityOnly?: boolean;
}): PipelineStage[] {
  const direction = sortDirection(input.query);
  const comparison = direction === 1 ? "$gt" : "$lt";
  return [
    { $match: filterMatch(input.query) },
    { $set: { _sortPrimary: sortPrimaryExpression(input.query.sort) } },
    ...(input.cursor
      ? [
          {
            $match: {
              $expr: {
                $or: [
                  { [comparison]: ["$_sortPrimary", input.cursor.p] },
                  {
                    $and: [
                      { $eq: ["$_sortPrimary", input.cursor.p] },
                      {
                        [comparison]: [
                          "$_id",
                          new mongoose.Types.ObjectId(input.cursor.i),
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          } as PipelineStage,
        ]
      : []),
    { $sort: { _sortPrimary: direction, _id: direction } },
    { $limit: input.take },
    {
      $project: input.identityOnly
        ? {
            _id: 1,
            applicationId: { $toString: "$_id" },
            candidateName: "$_candidate.name",
            candidateEmail: "$_candidate.email",
            _sortPrimary: 1,
          }
        : {
        _id: 1,
        applicationId: { $toString: "$_id" },
        ...(input.includeIdentity
          ? {
              candidate: {
                id: { $toString: "$_candidate._id" },
                name: "$_candidate.name",
                email: "$_candidate.email",
              },
            }
          : {}),
        stage: 1,
        source: { $ifNull: ["$_candidate.source", "manual"] },
        sourceHistory: {
          $setUnion: [
            { $ifNull: ["$_candidate.sourceHistory", []] },
            [{ $ifNull: ["$_candidate.source", "manual"] }],
          ],
        },
        appliedAt: "$createdAt",
        lastActivityAt: "$_lastActivityAt",
        attention: "$_attention",
        jdMatch: {
          state: "$_jdState",
          score: { $cond: [{ $eq: ["$_jdState", "fresh"] }, "$_jdScore", null] },
          rank: "$_globalRank",
          denominator: {
            $cond: [
              { $eq: ["$_jdState", "fresh"] },
              "$_partitionCount",
              null,
            ],
          },
          scoredAt: { $ifNull: ["$resumeMatch.scoredAt", null] },
        },
        humanReview: {
          state: "$_humanState",
          total: { $ifNull: ["$_humanRound.total", 0] },
          submitted: { $ifNull: ["$_scorecard.submitted", 0] },
          pending: { $ifNull: ["$_humanRound.pending", 0] },
          recommendations: {
            strongYes: { $ifNull: ["$_scorecard.strongYes", 0] },
            yes: { $ifNull: ["$_scorecard.yes", 0] },
            no: { $ifNull: ["$_scorecard.no", 0] },
            strongNo: { $ifNull: ["$_scorecard.strongNo", 0] },
          },
          disagreement: "$_humanDisagreement",
        },
        aiInterview: {
          state: "$_aiState",
          overallScore: {
            $cond: [
              { $eq: ["$_aiState", "completed"] },
              { $ifNull: ["$_aiRound.results.overallScore", null] },
              null,
            ],
          },
          updatedAt: { $ifNull: ["$_aiRound.activityAt", null] },
        },
        workspaceHistory: { previousApplications: "$_historyCount" },
        _sortPrimary: 1,
          },
    },
  ];
}

function countFacets(query: HireJobCandidateNormalizedQuery): Record<string, PipelineStage[]> {
  return {
    total: [{ $count: "count" }],
    matching: [{ $match: filterMatch(query) }, { $count: "count" }],
    stages: [{ $group: { _id: "$stage", count: { $sum: 1 } } }],
    jdMatch: [{ $group: { _id: "$_jdState", count: { $sum: 1 } } }],
    savedViews: [
      {
        $group: {
          _id: null,
          all: { $sum: 1 },
          scoring_attention: {
            $sum: { $cond: [{ $ne: ["$_jdState", "fresh"] }, 1, 0] },
          },
          screening_attention: {
            $sum: { $cond: [{ $eq: ["$stage", "new"] }, 1, 0] },
          },
          interview_attention: {
            $sum: { $cond: [{ $eq: ["$stage", "interviewing"] }, 1, 0] },
          },
          decision_ready: {
            $sum: { $cond: [{ $eq: ["$stage", "shortlist"] }, 1, 0] },
          },
          offers: { $sum: { $cond: [{ $eq: ["$stage", "offer"] }, 1, 0] } },
        },
      },
    ],
  };
}

function completeCounts(raw: RawCounts): HireJobCandidateCounts {
  const stages = Object.fromEntries(HIRE_STAGES.map((stage) => [stage, 0])) as Record<
    HireStage,
    number
  >;
  for (const item of raw.stages ?? []) {
    if (HIRE_STAGES.includes(item._id)) stages[item._id] = item.count;
  }
  const jdMatch = Object.fromEntries(
    HIRE_JOB_CANDIDATE_JD_STATES.map((state) => [state, 0]),
  ) as Record<HireJobCandidateJdState, number>;
  for (const item of raw.jdMatch ?? []) {
    if (HIRE_JOB_CANDIDATE_JD_STATES.includes(item._id)) {
      jdMatch[item._id] = item.count;
    }
  }
  const rawViews = raw.savedViews?.[0] ?? {};
  const savedViews = Object.fromEntries(
    HIRE_JOB_CANDIDATE_VIEWS.map((view) => [view, Number(rawViews[view]) || 0]),
  ) as HireJobCandidateCounts["savedViews"];
  return {
    total: raw.total?.[0]?.count ?? 0,
    matching: raw.matching?.[0]?.count ?? 0,
    stages,
    jdMatch,
    savedViews,
  };
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function candidateRow(raw: RawCandidateRow): HireJobCandidateRow {
  if (
    !raw.candidate ||
    typeof raw.candidate.id !== "string" ||
    typeof raw.candidate.name !== "string" ||
    typeof raw.candidate.email !== "string" ||
    !HIRE_STAGES.includes(raw.stage) ||
    !HIRE_JOB_CANDIDATE_SOURCES.includes(raw.source) ||
    !validDate(raw.appliedAt) ||
    !validDate(raw.lastActivityAt) ||
    !HIRE_JOB_CANDIDATE_JD_STATES.includes(raw.jdMatch?.state) ||
    (raw.jdMatch.state === "fresh" &&
      (typeof raw.jdMatch.score !== "number" ||
        !Number.isFinite(raw.jdMatch.score) ||
        !Number.isInteger(raw.jdMatch.rank) ||
        !Number.isInteger(raw.jdMatch.denominator) ||
        (raw.jdMatch.rank ?? 0) < 1 ||
        (raw.jdMatch.denominator ?? 0) < (raw.jdMatch.rank ?? 0))) ||
    !HIRE_JOB_CANDIDATE_AI_INTERVIEW_STATES.includes(raw.aiInterview?.state) ||
    !HIRE_JOB_CANDIDATE_HUMAN_REVIEW_STATES.includes(raw.humanReview?.state)
  ) {
    throw new Error("Malformed candidate read projection");
  }
  return {
    applicationId: raw.applicationId,
    candidate: raw.candidate,
    stage: raw.stage,
    source: raw.source,
    sourceHistory: (raw.sourceHistory ?? []).filter((source) =>
      HIRE_JOB_CANDIDATE_SOURCES.includes(source),
    ),
    appliedAt: raw.appliedAt.toISOString(),
    lastActivityAt: raw.lastActivityAt.toISOString(),
    attention: (raw.attention ?? []).filter((kind) =>
      HIRE_JOB_CANDIDATE_ATTENTION_KINDS.includes(kind),
    ),
    jdMatch: {
      state: raw.jdMatch.state,
      score:
        raw.jdMatch.state === "fresh" &&
        typeof raw.jdMatch.score === "number" &&
        Number.isFinite(raw.jdMatch.score)
          ? raw.jdMatch.score
          : null,
      rank:
        raw.jdMatch.state === "fresh" &&
        typeof raw.jdMatch.rank === "number" &&
        Number.isInteger(raw.jdMatch.rank)
          ? raw.jdMatch.rank
          : null,
      denominator:
        raw.jdMatch.state === "fresh" &&
        typeof raw.jdMatch.denominator === "number" &&
        Number.isInteger(raw.jdMatch.denominator)
          ? raw.jdMatch.denominator
          : null,
      scoredAt: validDate(raw.jdMatch.scoredAt)
        ? raw.jdMatch.scoredAt.toISOString()
        : null,
    },
    humanReview: raw.humanReview,
    aiInterview: {
      state: raw.aiInterview.state,
      overallScore:
        typeof raw.aiInterview.overallScore === "number" &&
        Number.isFinite(raw.aiInterview.overallScore)
          ? raw.aiInterview.overallScore
          : null,
      updatedAt: validDate(raw.aiInterview.updatedAt)
        ? raw.aiInterview.updatedAt.toISOString()
        : null,
    },
    workspaceHistory: {
      previousApplications: Math.max(
        0,
        Number(raw.workspaceHistory?.previousApplications) || 0,
      ),
    },
  };
}

async function scopedJob(
  workspaceId: mongoose.Types.ObjectId,
  jobId: mongoose.Types.ObjectId,
  session?: ClientSession,
): Promise<CandidateJobRecord> {
  const query = HireJob.findOne({ _id: jobId, workspaceId }).select(
    "_id departmentId title jdText status applyPageEnabled candidateReadVersion createdAt",
  );
  if (session) query.session(session);
  const job = await query.lean<CandidateJobRecord>();
  if (!job) {
    throw new HireJobCandidateReadError(
      "Job not found",
      "JOB_CANDIDATES_SCOPE_NOT_FOUND",
      404,
    );
  }
  return job;
}

function version(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function scopedCandidateState(
  workspaceId: mongoose.Types.ObjectId,
  jobId: mongoose.Types.ObjectId,
): Promise<{ job: CandidateJobRecord; revision: CandidateRevision }> {
  const [job, workspace] = await Promise.all([
    scopedJob(workspaceId, jobId),
    HireWorkspace.findOne({ _id: workspaceId }).select("privacyAggregateFenceVersion").lean<{
      privacyAggregateFenceVersion?: number;
    }>(),
  ]);
  if (!workspace) {
    throw new HireJobCandidateReadError(
      "Workspace not found", "JOB_CANDIDATES_SCOPE_NOT_FOUND", 404,
    );
  }
  return {
    job,
    revision: { j: version(job.candidateReadVersion), d: version(workspace.privacyAggregateFenceVersion) },
  };
}

function assertRevision(current: CandidateRevision, expected: CandidateRevision): void {
  if (current.j !== expected.j || current.d !== expected.d) throw staleCursor();
}

async function hasNewerVisibleCandidate(input: {
  workspaceId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  snapshotAt: Date;
  now: Date;
  jdHash: string;
  query: HireJobCandidateNormalizedQuery;
}): Promise<boolean> {
  const includeDetails = input.query.humanReview.length > 0 ||
    input.query.aiInterview.length > 0 || input.query.history !== undefined;
  const rows = await HireApplication.aggregate<{ _id: mongoose.Types.ObjectId }>([
    ...baseCandidatePipeline({
      workspaceId: input.workspaceId, jobId: input.jobId, jdHash: input.jdHash,
      snapshotAt: input.now, createdAfter: input.snapshotAt,
      includeIdentity: Boolean(input.query.q), includeDetails, includeRank: false,
    }),
    { $match: filterMatch(input.query) },
    { $limit: 1 },
    { $project: { _id: 1 } },
  ])
    .option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS })
    .allowDiskUse(false);
  return rows.length > 0;
}

export async function readHireJobCandidateFreshness(input: {
  workspaceId: string;
  jobId: string;
  query: HireJobCandidateFreshnessQuery;
  now?: Date;
}): Promise<HireJobCandidateFreshness> {
  const now = normalizedNow(input.now);
  const snapshotAt = new Date(input.query.snapshotAt);
  if (!validDate(snapshotAt) || snapshotAt > now ||
      snapshotAt.getTime() < now.getTime() - CURSOR_MAX_AGE_MS) {
    throw new HireJobCandidateReadError("Invalid freshness timestamp", "JOB_CANDIDATES_INVALID_SCOPE");
  }
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const jobId = objectId(input.jobId, "job id");
  const { snapshotAt: _snapshotAt, ...rawQuery } = input.query;
  const query = canonicalCandidateQuery(rawQuery);
  await connectHireOperationsDB();
  const job = await scopedJob(workspaceId, jobId);
  const hasNewerResults = await hasNewerVisibleCandidate({
    workspaceId, jobId, snapshotAt, now, query,
    jdHash: createHash("sha256").update(job.jdText).digest("hex"),
  });
  return { hasNewerResults, checkedAt: now.toISOString() };
}

export async function readHireJobCandidates(input: {
  workspaceId: string;
  jobId: string;
  query: HireJobCandidateQuery;
  now?: Date;
}): Promise<HireJobCandidatePage> {
  const now = normalizedNow(input.now);
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const jobId = objectId(input.jobId, "job id");
  const normalized = candidateNormalizedQuery(input.query);
  const fingerprint = queryFingerprint(
    input.workspaceId,
    input.jobId,
    normalized,
    input.query.limit,
  );
  await connectHireOperationsDB();
  const { job, revision } = await scopedCandidateState(workspaceId, jobId);
  const cursor = parseCursor(
    input.query.cursor, fingerprint, now, normalized.sort, revision,
  );
  const snapshotAt = cursor ? new Date(cursor.a) : now;
  const jdHash = createHash("sha256").update(job.jdText).digest("hex");
  const pipeline = [
    ...baseCandidatePipeline({
      workspaceId,
      jobId,
      jdHash,
      snapshotAt,
      includeIdentity: true,
    }),
    ...orderedRowsPipeline({
      query: normalized,
      cursor,
      take: input.query.limit + 1,
      includeIdentity: true,
    }),
  ];
  const rawRows = await HireApplication.aggregate<RawCandidateRow>(pipeline)
    .option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS })
    .allowDiskUse(false);
  const hasNextPage = rawRows.length > input.query.limit;
  const selected = rawRows.slice(0, input.query.limit);
  const current = await scopedCandidateState(workspaceId, jobId);
  assertRevision(current.revision, revision);
  return {
    asOf: now.toISOString(),
    job: { jobId: recordId(job._id), title: job.title, status: job.status },
    rows: selected.map(candidateRow),
    pageInfo: {
      limit: input.query.limit,
      hasNextPage,
      nextCursor:
        hasNextPage && selected.length > 0
          ? encodeCursor(selected[selected.length - 1], fingerprint, snapshotAt, revision)
          : null,
      snapshotAt: snapshotAt.toISOString(),
    },
  };
}

/** Purpose-limited member picker for Decisions/Screening: identity only. */
export async function readHireJobCandidateIdentities(input: {
  workspaceId: string;
  jobId: string;
  memberId: string;
  resource: "decision_candidate_search" | "screening_candidate_search";
  query: HireJobCandidateIdentityQuery;
  /** Screening exception pickers must not offer already-decided applications. */
  nonTerminalOnly?: boolean;
  now?: Date;
}): Promise<HireJobCandidateIdentityPage> {
  const now = normalizedNow(input.now);
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const jobId = objectId(input.jobId, "job id");
  const q = input.query.q.trim();
  if (
    q.length < 2 ||
    q.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(q) ||
    !Number.isInteger(input.query.limit) ||
    input.query.limit < 1 ||
    input.query.limit > 20
  ) {
    throw new HireJobCandidateReadError(
      "Invalid candidate identity query",
      "JOB_CANDIDATES_INVALID_SCOPE",
    );
  }
  const normalized: HireJobCandidateNormalizedQuery = {
    q,
    view: "all",
    stage: [], source: [], scoreState: [],
    humanReview: [], aiInterview: [],
    sort: "name", direction: "asc",
  };
  const fingerprint = createHash("sha256")
    .update("hire-job-candidate-identity\0")
    .update(canonicalQuery(input.workspaceId, input.jobId, normalized, input.query.limit))
    .update(`\0${input.resource}\0${input.memberId}`)
    .update(input.nonTerminalOnly ? "\0non-terminal" : "\0all-stages")
    .digest("hex");
  await connectHireOperationsDB();
  const { revision } = await scopedCandidateState(workspaceId, jobId);
  const cursor = parseCursor(input.query.cursor, fingerprint, now, "name", revision);
  const snapshotAt = cursor ? new Date(cursor.a) : now;
  const rows = await HireApplication.aggregate<RawCandidateIdentity>([
    {
      $match: {
        workspaceId,
        jobId,
        createdAt: { $lt: snapshotAt },
        ...(input.nonTerminalOnly
          ? { stage: { $nin: ["hired", "rejected", "withdrawn"] } }
          : {}),
      },
    },
    { $project: { _id: 1, workspaceId: 1, candidateId: 1 } },
    ...excludeHireOnboardingTestDrives(),
    candidateLookup(true),
    { $unwind: "$_candidate" },
    livePrivacyLookup(snapshotAt),
    { $match: { _livePrivacyRequest: { $eq: [] } } },
    ...orderedRowsPipeline({
      query: normalized,
      cursor,
      take: input.query.limit + 1,
      includeIdentity: true,
      identityOnly: true,
    }),
  ])
    .option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS })
    .allowDiskUse(false);
  const selected = rows.slice(0, input.query.limit);
  const current = await scopedCandidateState(workspaceId, jobId);
  assertRevision(current.revision, revision);
  if (selected.some((row) => !row.applicationId || typeof row.candidateName !== "string" || typeof row.candidateEmail !== "string")) {
    throw new Error("Malformed candidate identity projection");
  }
  return {
    candidates: selected.map(({ applicationId, candidateName, candidateEmail }) => ({
      applicationId,
      candidateName,
      candidateEmail,
    })),
    pageInfo: {
      limit: input.query.limit,
      nextCursor:
        rows.length > input.query.limit && selected.length > 0
          ? encodeCursor(selected[selected.length - 1], fingerprint, snapshotAt, revision)
          : null,
    },
  };
}

export async function readHireJobCandidateSummary(input: {
  workspaceId: string;
  jobId: string;
  query: HireJobCandidateNormalizedQuery;
  now?: Date;
}): Promise<HireJobCandidateSummary> {
  const now = normalizedNow(input.now);
  const query = canonicalCandidateQuery(input.query);
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const jobId = objectId(input.jobId, "job id");
  await connectHireOperationsDB();
  const job = await scopedJob(workspaceId, jobId);
  const needsDetailPredicates =
    query.humanReview.length > 0 ||
    query.aiInterview.length > 0 ||
    query.history !== undefined;
  const [result] = await HireApplication.aggregate<RawCounts>([
    ...baseCandidatePipeline({
      workspaceId,
      jobId,
      jdHash: createHash("sha256").update(job.jdText).digest("hex"),
      snapshotAt: now,
      includeIdentity: Boolean(query.q),
      includeDetails: needsDetailPredicates,
      includeRank: false,
    }),
    { $facet: countFacets(query) } as PipelineStage,
  ])
    .option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS })
    .allowDiskUse(false);
  const counts = completeCounts(
    result ?? { total: [], matching: [], stages: [], jdMatch: [], savedViews: [] },
  );
  return {
    asOf: now.toISOString(),
    job: { jobId: recordId(job._id), title: job.title, status: job.status },
    counts,
    rankContext: {
      freshScoredTotal: counts.jdMatch.fresh,
      stale: counts.jdMatch.stale,
      unscored: counts.jdMatch.unscored,
      pending: counts.jdMatch.pending,
    },
  };
}

export async function resolveHireJobCandidateQueryEntries(input: {
  workspaceId: string;
  jobId: string;
  query: HireJobCandidateNormalizedQuery;
  max?: number;
  now?: Date;
  session?: ClientSession;
}): Promise<Array<{ applicationId: string; expectedStage: HireStage }>> {
  const now = normalizedNow(input.now);
  const max = input.max ?? HIRE_JOB_CANDIDATE_SELECTION_MAX;
  if (!Number.isInteger(max) || max < 1 || max > HIRE_JOB_CANDIDATE_SELECTION_MAX) {
    throw new HireJobCandidateReadError(
      "Candidate selection limit is invalid",
      "JOB_CANDIDATES_INVALID_SCOPE",
    );
  }
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const jobId = objectId(input.jobId, "job id");
  await connectHireOperationsDB();
  const job = await scopedJob(workspaceId, jobId, input.session);
  const includeIdentity = Boolean(input.query.q);
  const rows = await HireApplication.aggregate<{
    applicationId: string;
    stage: HireStage;
  }>([
    ...baseCandidatePipeline({
      workspaceId,
      jobId,
      jdHash: createHash("sha256").update(job.jdText).digest("hex"),
      snapshotAt: now,
      includeIdentity,
    }),
    ...orderedRowsPipeline({
      query: input.query,
      cursor: null,
      take: max + 1,
      includeIdentity: false,
    }),
    { $project: { _id: 0, applicationId: 1, stage: 1 } },
  ])
    .option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS,
      ...(input.session ? { session: input.session } : {}) })
    .allowDiskUse(false);
  if (rows.length > max) {
    throw new HireJobCandidateReadError(
      `Selection exceeds the ${max} candidate limit`,
      "JOB_CANDIDATES_SELECTION_TOO_LARGE",
      409,
    );
  }
  return rows.map((row) => ({
    applicationId: row.applicationId,
    expectedStage: row.stage,
  }));
}

export async function resolveExplicitHireJobCandidateEntries(input: {
  workspaceId: string;
  jobId: string;
  applicationIds: string[];
  now?: Date;
  session?: ClientSession;
}): Promise<Array<{ applicationId: string; expectedStage: HireStage }>> {
  const now = normalizedNow(input.now);
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const jobId = objectId(input.jobId, "job id");
  const ids = Array.from(new Set(input.applicationIds)).map((id) =>
    objectId(id, "application id"),
  );
  await connectHireOperationsDB();
  const job = await scopedJob(workspaceId, jobId, input.session);
  const rows = await HireApplication.aggregate<{
    applicationId: string;
    stage: HireStage;
  }>([
    ...baseCandidatePipeline({
      workspaceId,
      jobId,
      jdHash: createHash("sha256").update(job.jdText).digest("hex"),
      snapshotAt: now,
      includeIdentity: false,
      includeDetails: false,
      applicationIds: ids,
    }),
    { $sort: { _id: 1 } },
    { $project: { _id: 0, applicationId: { $toString: "$_id" }, stage: 1 } },
  ])
    .option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS,
      ...(input.session ? { session: input.session } : {}) })
    .allowDiskUse(false);
  if (rows.length !== ids.length) {
    throw new HireJobCandidateReadError(
      "One or more selected applications are unavailable in this job",
      "JOB_CANDIDATES_INVALID_SCOPE",
    );
  }
  return rows.map((row) => ({
    applicationId: row.applicationId,
    expectedStage: row.stage,
  }));
}

const ACTIVITY_KIND_BY_EVENT: Readonly<Record<string, HireJobOverviewActivityKind>> = {
  created: "application_created",
  reapplied: "application_reapplied",
  stage_move: "application_stage_changed",
  ai_round_sent: "ai_interview_sent",
  ai_result_linked: "ai_result_linked",
  human_round_logged: "human_interview_logged",
  human_scorecard_submitted: "human_scorecard_submitted",
};

function daysOpen(createdAt: Date, now: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000),
  );
}

export async function readHireJobOverview(input: {
  workspaceId: string;
  jobId: string;
  now?: Date;
}): Promise<HireJobOverview> {
  const now = normalizedNow(input.now);
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const jobId = objectId(input.jobId, "job id");
  await connectHireOperationsDB();
  const job = await scopedJob(workspaceId, jobId);
  const allQuery: HireJobCandidateNormalizedQuery = {
    view: "all",
    stage: [],
    source: [],
    scoreState: [],
    humanReview: [],
    aiInterview: [],
    sort: "attention",
    direction: "desc",
  };
  const [countsResult, department, recentActivity, latestGate, latestBatch] =
    await Promise.all([
      HireApplication.aggregate<RawCounts>([
        ...baseCandidatePipeline({
          workspaceId,
          jobId,
          jdHash: createHash("sha256").update(job.jdText).digest("hex"),
          snapshotAt: now,
          includeIdentity: false,
          includeDetails: false,
        }),
        { $facet: countFacets(allQuery) } as PipelineStage,
      ])
        .option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS })
        .allowDiskUse(false),
      HireDepartment.findOne({ _id: job.departmentId, workspaceId })
        .select("_id name")
        .lean<{ _id: IdLike; name: string }>(),
      HireApplication.aggregate<{
        applicationId: string;
        eventType: string;
        occurredAt: Date;
        actorName: string;
      }>([
        { $match: { workspaceId, jobId } },
        {
          $project: {
            _id: 1,
            workspaceId: 1,
            candidateId: 1,
            events: 1,
          },
        },
        ...excludeHireOnboardingTestDrives(),
        candidateLookup(false),
        { $unwind: "$_candidate" },
        livePrivacyLookup(now),
        { $match: { _livePrivacyRequest: { $eq: [] } } },
        { $unwind: "$events" },
        { $match: { "events.type": { $in: Object.keys(ACTIVITY_KIND_BY_EVENT) } } },
        { $sort: { "events.at": -1, _id: -1 } },
        { $limit: 12 },
        {
          $project: {
            _id: 0,
            applicationId: { $toString: "$_id" },
            eventType: "$events.type",
            occurredAt: "$events.at",
            actorName: "$events.actorName",
          },
        },
      ]).option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS }),
      HireScreeningGate.findOne({ workspaceId, jobId })
        .sort({ confirmedAt: -1, _id: -1 })
        .select("_id status selectedCount confirmedAt")
        .lean<{
          _id: IdLike;
          status: "confirmed" | "cancelled";
          selectedCount: number;
          confirmedAt: Date;
        }>(),
      HireInvitationBatch.findOne({ workspaceId, jobId })
        .sort({ createdAt: -1, _id: -1 })
        .select("_id status plannedCount sentCount failedCount createdAt")
        .lean<{
          _id: IdLike;
          status: string;
          plannedCount: number;
          sentCount: number;
          failedCount: number;
          createdAt: Date;
        }>(),
    ]);
  const counts = completeCounts(
    countsResult[0] ?? {
      total: [],
      matching: [],
      stages: [],
      jdMatch: [],
      savedViews: [],
    },
  );
  const deliveryGroups = await HireInvitationBatchItem.aggregate<{
    _id: string;
    count: number;
  }>([
    { $match: { workspaceId, jobId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).option({ maxTimeMS: HIRE_JOB_CANDIDATE_AGGREGATION_MAX_TIME_MS });
  const delivery = {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  for (const group of deliveryGroups) {
    if (group._id in delivery) {
      delivery[group._id as keyof typeof delivery] = group.count;
    }
  }
  return {
    asOf: now.toISOString(),
    job: {
      jobId: recordId(job._id),
      title: job.title,
      status: job.status,
      department: {
        id: recordId(job.departmentId),
        name: department?.name ?? "Department unavailable",
      },
      createdAt: job.createdAt.toISOString(),
      daysOpen: daysOpen(job.createdAt, now),
    },
    counts: {
      total: counts.total,
      stages: counts.stages,
      attention: {
        scoring: counts.savedViews.scoring_attention,
        screening: counts.savedViews.screening_attention,
        interview: counts.savedViews.interview_attention,
        decision: counts.savedViews.decision_ready,
        offers: counts.savedViews.offers,
      },
    },
    recentActivity: recentActivity
      .filter(
        (activity) =>
          validDate(activity.occurredAt) &&
          ACTIVITY_KIND_BY_EVENT[activity.eventType] !== undefined,
      )
      .map((activity) => ({
        kind: ACTIVITY_KIND_BY_EVENT[activity.eventType],
        occurredAt: activity.occurredAt.toISOString(),
        actorName: activity.actorName || "System",
        applicationId: activity.applicationId,
      })),
    acquisition: { applyPageEnabled: job.applyPageEnabled === true },
    screening: {
      latestGate:
        latestGate && validDate(latestGate.confirmedAt)
          ? {
              gateId: recordId(latestGate._id),
              status: latestGate.status,
              selectedCount: latestGate.selectedCount,
              confirmedAt: latestGate.confirmedAt.toISOString(),
            }
          : null,
      latestBatch:
        latestBatch && validDate(latestBatch.createdAt)
          ? {
              batchId: recordId(latestBatch._id),
              status: latestBatch.status,
              plannedCount: latestBatch.plannedCount,
              sentCount: latestBatch.sentCount,
              failedCount: latestBatch.failedCount,
              createdAt: latestBatch.createdAt.toISOString(),
            }
          : null,
      delivery,
    },
  };
}
