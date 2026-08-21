import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import JobsHealthPanel from "../JobsHealthPanel";

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

const funnel = {
  new: 4,
  screened: 3,
  interviewing: 2,
  shortlist: 1,
  offer: 0,
  hired: 0,
  rejected: 1,
  withdrawn: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JobsHealthPanel", () => {
  it("uses only the jobs-health endpoint and links to an exact per-job performance page", async () => {
    const jobId = "1".repeat(24);
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        asOf: "2026-08-14T12:00:00.000Z",
        jobs: [
          {
            jobId,
            title: "Platform engineer",
            department: { id: "d".repeat(24), name: "Engineering" },
            status: "open",
            daysOpen: 14,
            funnel,
            attention: [
              {
                kind: "stuck_in_stage",
                count: 2,
                stage: "shortlist",
                oldestAgeDays: 8,
                thresholdDays: 6,
              },
              { kind: "pending_human_scorecards", count: 1 },
              { kind: "failed_multimodal_analyses", count: 2 },
              { kind: "interview_validation_attention", count: 3 },
            ],
            candidateName: "PRIVATE_CANDIDATE_NAME",
            rawAi: "PRIVATE_RAW_AI",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<JobsHealthPanel />);

    expect(
      await screen.findByRole("heading", { name: "Platform engineer" }),
    ).toBeTruthy();
    expect(screen.getByText("2 in Shortlist for 8+ days")).toBeTruthy();
    expect(screen.getByText("Department: Engineering")).toBeTruthy();
    expect(screen.getByText("2 interview analyses needing retry")).toBeTruthy();
    expect(
      screen.getByText("3 interview validation timelines available"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View performance" }),
    ).toHaveAttribute("href", `/workspace/jobs/${jobId}/performance`);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/jobs/health?contractVersion=2", {
      cache: "no-store",
    });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `/api/workspace/jobs/${jobId}`,
      ),
    ).toBe(false);
    expect(document.body.textContent).not.toContain("PRIVATE_CANDIDATE_NAME");
    expect(document.body.textContent).not.toContain("PRIVATE_RAW_AI");
  });

  it("uses an empty-state call to action when no jobs exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ asOf: "2026-08-14T12:00:00.000Z", jobs: [] }),
        ),
    );

    render(<JobsHealthPanel />);

    expect(await screen.findByText("No jobs yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open jobs" })).toHaveAttribute(
      "href",
      "/workspace/jobs",
    );
  });
});
