import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CompanyIdentityCard from "../CompanyIdentityCard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CompanyIdentityCard", () => {
  it("shows the onboarding company identity only in the private workspace dashboard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            workspace: {
              name: "Acme Hiring",
              companyDescription:
                "Acme builds reliable workflow software for operations teams.",
              companyLogo: { updatedAt: "2026-08-16T12:00:00.000Z" },
            },
            membership: { role: "admin" },
          }),
        ),
      ),
    );

    render(<CompanyIdentityCard />);

    expect(await screen.findByText("Acme Hiring")).toBeTruthy();
    expect(
      screen.getByText(
        "Acme builds reliable workflow software for operations teams.",
      ),
    ).toBeTruthy();
    expect(screen.getByAltText("Acme Hiring logo")).toHaveAttribute(
      "src",
      "/api/workspace/branding/logo?v=2026-08-16T12%3A00%3A00.000Z",
    );
    expect(screen.getByLabelText("Replace company logo")).toBeTruthy();
  });
});
