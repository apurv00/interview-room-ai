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
    let brand = {
      name: "Acme Hiring",
      companyLogo: { updatedAt: "2026-08-16T12:00:00.000Z" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url === "/api/workspace"
                ? {
                    workspace: brand,
                  }
                : {
                    authenticated: true,
                    member: {
                      name: "Hiring Admin",
                      email: "member@example.com",
                      role: "admin",
                    },
                  },
            ),
          ),
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
      screen.getAllByRole("link", { name: /Departments/ })[0],
    ).toHaveAttribute("href", "/workspace/departments");
    expect(
      screen.getAllByRole("link", { name: /Acme Hiring/ })[0],
    ).toHaveAttribute("href", "/workspace/overview");
    expect(screen.getByAltText("Acme Hiring logo")).toHaveAttribute(
      "src",
      "/api/workspace/branding/logo?v=2026-08-16T12%3A00%3A00.000Z",
    );

    brand = {
      name: "Acme Operations",
      companyLogo: { updatedAt: "2026-08-16T13:00:00.000Z" },
    };
    window.dispatchEvent(new Event("hire-workspace-brand-updated"));

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: /Acme Operations/ })[0]).toBeTruthy(),
    );
    expect(screen.getByAltText("Acme Operations logo")).toHaveAttribute(
      "src",
      "/api/workspace/branding/logo?v=2026-08-16T13%3A00%3A00.000Z",
    );
  });
});
