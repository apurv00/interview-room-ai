import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DecisionWorkspace from "../DecisionWorkspace";

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

const JOB_ID = "1".repeat(24);
const APP_ADA = "2".repeat(24);
const APP_GRACE = "3".repeat(24);
const WORKSPACE_ID = "4".repeat(24);
const APP_KATHERINE = "5".repeat(24);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tally(overrides: Record<string, number> = {}) {
  return { strong_yes: 0, yes: 0, no: 0, strong_no: 0, ...overrides };
}

function humanScorecards() {
  return {
    total: { count: 2, recommendations: tally({ yes: 2 }), dimensions: [] },
    member: { count: 1, recommendations: tally({ yes: 1 }), dimensions: [] },
    kit: { count: 1, recommendations: tally({ yes: 1 }), dimensions: [] },
  };
}

function context(applicationId: string, candidateName: string) {
  return {
    coordinates: {
      workspaceId: WORKSPACE_ID,
      applicationId,
      jobId: JOB_ID,
      candidateId: `${applicationId.slice(0, 23)}f`,
    },
    candidateBrief: {
      candidateName,
      jobTitle: "Platform Engineer",
      location: "Bengaluru",
      experienceYears: 6,
      email: `${candidateName.toLowerCase().replaceAll(" ", ".")}@example.com`,
      resumeText: "PRIVATE_RESUME_TEXT",
    },
    humanScorecards: humanScorecards(),
    externalVerdicts: { count: 1, recommendations: tally({ yes: 1 }) },
  };
}

function inboxItem(applicationId: string, candidateName: string) {
  return {
    kind: "external_verdict_submitted",
    occurredAt: "2026-08-14T08:00:00.000Z",
    recommendation: "yes",
    comment: "PRIVATE_EXTERNAL_COMMENT",
    decision: context(applicationId, candidateName),
  };
}

function decision(applicationId: string, candidateName: string) {
  return {
    ...context(applicationId, candidateName),
    aiAssessments: [
      {
        completedAt: "2026-08-13T08:00:00.000Z",
        overallScore: 82,
        recommendation: "advance",
        confidence: "high",
        dimensions: [
          { key: "communication", label: "Communication", score: 88 },
        ],
        rawEngineOutput: "PRIVATE_RAW_AI_OUTPUT",
        mediaAssetId: "PRIVATE_MEDIA_ASSET",
      },
    ],
    decisionNote: "PRIVATE_DECISION_NOTE",
    closeNote: "PRIVATE_CLOSE_NOTE",
    rank: 1,
  };
}

function selectionCandidate(applicationId: string, candidateName: string) {
  return {
    applicationId,
    candidateName,
    email: "PRIVATE_PIPELINE_EMAIL@example.com",
    phone: "+91-PRIVATE_PHONE",
    resumeText: "PRIVATE_PIPELINE_RESUME",
    decisionNote: "PRIVATE_PIPELINE_DECISION_NOTE",
    rank: 1,
    rawAiOutput: "PRIVATE_PIPELINE_RAW_AI_OUTPUT",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DecisionWorkspace", () => {
  it("uses the narrow candidate endpoint, preserves click order, and renders only safe comparison evidence", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/api/workspace/jobs/${JOB_ID}/decision`) {
          return json({
            items: [
              inboxItem(APP_ADA, "Ada Lovelace"),
              inboxItem(APP_GRACE, "Grace Hopper"),
            ],
          });
        }
        if (url === `/api/workspace/jobs/${JOB_ID}/decision/candidates`) {
          return json({
            candidates: [
              selectionCandidate(APP_GRACE, "Grace Hopper"),
              selectionCandidate(APP_KATHERINE, "Katherine Johnson"),
              selectionCandidate(APP_ADA, "Ada Lovelace"),
            ],
          });
        }
        expect(url).toBe(`/api/workspace/jobs/${JOB_ID}/decision/compare`);
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({
          applicationIds: [APP_KATHERINE, APP_ADA],
        });
        return json({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          applications: [
            decision(APP_KATHERINE, "Katherine Johnson"),
            decision(APP_ADA, "Ada Lovelace"),
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionWorkspace jobId={JOB_ID} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/workspace/jobs/${JOB_ID}/decision/candidates`,
        { cache: "no-store" },
      );
    });
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === `/api/workspace/jobs/${JOB_ID}`,
      ),
    ).toBe(false);

    expect(
      await screen.findByRole("heading", { name: "Ada Lovelace" }),
    ).toBeTruthy();
    const compareButton = screen.getByRole("button", {
      name: "Compare selected candidates",
    });
    expect(compareButton).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Katherine Johnson to comparison",
      }),
    );
    expect(compareButton).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Ada Lovelace to comparison",
      }),
    );

    expect(
      screen.getByRole("button", { name: "Compare 2 candidates" }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("list", { name: "Selected comparison order" })
        .textContent,
    ).toContain("1.Katherine Johnson");
    expect(
      screen.getByRole("list", { name: "Selected comparison order" })
        .textContent,
    ).toContain("2.Ada Lovelace");

    fireEvent.click(
      screen.getByRole("button", { name: "Compare 2 candidates" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Evidence comparison" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Presented in your selected order. No composite rank is calculated.",
      ),
    ).toBeTruthy();
    const aiAssessmentHeadings = screen.getAllByRole("heading", {
      name: "AI assessments",
      level: 4,
    });
    expect(aiAssessmentHeadings).toHaveLength(2);
    expect(new Set(aiAssessmentHeadings.map((heading) => heading.id)).size).toBe(2);
    expect(
      screen.getByRole("heading", { name: "Katherine Johnson", level: 3 }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Ada Lovelace", level: 3 }),
    ).toBeTruthy();
    expect(
      screen.getAllByText(
        /AI recommendation \(supporting evidence only\): advance/,
      ),
    ).toHaveLength(2);
    expect(
      screen.getAllByText(
        "AI recommendations shown above are supporting evidence only. A human owns every pipeline-stage decision and change.",
      ),
    ).toHaveLength(2);
    expect(
      screen.getByRole("link", {
        name: "Open decision detail for Katherine Johnson",
      }),
    ).toHaveAttribute(
      "href",
      `/workspace/applications/${APP_KATHERINE}`,
    );
    expect(
      screen.getByRole("link", {
        name: "Open decision detail for Ada Lovelace",
      }),
    ).toHaveAttribute("href", `/workspace/applications/${APP_ADA}`);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/workspace/jobs/${JOB_ID}/decision/compare`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ applicationIds: [APP_KATHERINE, APP_ADA] }),
          cache: "no-store",
        }),
      );
    });

    const rendered = document.body.textContent ?? "";
    for (const forbidden of [
      "PRIVATE_RESUME_TEXT",
      "PRIVATE_EXTERNAL_COMMENT",
      "PRIVATE_RAW_AI_OUTPUT",
      "PRIVATE_MEDIA_ASSET",
      "PRIVATE_DECISION_NOTE",
      "PRIVATE_CLOSE_NOTE",
      "ada.lovelace@example.com",
      "PRIVATE_PIPELINE_DECISION_NOTE",
      "PRIVATE_PIPELINE_EMAIL@example.com",
      "PRIVATE_PIPELINE_RESUME",
      "+91-PRIVATE_PHONE",
      "PRIVATE_PIPELINE_RAW_AI_OUTPUT",
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it("keeps an invalid inbox response out of the presentation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/workspace/jobs/${JOB_ID}/decision`) {
          return Promise.resolve(
            json({
              items: [
                {
                  kind: "external_verdict_submitted",
                  occurredAt: "not-a-date",
                  recommendation: "yes",
                  decision: {
                    candidateBrief: { candidateName: "PRIVATE_NAME" },
                  },
                },
              ],
            }),
          );
        }
        return Promise.resolve(json({ candidates: [] }));
      }),
    );

    render(<DecisionWorkspace jobId={JOB_ID} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Could not load decision actions/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain("PRIVATE_NAME");
  });
});
