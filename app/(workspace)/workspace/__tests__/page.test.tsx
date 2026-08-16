import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorkspaceEntryPage from "../page";

const router = { replace: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router }));

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  router.replace.mockReset();
});

describe("WorkspaceEntryPage", () => {
  it("sends established members to the operations overview while preserving first-workspace onboarding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ workspace: { id: "workspace-1" } })),
    );

    render(<WorkspaceEntryPage />);

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace/overview"),
    );
  });

  it("captures the single canonical company description during workspace onboarding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspace: null, membership: null }))
      .mockResolvedValueOnce(json({ workspace: { id: "workspace-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceEntryPage />);

    const description = await screen.findByLabelText("Company description");
    fireEvent.change(screen.getByLabelText("Company name"), {
      target: { value: "Acme" },
    });
    fireEvent.change(description, {
      target: {
        value: "Acme builds reliable workflow software for operations teams.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace/jobs?welcome=1"),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workspace",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      name: "Acme",
      companyDescription:
        "Acme builds reliable workflow software for operations teams.",
      guestAuthMode: "magic_link",
    });
  });

  it("gives an existing admin with no legacy description a one-time onboarding completion step", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          workspace: { id: "workspace-1", name: "Acme" },
          membership: { role: "admin" },
        }),
      )
      .mockResolvedValueOnce(
        json({
          workspace: {
            id: "workspace-1",
            name: "Acme",
            companyDescription: "Acme builds reliable workflow software for operations teams.",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceEntryPage />);

    expect(
      await screen.findByRole("heading", { name: "Complete your company profile" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Company name")).toBeNull();
    fireEvent.change(screen.getByLabelText("Company description"), {
      target: {
        value: "Acme builds reliable workflow software for operations teams.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save company profile" }));

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace/overview"),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workspace",
      expect.objectContaining({ method: "PATCH" }),
    );
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      companyDescription:
        "Acme builds reliable workflow software for operations teams.",
    });
  });
});
