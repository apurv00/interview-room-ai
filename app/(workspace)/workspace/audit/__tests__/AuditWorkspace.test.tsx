import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AuditWorkspace from "../AuditWorkspace";

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

const APPLICATION_ID = "1".repeat(24);
const DIGEST_OUTBOX_ID = "3".repeat(24);
const TEST_DRIVE_ID = "4".repeat(24);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function auditItem(overrides: Record<string, unknown> = {}) {
  return {
    kind: "application_stage_changed",
    occurredAt: "2026-08-14T12:00:00.000Z",
    actor: { kind: "member", name: "Hiring Admin" },
    target: { kind: "application", id: APPLICATION_ID },
    candidateName: "PRIVATE_CANDIDATE_NAME",
    candidateEmail: "private@example.com",
    note: "PRIVATE_DECISION_NOTE",
    secretHash: "PRIVATE_SECRET_HASH",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuditWorkspace", () => {
  it("uses only the safe paginated audit DTO and never renders denied fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ items: [auditItem()], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AuditWorkspace />);

    expect(
      await screen.findByRole("heading", { name: "Audit trail" }),
    ).toBeTruthy();
    expect(screen.getByText("Application stage changed")).toBeTruthy();
    expect(screen.getByText(/Hiring Admin/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Audit events" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View application" }),
    ).toHaveAttribute("href", `/workspace/applications/${APPLICATION_ID}`);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/audit?limit=25", {
      cache: "no-store",
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/api/workspace/candidates"),
      ),
    ).toBe(false);
    expect(document.body.textContent).not.toContain("PRIVATE_CANDIDATE_NAME");
    expect(document.body.textContent).not.toContain("private@example.com");
    expect(document.body.textContent).not.toContain("PRIVATE_DECISION_NOTE");
    expect(document.body.textContent).not.toContain("PRIVATE_SECRET_HASH");
  });

  it("uses a clear empty state when no safe events exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ items: [], nextCursor: null })),
    );

    render(<AuditWorkspace />);

    expect(await screen.findByText("No audit events yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Safe operational history appears here as hiring work is recorded.",
      ),
    ).toBeTruthy();
  });

  it("continues from the opaque cursor without a broad secondary fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ items: [auditItem()], nextCursor: "opaque-next" }),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            auditItem({
              kind: "digest_delivery_sent",
              actor: { kind: "system", name: "System" },
              target: { kind: "digest_outbox", id: DIGEST_OUTBOX_ID },
            }),
          ],
          nextCursor: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<AuditWorkspace />);

    await screen.findByText("Application stage changed");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Daily summary sent")).toBeTruthy();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workspace/audit?limit=25&cursor=opaque-next",
      { cache: "no-store" },
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Daily summary delivery")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/api/workspace/jobs/health"),
      ),
    ).toBe(false);
  });

  it("renders the bounded practice-interview audit receipt without synthetic graph details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          items: [
            auditItem({
              kind: "onboarding_test_drive_ready",
              target: { kind: "onboarding_test_drive", id: TEST_DRIVE_ID },
              candidateId: "PRIVATE_TEST_DRIVE_CANDIDATE",
              applicationId: "PRIVATE_TEST_DRIVE_APPLICATION",
              inviteUrl: "PRIVATE_TEST_DRIVE_INVITE",
            }),
          ],
          nextCursor: null,
        }),
      ),
    );

    render(<AuditWorkspace />);

    expect(await screen.findByText("Practice interview ready")).toBeTruthy();
    expect(screen.getByText("Practice interview")).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "PRIVATE_TEST_DRIVE_CANDIDATE",
    );
    expect(document.body.textContent).not.toContain(
      "PRIVATE_TEST_DRIVE_APPLICATION",
    );
    expect(document.body.textContent).not.toContain(
      "PRIVATE_TEST_DRIVE_INVITE",
    );
  });

  it("rejects a malformed audit event before rendering it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          items: [
            auditItem({
              target: {
                kind: "application",
                id: "PRIVATE_UNSAFE_TARGET_ID",
              },
            }),
          ],
          nextCursor: null,
        }),
      ),
    );

    render(<AuditWorkspace />);

    expect(
      await screen.findByText("The operations response was not valid."),
    ).toBeTruthy();
    expect(screen.queryByText("Application stage changed")).toBeNull();
  });
});
