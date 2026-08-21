import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import OverviewWorkspace from "../OverviewWorkspace";

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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function overview() {
  return {
    asOf: "2026-08-14T12:00:00.000Z",
    kpis: {
      openJobs: 2,
      candidatesAwaitingDecision: 3,
      scorecardCompletion: { completed: 4, pending: 2, total: 6, rate: 0.667 },
      medianTimeToCloseDays: 12.5,
      candidateName: "PRIVATE_CANDIDATE_NAME",
      resumeText: "PRIVATE_RESUME_TEXT",
    },
    actionInbox: {
      items: [
        {
          kind: "candidates_awaiting_decision",
          count: 3,
          applicationId: "PRIVATE_APP_ID",
        },
        { kind: "pending_human_scorecards", count: 2 },
        { kind: "terminal_human_kit_delivery_failures", count: 0 },
        { kind: "external_verdicts_received", count: 1 },
        { kind: "failed_multimodal_analyses", count: 2 },
        { kind: "interview_validation_attention", count: 3 },
      ],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OverviewWorkspace", () => {
  it("renders only the narrow overview DTO and promotes the existing CSV download", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(overview()));
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewWorkspace />);

    expect(
      await screen.findByRole("heading", { name: "What needs attention" }),
    ).toBeTruthy();
    expect(screen.getByText("Open jobs")).toBeTruthy();
    expect(screen.getByText("4 of 6 complete")).toBeTruthy();
    expect(screen.getByText("Candidates awaiting decision")).toBeTruthy();
    expect(screen.getByText("Interview analyses needing retry")).toBeTruthy();
    expect(
      screen.getByText("Interview validation timelines available"),
    ).toBeTruthy();
    expect(screen.getByText("8 open")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Jobs health" })).toHaveAttribute(
      "href",
      "/workspace/jobs/health",
    );
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
      "href",
      "/api/workspace/export/candidates",
    );
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
      "download",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/overview?contractVersion=2", {
      cache: "no-store",
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/api/workspace/jobs"),
      ),
    ).toBe(false);
    expect(document.body.textContent).not.toContain("PRIVATE_CANDIDATE_NAME");
    expect(document.body.textContent).not.toContain("PRIVATE_RESUME_TEXT");
    expect(document.body.textContent).not.toContain("PRIVATE_APP_ID");
  });

  it("uses an explicit empty action state", async () => {
    const value = overview();
    value.actionInbox.items.forEach((item) => {
      item.count = 0;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(value)));

    render(<OverviewWorkspace />);

    expect(
      await screen.findByText(
        "Everything is clear. As interviews and decisions progress, grouped actions will appear here.",
      ),
    ).toBeTruthy();
  });
});
