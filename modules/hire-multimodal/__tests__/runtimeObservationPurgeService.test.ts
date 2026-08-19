import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createHeaders: vi.fn() }));

vi.mock("@shared/services/internalServiceAuth", () => ({
  createInternalServiceHeaders: mocks.createHeaders,
}));

import {
  HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_PATH,
  HireMultimodalObservationRuntimePurgeError,
  purgeRuntimeMultimodalObservationOutbox,
} from "../services/runtimeObservationPurgeService";

const INPUT = {
  purgeId: "a".repeat(24),
  workspaceId: "b".repeat(24),
  applicationId: "c".repeat(24),
  roundId: "d".repeat(24),
  purgeEligibleAt: new Date("2027-02-28T12:30:00.000Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.HIRE_ENGINE_RUNTIME_URL = "https://runtime.example/base-path";
  mocks.createHeaders.mockReturnValue({ "x-internal-signature": "signed" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HIRE_ENGINE_RUNTIME_URL;
});

describe("runtime supplemental-observation purge bridge", () => {
  it("sends only opaque coordinates under signed service authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, outcome: "purged" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(purgeRuntimeMultimodalObservationOutbox(INPUT)).resolves.toBe(
      "purged",
    );

    const body = JSON.stringify({
      schemaVersion: 1,
      purgeId: INPUT.purgeId,
      workspaceId: INPUT.workspaceId,
      applicationId: INPUT.applicationId,
      roundId: INPUT.roundId,
      purgeEligibleAt: INPUT.purgeEligibleAt.toISOString(),
      reason: "job_closed_retention",
    });
    expect(mocks.createHeaders).toHaveBeenCalledWith({
      method: "POST",
      path: HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_PATH,
      body,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_PATH,
        "https://runtime.example",
      ),
      expect.objectContaining({
        method: "POST",
        body,
        headers: expect.objectContaining({ "x-internal-signature": "signed" }),
      }),
    );
    expect(body).not.toContain("candidate");
    expect(body).not.toContain("jobId");
  });

  it("fails closed when the runtime acknowledgement is not typed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, outcome: "deleted" })),
        ),
    );

    await expect(
      purgeRuntimeMultimodalObservationOutbox(INPUT),
    ).rejects.toBeInstanceOf(HireMultimodalObservationRuntimePurgeError);
  });
});
