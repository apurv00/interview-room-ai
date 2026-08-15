import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  submit: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@hire-decisions/services/sharePacketService", () => ({
  bootstrapSharePacket: mocks.bootstrap,
  submitExternalVerdict: mocks.submit,
}));
vi.mock("@shared/middleware/checkRateLimit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

import { POST as bootstrap } from "../bootstrap/route";
import { POST as submitVerdict } from "../verdict/route";

const PACKET_ID = "a".repeat(24);
const WORKSPACE_ID = "1".repeat(24);
const CAPABILITY = `${WORKSPACE_ID}.${PACKET_ID}.${"bc".repeat(32)}`;
const CAPABILITY_DIGEST = createHash("sha256")
  .update(CAPABILITY, "utf8")
  .digest("hex");

function capabilityWithSecret(secret: string): string {
  return `${WORKSPACE_ID}.${PACKET_ID}.${secret}`;
}

function installCountingRateLimit() {
  const counts = new Map<string, number>();
  mocks.checkRateLimit.mockImplementation(
    async (
      identifier: string,
      config: { keyPrefix: string; maxRequests: number },
    ) => {
      const bucket = `${config.keyPrefix}:${identifier}`;
      const next = (counts.get(bucket) ?? 0) + 1;
      counts.set(bucket, next);
      return next > config.maxRequests
        ? NextResponse.json({ error: "limited" }, { status: 429 })
        : null;
    },
  );
  return counts;
}

function capabilityLimitIdentifiers(prefix: string): string[] {
  return mocks.checkRateLimit.mock.calls
    .filter(([, config]) => config.keyPrefix === prefix)
    .map(([identifier]) => identifier as string);
}

function request(
  path: "bootstrap" | "verdict",
  body: Record<string, unknown>,
  ip = "198.51.100.8",
) {
  return new NextRequest(
    `http://localhost/api/share-packet/${PACKET_ID}/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        "x-forwarded-for": "203.0.113.44",
      },
      body: JSON.stringify(body),
    },
  );
}

function routeParams(packetId = PACKET_ID) {
  return { params: Promise.resolve({ packetId }) };
}

function activeView() {
  return {
    snapshot: {
      version: 1,
      candidateBrief: {
        candidateName: "Ada Lovelace",
        jobTitle: "Senior Full-Stack Engineer",
        experienceYears: 5,
      },
      humanScorecards: {
        total: {
          count: 2,
          recommendations: { strong_yes: 1, yes: 1, no: 0, strong_no: 0 },
          dimensions: [],
        },
        member: {
          count: 1,
          recommendations: { strong_yes: 0, yes: 1, no: 0, strong_no: 0 },
          dimensions: [],
        },
        kit: {
          count: 1,
          recommendations: { strong_yes: 1, yes: 0, no: 0, strong_no: 0 },
          dimensions: [],
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue(null);
  mocks.bootstrap.mockResolvedValue(activeView());
  mocks.submit.mockResolvedValue({ state: "submitted" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/share-packet/[packetId]/bootstrap", () => {
  it("opens only a valid fragment capability, with dual public limits and private response headers", async () => {
    const response = await bootstrap(
      request("bootstrap", { capability: CAPABILITY }),
      routeParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(response.json()).resolves.toEqual({
      state: "ok",
      ...activeView(),
    });
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      "198.51.100.8",
      expect.objectContaining({
        keyPrefix: "rl:hire-share-packet-bootstrap-ip",
        maxRequests: 30,
        failClosed: true,
      }),
    );
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      2,
      CAPABILITY_DIGEST,
      expect.objectContaining({
        keyPrefix: "rl:hire-share-packet-bootstrap-capability",
        maxRequests: 30,
        failClosed: true,
      }),
    );
    expect(mocks.bootstrap).toHaveBeenCalledWith({
      packetId: PACKET_ID,
      capability: CAPABILITY,
    });
  });

  it("keeps guessed valid-format secrets out of a real holder's bootstrap bucket", async () => {
    const counts = installCountingRateLimit();
    const capabilityPrefix = "rl:hire-share-packet-bootstrap-capability";
    mocks.bootstrap.mockImplementation(
      async ({ capability }: { capability: string }) =>
        capability === CAPABILITY ? activeView() : null,
    );

    for (let index = 0; index < 30; index += 1) {
      const spoofed = capabilityWithSecret(
        index.toString(16).padStart(64, "0"),
      );
      const response = await bootstrap(
        request(
          "bootstrap",
          { capability: spoofed },
          `198.51.100.${index + 1}`,
        ),
        routeParams(),
      );
      expect(response.status).toBe(410);
    }

    const holder = await bootstrap(
      request("bootstrap", { capability: CAPABILITY }, "198.51.101.1"),
      routeParams(),
    );
    expect(holder.status).toBe(200);

    const identifiers = capabilityLimitIdentifiers(capabilityPrefix);
    expect(identifiers).toHaveLength(31);
    expect(new Set(identifiers)).toHaveLength(31);
    expect(identifiers).toContain(CAPABILITY_DIGEST);
    expect(identifiers).not.toContain(CAPABILITY);
    expect(identifiers).not.toContain(PACKET_ID);
    expect(
      identifiers.every((identifier) => /^[a-f0-9]{64}$/.test(identifier)),
    ).toBe(true);
    expect(counts.get(`${capabilityPrefix}:${CAPABILITY_DIGEST}`)).toBe(1);
  });

  it("still limits repeated bootstrap attempts for the same capability digest", async () => {
    const counts = installCountingRateLimit();
    const capabilityPrefix = "rl:hire-share-packet-bootstrap-capability";

    for (let index = 0; index < 30; index += 1) {
      const response = await bootstrap(
        request(
          "bootstrap",
          { capability: CAPABILITY },
          `198.18.0.${index + 1}`,
        ),
        routeParams(),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await bootstrap(
      request("bootstrap", { capability: CAPABILITY }, "198.18.1.1"),
      routeParams(),
    );
    expect(blocked.status).toBe(429);
    expect(mocks.bootstrap).toHaveBeenCalledTimes(30);
    expect(capabilityLimitIdentifiers(capabilityPrefix)).toEqual(
      Array.from({ length: 31 }, () => CAPABILITY_DIGEST),
    );
    expect(counts.get(`${capabilityPrefix}:${CAPABILITY_DIGEST}`)).toBe(31);
  });

  it("uses a bounded unknown-client bucket for malformed proxy identity", async () => {
    const malformed = new NextRequest(
      `http://localhost/api/share-packet/${PACKET_ID}/bootstrap`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "not-an-ip",
        },
        body: JSON.stringify({ capability: CAPABILITY }),
      },
    );
    await bootstrap(malformed, routeParams());
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      "unknown-client",
      expect.objectContaining({
        keyPrefix: "rl:hire-share-packet-bootstrap-ip",
      }),
    );
  });

  it("returns one inactive response for malformed, mismatched, and dead capabilities", async () => {
    const malformed = await bootstrap(
      request("bootstrap", { capability: "not-a-capability" }),
      routeParams(),
    );
    expect(malformed.status).toBe(410);
    expect(malformed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.bootstrap).not.toHaveBeenCalled();

    const mismatched = `${WORKSPACE_ID}.${"b".repeat(24)}.${"bc".repeat(32)}`;
    const mismatchedResponse = await bootstrap(
      request("bootstrap", { capability: mismatched }),
      routeParams(),
    );
    expect(mismatchedResponse.status).toBe(410);
    expect(mocks.bootstrap).not.toHaveBeenCalled();

    mocks.bootstrap.mockResolvedValueOnce(null);
    const dead = await bootstrap(
      request("bootstrap", { capability: CAPABILITY }),
      routeParams(),
    );
    expect(dead.status).toBe(410);
    await expect(dead.json()).resolves.toEqual({
      error: "This share packet link is no longer active",
    });
  });

  it("makes a limiter response private without inspecting the packet", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "limited" }, { status: 429 }),
    );
    const response = await bootstrap(
      request("bootstrap", { capability: CAPABILITY }),
      routeParams(),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });
});

describe("POST /api/share-packet/[packetId]/verdict", () => {
  const validBody = {
    capability: CAPABILITY,
    recommendation: "yes",
    comment: "The shared evidence supports a focused next conversation.",
  };

  it("submits one external verdict and returns no reusable snapshot or capability", async () => {
    const response = await submitVerdict(
      request("verdict", validBody),
      routeParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ state: "submitted" });
    expect(mocks.submit).toHaveBeenCalledWith({
      packetId: PACKET_ID,
      ...validBody,
    });
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      "198.51.100.8",
      expect.objectContaining({
        keyPrefix: "rl:hire-share-packet-verdict-ip",
        maxRequests: 8,
      }),
    );
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      2,
      CAPABILITY_DIGEST,
      expect.objectContaining({
        keyPrefix: "rl:hire-share-packet-verdict-capability",
        maxRequests: 8,
      }),
    );
  });

  it("keeps guessed valid-format secrets out of a real holder's verdict bucket", async () => {
    const counts = installCountingRateLimit();
    const capabilityPrefix = "rl:hire-share-packet-verdict-capability";
    mocks.submit.mockImplementation(
      async ({ capability }: { capability: string }) =>
        capability === CAPABILITY ? { state: "submitted" } : null,
    );

    for (let index = 0; index < 8; index += 1) {
      const spoofed = capabilityWithSecret(
        index.toString(16).padStart(64, "0"),
      );
      const response = await submitVerdict(
        request(
          "verdict",
          {
            ...validBody,
            capability: spoofed,
          },
          `203.0.113.${index + 1}`,
        ),
        routeParams(),
      );
      expect(response.status).toBe(410);
    }

    const holder = await submitVerdict(
      request("verdict", validBody, "203.0.114.1"),
      routeParams(),
    );
    expect(holder.status).toBe(200);

    const identifiers = capabilityLimitIdentifiers(capabilityPrefix);
    expect(identifiers).toHaveLength(9);
    expect(new Set(identifiers)).toHaveLength(9);
    expect(identifiers).toContain(CAPABILITY_DIGEST);
    expect(identifiers).not.toContain(CAPABILITY);
    expect(identifiers).not.toContain(PACKET_ID);
    expect(
      identifiers.every((identifier) => /^[a-f0-9]{64}$/.test(identifier)),
    ).toBe(true);
    expect(counts.get(`${capabilityPrefix}:${CAPABILITY_DIGEST}`)).toBe(1);
  });

  it("still limits repeated verdict attempts for the same capability digest", async () => {
    const counts = installCountingRateLimit();
    const capabilityPrefix = "rl:hire-share-packet-verdict-capability";

    for (let index = 0; index < 8; index += 1) {
      const response = await submitVerdict(
        request("verdict", validBody, `192.0.2.${index + 1}`),
        routeParams(),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await submitVerdict(
      request("verdict", validBody, "192.0.2.9"),
      routeParams(),
    );
    expect(blocked.status).toBe(429);
    expect(mocks.submit).toHaveBeenCalledTimes(8);
    expect(capabilityLimitIdentifiers(capabilityPrefix)).toEqual(
      Array.from({ length: 9 }, () => CAPABILITY_DIGEST),
    );
    expect(counts.get(`${capabilityPrefix}:${CAPABILITY_DIGEST}`)).toBe(9);
  });

  it("rejects malformed or over-broad verdict payloads before the service", async () => {
    const overBroad = await submitVerdict(
      request("verdict", {
        ...validBody,
        dimensions: [{ key: "role_capability", rating: 5 }],
      }),
      routeParams(),
    );
    expect(overBroad.status).toBe(410);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("maps a stale submit result to the indistinguishable inactive response", async () => {
    mocks.submit.mockResolvedValueOnce(null);
    const response = await submitVerdict(
      request("verdict", validBody),
      routeParams(),
    );
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "This share packet link is no longer active",
    });
  });
});

describe("public share-packet isolation guards", () => {
  it("does not import B2C authentication, database users, or cookie/session helpers", () => {
    for (const relative of [
      "app/api/share-packet/[packetId]/bootstrap/route.ts",
      "app/api/share-packet/[packetId]/verdict/route.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), relative), "utf8");
      expect(source).not.toMatch(
        /next-auth|@shared\/auth|@shared\/db\/models|cookies\(/,
      );
      expect(source).not.toMatch(/User\.(?:find|findOne|create|update)/);
    }
  });
});
