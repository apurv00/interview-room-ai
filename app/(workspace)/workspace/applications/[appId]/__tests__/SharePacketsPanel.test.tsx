import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SharePacketsPanel from "../SharePacketsPanel";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SharePacketsPanel", () => {
  it("creates a copy-only fragment link without an email-delivery request", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const shareUrl =
      "https://hire.example/share-packet/packet-1#packet=capability-secret";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          expect(String(input)).toBe(
            "/api/workspace/applications/app-1/share-packets",
          );
          return json({ sharePackets: [] });
        }
        expect(String(input)).toBe(
          "/api/workspace/applications/app-1/share-packets",
        );
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({
          allowedSections: [
            "candidate_brief",
            "ai_assessments",
            "human_scorecards",
          ],
          operationId: "11111111-1111-4111-8111-111111111111",
        });
        return json(
          {
            created: true,
            sharePacket: { id: "packet-1" },
            shareUrl,
            // Hostile response fields must not change this UI's behavior.
            emailSent: true,
            recipientEmail: "outside@example.com",
          },
          201,
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharePacketsPanel applicationId="app-1" jobIsOpen terminal={false} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Manage share packets" }),
    );
    await screen.findByText("No share packets created yet.");
    fireEvent.click(
      screen.getByRole("button", { name: "Create share packet" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create copy-only link" }),
    );

    expect(
      await screen.findByText(
        "Share packet created. Copy the secure link now; it cannot be recovered later.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(shareUrl)).toBeTruthy();
    expect(document.body.textContent).not.toContain("outside@example.com");
    expect(
      fetchMock.mock.calls.every(
        ([input]) => !String(input).includes("/email"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Copy share link" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(shareUrl);
    });
    expect(
      screen.getByText("Share link copied. The raw link is no longer shown."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(shareUrl);
  });

  it("does not create a packet when its application is terminal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sharePackets: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SharePacketsPanel applicationId="app-1" jobIsOpen terminal />);

    fireEvent.click(
      screen.getByRole("button", { name: "Manage share packets" }),
    );
    expect(
      await screen.findByText(
        "Share packets can be created only while this application and job are active.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Create share packet" }),
    ).toBeNull();
  });

  it("lists packet state without rendering a hostile list capability and revokes only an active packet", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/revoke")) {
          expect(init?.method).toBe("POST");
          return json({ sharePacket: { id: "packet-1", status: "revoked" } });
        }
        return json({
          sharePackets: [
            {
              id: "packet-1",
              allowedSections: ["candidate_brief"],
              status: "active",
              active: true,
              expiresAt: "2099-08-14T00:00:00.000Z",
              verdictSubmittedAt: null,
              revokedAt: null,
              createdAt: "2026-08-14T00:00:00.000Z",
              shareUrl:
                "https://hire.example/share-packet/packet-1#packet=should-never-render",
            },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharePacketsPanel applicationId="app-1" jobIsOpen terminal={false} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Manage share packets" }),
    );
    await screen.findByText("External verdict packet");
    expect(screen.getByRole("button", { name: "Revoke packet" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("should-never-render");

    fireEvent.click(screen.getByRole("button", { name: "Revoke packet" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspace/share-packets/packet-1/revoke",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
