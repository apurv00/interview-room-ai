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
  vi.restoreAllMocks();
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
        expect.objectContaining({
          cache: "no-store",
          signal: expect.any(AbortSignal),
        }),
      );
    });
    const player = container.querySelector("video");
    expect(player?.getAttribute("src")).toBe(
      "https://private-r2.example/display.webm?signature=temporary",
    );
    fireEvent.loadedMetadata(player!);
    expect(document.activeElement).toBe(player);
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

  it("opens from a validation event and seeks the shared display recording", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          url: "https://private-r2.example/display.webm?signature=temporary",
          kind: "screen_recording",
        }),
      ),
    );

    const { rerender } = render(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{
          status: "ready",
          assetId: "screen-asset-1",
          capturedAt: "2026-08-20T12:00:00.000Z",
          bytes: 84_000_000,
        }}
        playbackRequest={{ id: 1, startMs: 12_500 }}
      />,
    );

    const video = await screen.findByLabelText(
      "Private shared display recording",
    );
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 1 },
      duration: { configurable: true, value: 60 },
      play: { configurable: true, value: vi.fn().mockResolvedValue(undefined) },
    });
    fireEvent.loadedMetadata(video);

    expect((video as HTMLVideoElement).currentTime).toBe(12.5);
    expect(document.activeElement).toBe(video);
    expect(video.getAttribute("tabindex")).toBe("0");

    (video as HTMLVideoElement).currentTime = 21;
    rerender(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{
          status: "ready",
          assetId: "screen-asset-1",
          capturedAt: "2026-08-20T12:00:00.000Z",
          bytes: 84_000_000,
        }}
        playbackRequest={{ id: 1, startMs: 12_500 }}
      />,
    );
    expect((video as HTMLVideoElement).currentTime).toBe(21);
    expect(fetch).toHaveBeenCalledTimes(1);

    fireEvent.error(video);
    await screen.findByText(/temporary playback link expired/i);
    expect(fetch).toHaveBeenCalledTimes(1);

    rerender(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{
          status: "ready",
          assetId: "screen-asset-2",
          capturedAt: "2026-08-20T12:01:00.000Z",
          bytes: 85_000_000,
        }}
        playbackRequest={{ id: 1, startMs: 12_500 }}
      />,
    );
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("discards a capability response for a replaced display asset", async () => {
    let resolveCapability!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveCapability = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container, rerender } = render(
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
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    rerender(
      <HireScreenRecordingPanel
        applicationId="application-1"
        recording={{
          status: "ready",
          assetId: "screen-asset-2",
          capturedAt: "2026-08-20T12:01:00.000Z",
          bytes: 85_000_000,
        }}
      />,
    );
    expect(signal.aborted).toBe(true);

    resolveCapability(json({
      url: "https://private-r2.example/stale-display.webm",
      kind: "screen_recording",
    }));
    await Promise.resolve();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("button", { name: "Play shared display" })).toBeTruthy();
  });
});
