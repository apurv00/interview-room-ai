import { describe, expect, it } from "vitest";
import {
  HireCandidateSelectionCreateSchema,
  HireJobCandidateNormalizedQuerySchema,
  HireJobCandidateFreshnessQuerySchema,
  HireJobCandidateSummaryQuerySchema,
  HireJobCandidatesQuerySchema,
  candidateNormalizedQuery,
} from "../validators/candidateWorkspace";

const APPLICATION_ID = "333333333333333333333333";

describe("Hire job candidate workspace validators", () => {
  it("applies the bounded list defaults", () => {
    expect(HireJobCandidatesQuerySchema.parse({})).toEqual({
      view: "all",
      stage: [],
      source: [],
      scoreState: [],
      humanReview: [],
      aiInterview: [],
      sort: "attention",
      direction: "desc",
      limit: 50,
    });
  });

  it("normalizes every supported CSV predicate and stable sort", () => {
    expect(
      HireJobCandidatesQuerySchema.parse({
        q: "  Maya  ",
        view: "decision_ready",
        stage: "shortlist,offer,shortlist",
        source: "apply_page,pool",
        scoreState: "fresh,stale",
        scoreMin: "60",
        scoreMax: "90",
        humanReview: "pending,disagreement",
        aiInterview: "completed",
        history: "returning",
        appliedFrom: "2026-08-01",
        appliedTo: "2026-08-25",
        sort: "rank",
        cursor: "opaque",
        limit: "100",
      }),
    ).toEqual({
      q: "Maya",
      view: "decision_ready",
      stage: ["shortlist", "offer"],
      source: ["apply_page", "pool"],
      scoreState: ["fresh", "stale"],
      scoreMin: 60,
      scoreMax: 90,
      humanReview: ["pending", "disagreement"],
      aiInterview: ["completed"],
      history: "returning",
      appliedFrom: "2026-08-01",
      appliedTo: "2026-08-25",
      sort: "rank",
      direction: "asc",
      cursor: "opaque",
      limit: 100,
    });
  });

  it("canonicalizes applied-date sorts despite contradictory deep-link directions", () => {
    expect(HireJobCandidatesQuerySchema.parse({ sort: "newest", direction: "asc" }).direction)
      .toBe("desc");
    expect(HireJobCandidateSummaryQuerySchema.parse({ sort: "oldest", direction: "desc" }).direction)
      .toBe("asc");
    expect(candidateNormalizedQuery({
      ...HireJobCandidatesQuerySchema.parse({ sort: "newest" }),
      direction: "asc",
    }).direction).toBe("desc");
    const selection = HireCandidateSelectionCreateSchema.parse({
      mode: "all_matching",
      query: {
        view: "all", stage: [], source: [], scoreState: [], humanReview: [], aiInterview: [],
        sort: "oldest", direction: "desc",
      },
    });
    expect(selection.mode === "all_matching" && selection.query.direction).toBe("asc");
  });

  it("fails closed on unsupported, malformed, repeated, or over-limit inputs", () => {
    expect(() => HireJobCandidatesQuerySchema.parse({ limit: 101 })).toThrow();
    expect(() => HireJobCandidatesQuerySchema.parse({ stage: "unknown" })).toThrow();
    expect(() => HireJobCandidatesQuerySchema.parse({ appliedFrom: "2026-02-31" })).toThrow();
    expect(() => HireJobCandidatesQuerySchema.parse({ scoreMin: 80, scoreMax: 20 })).toThrow();
    expect(() => HireJobCandidatesQuerySchema.parse({ limit: ["20", "50"] })).toThrow();
    expect(() => HireJobCandidatesQuerySchema.parse({ workspaceId: APPLICATION_ID })).toThrow();
  });

  it("keeps the separate summary query cursor- and limit-free", () => {
    expect(
      HireJobCandidateSummaryQuerySchema.parse({
        view: "offers",
        stage: "offer",
        scoreState: "fresh,stale",
      }),
    ).toEqual({
      view: "offers",
      stage: ["offer"],
      source: [],
      scoreState: ["fresh", "stale"],
      humanReview: [],
      aiInterview: [],
      sort: "attention",
      direction: "desc",
    });
    expect(() =>
      HireJobCandidateSummaryQuerySchema.parse({ cursor: "opaque" }),
    ).toThrow();
    expect(() => HireJobCandidateSummaryQuerySchema.parse({ limit: 50 })).toThrow();
  });

  it("validates cursor-free freshness filters and canonicalizes their sort", () => {
    expect(HireJobCandidateFreshnessQuerySchema.parse({
      snapshotAt: "2026-08-25T12:00:00.000Z",
      stage: "new,offer",
      sort: "newest",
      direction: "asc",
    })).toMatchObject({
      snapshotAt: "2026-08-25T12:00:00.000Z",
      stage: ["new", "offer"],
      sort: "newest",
      direction: "desc",
    });
    expect(() => HireJobCandidateFreshnessQuerySchema.parse({ snapshotAt: "tomorrow" })).toThrow();
    expect(() => HireJobCandidateFreshnessQuerySchema.parse({
      snapshotAt: "2026-08-25T12:00:00.000Z",
      cursor: "forbidden",
    })).toThrow();
    expect(() => HireJobCandidateFreshnessQuerySchema.parse({
      snapshotAt: "2026-08-25T12:00:00.000Z",
      limit: 50,
    })).toThrow();
  });

  it("accepts only cursor-free normalized all-matching snapshot predicates", () => {
    const query = HireJobCandidateNormalizedQuerySchema.parse({
      view: "screening_attention",
      stage: ["new"],
      source: [],
      scoreState: ["fresh"],
      humanReview: [],
      aiInterview: [],
      sort: "attention",
      direction: "desc",
    });
    expect(
      HireCandidateSelectionCreateSchema.parse({ mode: "all_matching", query }),
    ).toEqual({ mode: "all_matching", query });
    expect(() =>
      HireCandidateSelectionCreateSchema.parse({
        mode: "all_matching",
        query: { ...query, cursor: "not-allowed" },
      }),
    ).toThrow();
  });

  it("caps explicit this-page snapshots at 100 application ids", () => {
    expect(
      HireCandidateSelectionCreateSchema.parse({
        mode: "explicit",
        applicationIds: [APPLICATION_ID],
      }),
    ).toEqual({ mode: "explicit", applicationIds: [APPLICATION_ID] });
    expect(() =>
      HireCandidateSelectionCreateSchema.parse({
        mode: "explicit",
        applicationIds: Array.from({ length: 101 }, () => APPLICATION_ID),
      }),
    ).toThrow();
    expect(() =>
      HireCandidateSelectionCreateSchema.parse({
        mode: "explicit",
        applicationIds: [APPLICATION_ID, APPLICATION_ID],
      }),
    ).toThrow("Duplicate application id");
    expect(() =>
      HireJobCandidateNormalizedQuerySchema.parse({
        view: "all",
        stage: ["new", "new"],
        source: [],
        scoreState: [],
        humanReview: [],
        aiInterview: [],
        sort: "attention",
        direction: "desc",
      }),
    ).toThrow("Duplicate filter value");
  });
});
