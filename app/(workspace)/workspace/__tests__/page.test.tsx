import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
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
});
