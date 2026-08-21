import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HireScreenRecordingPanel from "../HireScreenRecordingPanel";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HireScreenRecordingPanel", () => {
  it("mints a short-lived screen capability only after an HR member chooses playback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        url: "https://private-r2.example/display.webm?signature=temporary",
        expiresInSeconds: 300,
        kind: "screen_recording",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{
          status: "ready",
          assetId: "screen-asset-1",
          capturedAt: "2026-08-20T12:00:00.000Z",
          bytes: 84_000_000,
        }}
      />,
    );

    expect(screen.getByText("Shared display recording")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("screen-asset-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play shared display" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspace/applications/application-1/media/screen-asset-1",
        { cache: "no-store" },
      );
    });
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "https://private-r2.example/display.webm?signature=temporary",
    );
  });

  it("rejects a capability for a different media kind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          url: "https://private-r2.example/camera.webm?signature=temporary",
          kind: "camera_recording",
        }),
      ),
    );

    const { container } = render(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{
          status: "ready",
          assetId: "screen-asset-1",
          capturedAt: "2026-08-20T12:00:00.000Z",
          bytes: 84_000_000,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play shared display" }));

    await screen.findByText(/shared display recording is unavailable/i);
    expect(container.querySelector("video")).toBeNull();
  });

  it("shows transfer and removal states without a playback action", () => {
    const { rerender } = render(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{ status: "awaiting_transfer" }}
      />,
    );

    expect(screen.getByText("Preparing display recording")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Play shared display" })).toBeNull();

    rerender(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{ status: "removed" }}
      />,
    );
    expect(screen.getByText("Display recording removed")).toBeTruthy();
  });

  it("shows a neutral terminal delivery failure without a playback action", () => {
    render(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{ status: "unavailable", reason: "upload_expired" }}
      />,
    );

    expect(screen.getByText("Display recording unavailable")).toBeTruthy();
    expect(screen.getByText(/upload window expired/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Play shared display" })).toBeNull();
  });
});
