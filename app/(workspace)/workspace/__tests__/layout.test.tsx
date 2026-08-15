import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import WorkspaceLayout from "../layout";

const router = { replace: vi.fn() };

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
vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace/overview",
  useRouter: () => router,
}));
vi.mock("next-auth/react", () => ({
  signOut: vi.fn(),
  useSession: () => ({
    data: { user: { email: "hr@example.com" } },
    status: "authenticated",
  }),
}));
vi.mock("@shared/storageKeys", () => ({ clearAllInterviewStorage: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  router.replace.mockReset();
});

describe("WorkspaceLayout navigation", () => {
  it("adds Overview as the member landing navigation item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            authenticated: true,
            member: {
              name: "Hiring Admin",
              email: "member@example.com",
              role: "admin",
            },
          }),
        ),
      ),
    );

    render(
      <WorkspaceLayout>
        <div>Child content</div>
      </WorkspaceLayout>,
    );

    await waitFor(() =>
      expect(screen.getByText("member@example.com")).toBeTruthy(),
    );
    expect(
      screen.getAllByRole("link", { name: /Overview/ })[0],
    ).toHaveAttribute("href", "/workspace/overview");
    expect(screen.getAllByRole("link", { name: /Audit/ })[0]).toHaveAttribute(
      "href",
      "/workspace/audit",
    );
    expect(
      screen.getAllByRole("link", { name: /IPG Hire/ })[0],
    ).toHaveAttribute("href", "/workspace/overview");
  });
});
