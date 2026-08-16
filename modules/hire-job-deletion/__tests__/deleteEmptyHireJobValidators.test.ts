import { describe, expect, it } from "vitest";
import { DeleteEmptyHireJobSchema } from "../validators/deleteEmptyHireJob";

describe("DeleteEmptyHireJobSchema", () => {
  const value = {
    confirmationTitle: "Backend Engineer",
    acknowledgeEmptyJobDeletion: true,
  };

  it("accepts only the explicit, bounded destructive-command shape", () => {
    expect(DeleteEmptyHireJobSchema.parse(value)).toEqual(value);
  });

  it("requires acknowledgement and no extra destructive-command flags", () => {
    expect(
      DeleteEmptyHireJobSchema.safeParse({
        ...value,
        acknowledgeEmptyJobDeletion: false,
      }).success,
    ).toBe(false);
    expect(
      DeleteEmptyHireJobSchema.safeParse({ ...value, force: true }).success,
    ).toBe(false);
  });
});
