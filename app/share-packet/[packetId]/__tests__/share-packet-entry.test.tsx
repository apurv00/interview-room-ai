import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import SharePacketEntry from "../SharePacketEntry";

const PACKET_ID = "a".repeat(24);
const WORKSPACE_ID = "1".repeat(24);
const CAPABILITY = `${WORKSPACE_ID}.${PACKET_ID}.${"bc".repeat(32)}`;
const STORAGE_KEY = `hire:share-packet:v1:${PACKET_ID}`;

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function activePacket() {
  return {
    state: "ok",
    snapshot: {
      version: 1,
      candidateBrief: {
        candidateName: "Ada Lovelace",
        jobTitle: "Senior Full-Stack Engineer",
        location: "Bengaluru",
        experienceYears: 5,
      },
      aiAssessments: [
        {
          completedAt: "2026-08-14T00:00:00.000Z",
          overallScore: 82,
          recommendation: "advance",
          confidence: "high",
          dimensions: [
            { key: "communication", label: "Communication", score: 88 },
          ],
        },
      ],
      humanScorecards: {
        total: { count: 2, recommendations: { strong_yes: 1, yes: 1 } },
        member: { count: 1, recommendations: { yes: 1 } },
        kit: { count: 1, recommendations: { strong_yes: 1 } },
      },
    },
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState({}, "", `/share-packet/${PACKET_ID}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SharePacketEntry", () => {
  it("stores a valid fragment, scrubs history, and opens its immutable snapshot with no cookies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(activePacket()));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      {},
      "",
      `/share-packet/${PACKET_ID}#packet=${encodeURIComponent(CAPABILITY)}`,
    );

    render(<SharePacketEntry packetId={PACKET_ID} />);

    expect(
      await screen.findByRole("heading", {
        name: "Senior Full-Stack Engineer",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("AI assessments")).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(CAPABILITY);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/share-packet/${PACKET_ID}/bootstrap`,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        body: JSON.stringify({ capability: CAPABILITY }),
      }),
    );
  });

  it("recovers a tab-scoped capability after the fragment has been scrubbed", async () => {
    window.sessionStorage.setItem(STORAGE_KEY, CAPABILITY);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(activePacket()));
    vi.stubGlobal("fetch", fetchMock);

    render(<SharePacketEntry packetId={PACKET_ID} />);

    expect(await screen.findByText("Your verdict")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/share-packet/${PACKET_ID}/bootstrap`,
      expect.objectContaining({
        body: JSON.stringify({ capability: CAPABILITY }),
      }),
    );
  });

  it("never persists a malformed or mismatched fragment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const differentPacket = "b".repeat(24);
    const mismatched = `${WORKSPACE_ID}.${differentPacket}.${"bc".repeat(32)}`;
    window.history.replaceState(
      {},
      "",
      `/share-packet/${PACKET_ID}#packet=${encodeURIComponent(mismatched)}`,
    );

    render(<SharePacketEntry packetId={PACKET_ID} />);

    expect(
      await screen.findByRole("heading", {
        name: "This share packet link is no longer active",
      }),
    ).toBeTruthy();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits one external verdict through the no-cookie endpoint and clears tab recovery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(activePacket()))
      .mockResolvedValueOnce(jsonResponse({ state: "submitted" }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      {},
      "",
      `/share-packet/${PACKET_ID}#packet=${encodeURIComponent(CAPABILITY)}`,
    );

    render(<SharePacketEntry packetId={PACKET_ID} />);
    await screen.findByText("Your verdict");
    fireEvent.change(screen.getByLabelText("Optional context"), {
      target: { value: "Evidence supports proceeding." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Strong yes" }));

    expect(
      await screen.findByRole("heading", { name: "Verdict submitted" }),
    ).toBeTruthy();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/share-packet/${PACKET_ID}/verdict`,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        body: JSON.stringify({
          capability: CAPABILITY,
          recommendation: "strong_yes",
          comment: "Evidence supports proceeding.",
        }),
      }),
    );
  });

  it("uses one indistinguishable inactive state for a dead packet response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "inactive" }, 410));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      {},
      "",
      `/share-packet/${PACKET_ID}#packet=${encodeURIComponent(CAPABILITY)}`,
    );

    render(<SharePacketEntry packetId={PACKET_ID} />);

    expect(
      await screen.findByRole("heading", {
        name: "This share packet link is no longer active",
      }),
    ).toBeTruthy();
  });
});
