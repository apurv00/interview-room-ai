import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DigestPreferenceControl from "../DigestPreferenceControl";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function preference(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    updatedAt: null,
    recipientEmail: "PRIVATE_RECIPIENT@example.com",
    outboxId: "PRIVATE_OUTBOX_ID",
    outboxStatus: "sent",
    payload: { candidateName: "PRIVATE_CANDIDATE_NAME" },
    providerMessageId: "PRIVATE_PROVIDER_ID",
    capability: "PRIVATE_CAPABILITY",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DigestPreferenceControl", () => {
  it("states the off-by-default policy and renders only the preference DTO", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(preference()));
    vi.stubGlobal("fetch", fetchMock);

    render(<DigestPreferenceControl />);

    expect(
      await screen.findByRole("heading", { name: "Daily hiring summary" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Daily email summaries are off by default/),
    ).toBeTruthy();
    expect(screen.getByText(/currently off/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Turn on daily summary" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/digest-preference", {
      cache: "no-store",
    });
    expect(document.body.textContent).not.toContain(
      "PRIVATE_RECIPIENT@example.com",
    );
    expect(document.body.textContent).not.toContain("PRIVATE_OUTBOX_ID");
    expect(document.body.textContent).not.toContain("sent");
    expect(document.body.textContent).not.toContain("PRIVATE_CANDIDATE_NAME");
    expect(document.body.textContent).not.toContain("PRIVATE_PROVIDER_ID");
    expect(document.body.textContent).not.toContain("PRIVATE_CAPABILITY");
  });

  it("updates through the narrow PATCH endpoint without requesting delivery or candidate data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(preference()))
      .mockResolvedValueOnce(
        json(
          preference({
            enabled: true,
            updatedAt: "2026-08-15T08:00:00.000Z",
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<DigestPreferenceControl />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Turn on daily summary" }),
    );

    expect(
      await screen.findByRole("button", { name: "Turn off daily summary" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workspace/digest-preference",
      expect.objectContaining({
        method: "PATCH",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const [, request] = fetchMock.mock.calls[1];
    expect(JSON.parse(request.body)).toEqual({ enabled: true });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        /outbox|candidate|jobs|learn/i.test(String(url)),
      ),
    ).toBe(false);
  });

  it("rejects an invalid response before it can be rendered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          enabled: "yes",
          recipientEmail: "PRIVATE_RECIPIENT@example.com",
        }),
      ),
    );

    render(<DigestPreferenceControl />);

    expect(
      await screen.findByText(
        "The daily summary preference response was not valid.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/PRIVATE_RECIPIENT/)).toBeNull();
  });

  it("uses a fixed error message instead of rendering an API diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            error: "PRIVATE_PROVIDER_ERROR: recipient@example.com",
            payload: { candidateName: "PRIVATE_CANDIDATE_NAME" },
          },
          500,
        ),
      ),
    );

    render(<DigestPreferenceControl />);

    expect(
      await screen.findByText("Could not load the daily summary preference."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("PRIVATE_PROVIDER_ERROR");
    expect(document.body.textContent).not.toContain("recipient@example.com");
    expect(document.body.textContent).not.toContain("PRIVATE_CANDIDATE_NAME");
  });
});
