import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HireMultimodalAnalysisPanel from "../HireMultimodalAnalysisPanel";

describe("HireMultimodalAnalysisPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the complete persisted analysis report alongside all timeline and segment sections", () => {
    render(
      <HireMultimodalAnalysisPanel
        analysis={{
          id: "analysis-1",
          roundId: "round-1",
          attemptId: "attempt-1",
          status: "completed",
          capturedAt: "2026-08-17T12:00:00.000Z",
          completedAt: "2026-08-17T12:05:00.000Z",
          durationMs: 90_000,
          facialFrameCount: 24,
          report: {
            metrics: {
              bodyLanguageScore: 81,
              eyeContactScore: 76,
              facialFrameCount: 24,
            },
            prosodySegments: [
              {
                startSec: 5,
                endSec: 18,
                wpm: 134,
                fillerWords: [{ word: "um", timestampSec: 8 }],
                pauseDurationSec: 1.2,
                confidenceMarker: "high",
                questionIndex: 0,
              },
            ],
            facialSegments: [
              {
                startSec: 5,
                endSec: 18,
                avgEyeContact: 0.76,
                dominantExpression: "focused",
                headStability: 0.81,
                gestureLevel: "moderate",
                questionIndex: 0,
                meanBlendshapes: { browDownLeft: 0.123 },
                maxBlendshapes: { browDownLeft: 0.456 },
              },
            ],
            facialTimeseries: [],
            timeline: [
              {
                startMs: 5_000,
                endMs: 18_000,
                type: "strength",
                signal: "fused",
                title: "Clear answer structure",
                description:
                  "The answer followed a clear and complete structure.",
                severity: "positive",
                questionIndex: 0,
              },
            ],
            summary: {
              bodyLanguageScore: 81,
              eyeContactScore: 76,
              deliverySummary: "A complete summary for the recruiter.",
              reviewerNotes: ["Review the opening answer with the recording."],
              topMoments: [
                {
                  startMs: 5_000,
                  endMs: 18_000,
                  type: "strength",
                  signal: "fused",
                  title: "Highlighted answer structure",
                  description: "The candidate kept the answer focused.",
                  severity: "positive",
                },
              ],
              attentionMoments: [
                {
                  startMs: 20_000,
                  endMs: 25_000,
                  type: "attention",
                  signal: "audio",
                  title: "Long pause",
                  description: "A notable pause was recorded.",
                  severity: "attention",
                },
              ],
            },
          },
        }}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Full interview analysis" }),
    ).toBeTruthy();
    expect(
      screen.getByText("A complete summary for the recruiter."),
    ).toBeTruthy();
    expect(screen.getByText("Clear answer structure")).toBeTruthy();
    expect(screen.getByText(/Highlighted strengths \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Highlighted answer structure/)).toBeTruthy();
    expect(screen.getByText(/Attention moments \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Long pause/)).toBeTruthy();
    expect(screen.getByText(/Speech delivery segments \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Facial analysis segments \(1\)/)).toBeTruthy();
    expect(screen.getByText(/mean browDownLeft: 0.123/)).toBeTruthy();
    expect(screen.getByText(/max browDownLeft: 0.456/)).toBeTruthy();
  });

  it("shows an honest in-progress state without inventing a completed report", () => {
    render(
      <HireMultimodalAnalysisPanel
        analysis={{
          id: "analysis-1",
          roundId: "round-1",
          attemptId: "attempt-1",
          status: "processing",
          capturedAt: "2026-08-17T12:00:00.000Z",
          durationMs: 90_000,
          facialFrameCount: null,
        }}
      />,
    );

    expect(screen.getByText("Interview analysis in progress")).toBeTruthy();
    expect(
      screen.getByText(/refreshes automatically while analysis is pending/i),
    ).toBeTruthy();
    expect(screen.queryByText("Complete timeline")).toBeNull();
  });

  it("distinguishes a scheduled system retry from an exhausted failed analysis", () => {
    const { rerender } = render(
      <HireMultimodalAnalysisPanel
        analysis={{
          id: "analysis-1",
          roundId: "round-1",
          attemptId: "attempt-1",
          status: "failed",
          capturedAt: "2026-08-17T12:00:00.000Z",
          durationMs: 90_000,
          facialFrameCount: null,
          retryAt: "2026-08-17T12:10:00.000Z",
          retryAttemptCount: 2,
        }}
      />,
    );

    expect(
      screen.getByText(/eligible for the next system recovery sweep after/i),
    ).toBeTruthy();
    expect(screen.getByText(/retry 2 of 3/i)).toBeTruthy();

    rerender(
      <HireMultimodalAnalysisPanel
        analysis={{
          id: "analysis-1",
          roundId: "round-1",
          attemptId: "attempt-1",
          status: "failed",
          capturedAt: "2026-08-17T12:00:00.000Z",
          durationMs: 90_000,
          facialFrameCount: null,
          retryAttemptCount: 3,
          manualRetryAvailable: true,
        }}
      />,
    );

    expect(screen.getByText(/No automatic retry remains/i)).toBeTruthy();
  });

  it("requeues an exhausted analysis and refreshes the candidate card", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ outcome: "requeued", dispatch: "sent" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <HireMultimodalAnalysisPanel
        applicationId="application-1"
        onChanged={onChanged}
        analysis={{
          id: "analysis-1",
          roundId: "round-1",
          attemptId: "attempt-1",
          status: "failed",
          capturedAt: "2026-08-17T12:00:00.000Z",
          durationMs: 90_000,
          facialFrameCount: null,
          retryAttemptCount: 3,
          manualRetryAvailable: true,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry analysis" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/applications/application-1/multimodal-analysis/analysis-1/retry",
      { method: "POST" },
    );
    expect(screen.getByText("Retry queued.")).toBeTruthy();
  });
});
