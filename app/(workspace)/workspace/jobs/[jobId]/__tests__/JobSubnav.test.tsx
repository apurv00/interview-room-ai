import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import JobSubnav from "../JobSubnav";

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

describe("JobSubnav", () => {
  it("links the three job views and marks only the current one", () => {
    render(<JobSubnav jobId="job/with spaces" active="decisions" />);

    expect(screen.getByRole("navigation", { name: "Job workspace" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pipeline" })).toHaveAttribute(
      "href",
      "/workspace/jobs/job%2Fwith%20spaces",
    );
    expect(screen.getByRole("link", { name: "Decisions" })).toHaveAttribute(
      "href",
      "/workspace/jobs/job%2Fwith%20spaces/decision",
    );
    expect(screen.getByRole("link", { name: "Decisions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Performance" })).toHaveAttribute(
      "href",
      "/workspace/jobs/job%2Fwith%20spaces/performance",
    );
    expect(screen.getByRole("link", { name: "Pipeline" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
