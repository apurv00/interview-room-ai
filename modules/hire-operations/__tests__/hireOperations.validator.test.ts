import { describe, expect, it } from "vitest";
import { HireOperationsJobParamsSchema } from "../validators/hireOperations";

describe("Hire operations route validators", () => {
  it("accepts only one canonical job id path coordinate", () => {
    expect(
      HireOperationsJobParamsSchema.parse({ jobId: "a".repeat(24) }),
    ).toEqual({
      jobId: "a".repeat(24),
    });
  });

  it("rejects non-object-id and extra path data", () => {
    expect(() =>
      HireOperationsJobParamsSchema.parse({ jobId: "not-an-id" }),
    ).toThrow();
    expect(() =>
      HireOperationsJobParamsSchema.parse({
        jobId: "a".repeat(24),
        workspaceId: "leak",
      }),
    ).toThrow();
  });
});
