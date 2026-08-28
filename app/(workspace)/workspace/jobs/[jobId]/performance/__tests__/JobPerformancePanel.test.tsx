import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import JobPerformancePanel from "../JobPerformancePanel";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

const JOB_ID = "1".repeat(24);

function performance(overrides: Record<string, unknown> = {}) {
  return {
    asOf: "2026-08-14T12:00:00.000Z",
    job: {
      jobId: JOB_ID,
      title: "Platform engineer",
      department: { id: "d".repeat(24), name: "Engineering" },
      status: "open",
      daysOpen: 11,
    },
    funnel: {
      current: {
        new: 3,
        screened: 2,
        interviewing: 2,
        shortlist: 1,
        offer: 1,
        hired: 0,
        rejected: 1,
        withdrawn: 0,
      },
      conversions: [
        { stage: "screened", reached: 5, rateFromStart: 0.8 },
        { stage: "interviewing", reached: 4, rateFromStart: 0.6 },
        { stage: "shortlist", reached: 2, rateFromStart: 0.3 },
        { stage: "offer", reached: 1, rateFromStart: 0.15 },
        { stage: "hired", reached: 0, rateFromStart: 0 },
      ],
    },
    humanScorecards: { completed: 3, pending: 1, total: 4, rate: 0.75 },
    scoreDistribution: {
      sampleSize: 2,
      chartEligible: false,
      buckets: [],
      fallbackCandidates: [
        {
          applicationId: "a".repeat(24),
          candidateName: "Ada Lovelace",
          score: 91,
          rank: 1,
        },
        {
          applicationId: "b".repeat(24),
          candidateName: "Grace Hopper",
          score: 72,
          rank: 2,
        },
      ],
    },
    timeToCloseDays: null,
    candidateName: "PRIVATE_CANDIDATE_NAME",
    rawScore: 99,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JobPerformancePanel", () => {
  it("uses only the safe per-job performance DTO and renders the intentional small-sample fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(performance()));
    vi.stubGlobal("fetch", fetchMock);

    render(<JobPerformancePanel jobId={JOB_ID} />);

    expect(
      await screen.findByRole("heading", { name: "Platform engineer" }),
    ).toBeTruthy();
    expect(screen.getByText("Department: Engineering")).toBeTruthy();
    expect(
      screen.getByText(
        /A score chart appears after 10 completed AI assessments/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("AI score distribution histogram"),
    ).toBeNull();
    expect(
      screen.getByRole("list", { name: "Ranked candidates" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toHaveAttribute(
      "href",
      `/workspace/applications/${"a".repeat(24)}?returnTo=${encodeURIComponent(`/workspace/jobs/${JOB_ID}/performance`)}`,
    );
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("Score 91")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open decision workspace" }),
    ).toHaveAttribute("href", `/workspace/jobs/${JOB_ID}/decision`);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspace/jobs/${JOB_ID}/performance`,
      { cache: "no-store" },
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `/api/workspace/jobs/${JOB_ID}`,
      ),
    ).toBe(false);
    expect(document.body.textContent).not.toContain("PRIVATE_CANDIDATE_NAME");
    expect(document.body.textContent).not.toContain("99");
  });

  it("renders histogram buckets at the server-supplied 10-score floor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          performance({
            scoreDistribution: {
              sampleSize: 10,
              chartEligible: true,
              buckets: [
                { minimum: 0, maximum: 49, count: 1 },
                { minimum: 50, maximum: 59, count: 2 },
                { minimum: 60, maximum: 69, count: 3 },
                { minimum: 70, maximum: 79, count: 2 },
                { minimum: 80, maximum: 89, count: 1 },
                { minimum: 90, maximum: 100, count: 1 },
              ],
            },
          }),
        ),
      ),
    );

    render(<JobPerformancePanel jobId={JOB_ID} />);

    expect(
      await screen.findByLabelText("AI score distribution histogram"),
    ).toBeTruthy();
    expect(screen.getByText("60–69")).toBeTruthy();
    expect(
      screen.queryByRole("list", { name: "Ranked candidates" }),
    ).toBeNull();
  });

  it("rejects an invalid chart-eligible payload that includes fallback people", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          performance({
            scoreDistribution: {
              sampleSize: 10,
              chartEligible: true,
              buckets: [{ minimum: 0, maximum: 100, count: 10 }],
              fallbackCandidates: [
                {
                  applicationId: "a".repeat(24),
                  candidateName: "Ada Lovelace",
                  score: 91,
                  rank: 1,
                },
              ],
            },
          }),
        ),
      ),
    );

    render(<JobPerformancePanel jobId={JOB_ID} />);

    expect(
      await screen.findByText("The operations response was not valid."),
    ).toBeTruthy();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });

  it("preserves and wraps long job, department, and fallback-candidate content", async () => {
    const title = "PrincipalPlatformAndDistributedSystemsRecruitingLead".repeat(4);
    const departmentName = "D".repeat(120);
    const candidateName = "N".repeat(120);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          performance({
            job: {
              jobId: JOB_ID,
              title,
              department: { id: "d".repeat(24), name: departmentName },
              status: "open",
              daysOpen: 11,
            },
            scoreDistribution: {
              sampleSize: 1,
              chartEligible: false,
              buckets: [],
              fallbackCandidates: [
                {
                  applicationId: "a".repeat(24),
                  candidateName,
                  score: 91,
                  rank: 1,
                },
              ],
            },
          }),
        ),
      ),
    );

    render(<JobPerformancePanel jobId={JOB_ID} />);

    const heading = await screen.findByRole("heading", { name: title });
    expect(heading).toHaveClass("max-w-full", "break-words");
    expect(heading).not.toHaveClass("truncate");

    const department = screen.getByText(`Department: ${departmentName}`);
    expect(department).toHaveClass(
      "max-w-full",
      "whitespace-normal",
      "break-words",
    );
    expect(department).not.toHaveClass("truncate");

    const candidate = screen.getByRole("link", { name: candidateName });
    expect(candidate).toHaveClass("max-w-full", "break-words");
    expect(candidate).not.toHaveClass("truncate");
  });
});
