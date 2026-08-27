import { z } from "zod";
import { HIRE_STAGES } from "@hire-operations-boundary";
import {
  HIRE_CANDIDATE_SELECTION_MODES,
  HIRE_JOB_CANDIDATE_AI_INTERVIEW_STATES,
  HIRE_JOB_CANDIDATE_HISTORY_STATES,
  HIRE_JOB_CANDIDATE_HUMAN_REVIEW_STATES,
  HIRE_JOB_CANDIDATE_JD_STATES,
  HIRE_JOB_CANDIDATE_SORTS,
  HIRE_JOB_CANDIDATE_SOURCES,
  HIRE_JOB_CANDIDATE_VIEWS,
  type HireJobCandidateNormalizedQuery,
  type HireJobCandidateFreshnessQuery,
  type HireJobCandidateQuery,
  type HireJobCandidateSort,
} from "../candidateTypes";

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const isoDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "Invalid calendar date");

function csvValues<T extends readonly [string, ...string[]]>(values: T) {
  const allowed = new Set<string>(values);
  return z.preprocess(
    (value) => (value === undefined ? "" : value),
    z.string().trim().max(400).transform((value, ctx) => {
      if (!value) return [] as Array<T[number]>;
      const parsed = Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
      if (parsed.some((item) => !allowed.has(item))) {
        ctx.addIssue({ code: "custom", message: "Unsupported filter value" });
        return z.NEVER;
      }
      return parsed as Array<T[number]>;
    }),
  );
}

function uniqueValues<T extends readonly [string, ...string[]]>(values: T) {
  return z.array(z.enum(values)).max(values.length)
    .refine((items) => new Set(items).size === items.length, "Duplicate filter value")
    .default([]);
}

const canonicalQueryShape = {
  q: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Invalid search")
    .optional(),
  view: z.enum(HIRE_JOB_CANDIDATE_VIEWS).default("all"),
  stage: uniqueValues(HIRE_STAGES),
  source: uniqueValues(HIRE_JOB_CANDIDATE_SOURCES),
  scoreState: uniqueValues(HIRE_JOB_CANDIDATE_JD_STATES),
  scoreMin: z.number().min(0).max(100).optional(),
  scoreMax: z.number().min(0).max(100).optional(),
  humanReview: uniqueValues(HIRE_JOB_CANDIDATE_HUMAN_REVIEW_STATES),
  aiInterview: uniqueValues(HIRE_JOB_CANDIDATE_AI_INTERVIEW_STATES),
  history: z.enum(HIRE_JOB_CANDIDATE_HISTORY_STATES).optional(),
  appliedFrom: isoDaySchema.optional(),
  appliedTo: isoDaySchema.optional(),
  sort: z.enum(HIRE_JOB_CANDIDATE_SORTS).default("attention"),
  direction: z.enum(["asc", "desc"]).default("desc"),
} as const;

function validRanges<T extends {
  scoreMin?: number;
  scoreMax?: number;
  appliedFrom?: string;
  appliedTo?: string;
}>(query: T): boolean {
  const scoreInvalid = query.scoreMin !== undefined && query.scoreMax !== undefined &&
    query.scoreMin > query.scoreMax;
  const datesInvalid = query.appliedFrom !== undefined && query.appliedTo !== undefined &&
    query.appliedFrom > query.appliedTo;
  return !scoreInvalid && !datesInvalid;
}

type DirectionalQuery = { sort: HireJobCandidateSort; direction?: "asc" | "desc" };
export function canonicalCandidateQuery<T extends DirectionalQuery>(query: T) {
  const direction = query.sort === "newest"
    ? "desc"
    : query.sort === "oldest"
      ? "asc"
      : query.direction ?? (["name", "stage", "rank"].includes(query.sort) ? "asc" : "desc");
  return { ...query, direction } as T & { direction: "asc" | "desc" };
}

export const HireJobCandidateNormalizedQuerySchema = z
  .object(canonicalQueryShape)
  .strict()
  .refine(validRanges, "Invalid candidate filter range")
  .transform(canonicalCandidateQuery);

const rawQueryShape = {
  q: canonicalQueryShape.q,
  view: canonicalQueryShape.view,
  stage: csvValues(HIRE_STAGES),
  source: csvValues(HIRE_JOB_CANDIDATE_SOURCES),
  scoreState: csvValues(HIRE_JOB_CANDIDATE_JD_STATES),
  scoreMin: z.coerce.number().min(0).max(100).optional(),
  scoreMax: z.coerce.number().min(0).max(100).optional(),
  humanReview: csvValues(HIRE_JOB_CANDIDATE_HUMAN_REVIEW_STATES),
  aiInterview: csvValues(HIRE_JOB_CANDIDATE_AI_INTERVIEW_STATES),
  history: canonicalQueryShape.history,
  appliedFrom: canonicalQueryShape.appliedFrom,
  appliedTo: canonicalQueryShape.appliedTo,
  sort: canonicalQueryShape.sort,
  direction: z.enum(["asc", "desc"]).optional(),
} as const;

const rawHttpQuerySchema = z
  .object({
    ...rawQueryShape,
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(validRanges, "Invalid candidate filter range");

export const HireJobCandidatesQuerySchema = rawHttpQuerySchema.transform(
  (query): HireJobCandidateQuery => canonicalCandidateQuery(query),
);

export const HireJobCandidateSummaryQuerySchema = z
  .object(rawQueryShape)
  .strict()
  .refine(validRanges, "Invalid candidate filter range")
  .transform((query): HireJobCandidateNormalizedQuery => canonicalCandidateQuery(query));

export const HireJobCandidateFreshnessQuerySchema = z
  .object({ ...rawQueryShape, snapshotAt: z.string().datetime({ offset: true }) })
  .strict()
  .refine(validRanges, "Invalid candidate filter range")
  .transform((query): HireJobCandidateFreshnessQuery => canonicalCandidateQuery(query));

export function candidateNormalizedQuery(
  query: HireJobCandidateQuery,
): HireJobCandidateNormalizedQuery {
  const { cursor: _cursor, limit: _limit, ...normalized } = query;
  return canonicalCandidateQuery(normalized);
}

export const HireCandidateSelectionCreateSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal(HIRE_CANDIDATE_SELECTION_MODES[0]),
      applicationIds: z
        .array(objectIdSchema)
        .min(1)
        .max(100)
        .refine((items) => new Set(items).size === items.length, "Duplicate application id"),
    })
    .strict(),
  z
    .object({
      mode: z.literal(HIRE_CANDIDATE_SELECTION_MODES[1]),
      query: HireJobCandidateNormalizedQuerySchema,
    })
    .strict(),
]);

export type HireCandidateSelectionCreatePayload = z.infer<
  typeof HireCandidateSelectionCreateSchema
>;

export const HireCandidateSelectionParamsSchema = z
  .object({
    jobId: objectIdSchema,
    selectionId: objectIdSchema,
  })
  .strict();

export const HireCandidateSelectionLookupQuerySchema = z
  .object({ selectionId: objectIdSchema })
  .strict();
