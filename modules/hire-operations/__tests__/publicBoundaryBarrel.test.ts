import { describe, expect, it, vi } from "vitest";

// Regression for the Phase-4 barrel-cycle incident: operations must not load
// Hire commands or validators through the broad `@hire` package.
vi.mock("@hire", () => {
  throw new Error("Phase-5 operations must not load the broad @hire barrel");
});

import {
  connectHireControlDB,
  requireMembership,
} from "@hire-operations-boundary";
import {
  connectHireOperationsDB,
  readHireJobPerformance,
  readHireJobsHealth,
  readHireWorkspaceOverview,
} from "@hire-operations";

describe("Phase-5 operations public module boundaries", () => {
  it("uses the focused Hire operations facade for the only control and membership seams", () => {
    expect(connectHireControlDB).toBeTypeOf("function");
    expect(requireMembership).toBeTypeOf("function");
    expect(connectHireOperationsDB).toBeTypeOf("function");
  });

  it("exports only stable read-model constructors", () => {
    expect(readHireWorkspaceOverview).toBeTypeOf("function");
    expect(readHireJobsHealth).toBeTypeOf("function");
    expect(readHireJobPerformance).toBeTypeOf("function");
  });
});
