import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SharePacketCapabilitySchema } from "@hire-decisions";
import { bootstrapSharePacket } from "@hire-decisions/services/sharePacketService";
import { checkRateLimit } from "@shared/middleware/checkRateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

const BodySchema = z
  .object({ capability: SharePacketCapabilitySchema })
  .strict();

function noStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function inactive(): NextResponse {
  return NextResponse.json(
    { error: "This share packet link is no longer active" },
    { status: 410, headers: NO_STORE_HEADERS },
  );
}

function isCapabilityForPacket(capability: string, packetId: string): boolean {
  const [, capabilityPacketId] = capability.split(".");
  return capabilityPacketId?.toLowerCase() === packetId.toLowerCase();
}

function capabilityRateLimitKey(capability: string): string {
  // `checkRateLimit` stores/logs its identifier. Hash the complete validated
  // capability so neither its secret nor its packet coordinate is used as a
  // Redis/log key, and guessed secrets cannot consume a holder's bucket.
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

function requestIp(req: NextRequest): string {
  const firstValidIp = (raw: string | null): string | undefined => {
    const value = raw?.split(",")[0]?.trim();
    return value && isIP(value) ? value : undefined;
  };
  return process.env.VERCEL === "1"
    ? (firstValidIp(req.headers.get("x-vercel-forwarded-for")) ??
        firstValidIp(req.headers.get("x-real-ip")) ??
        firstValidIp(req.headers.get("x-forwarded-for")) ??
        "unknown-client")
    : (firstValidIp(req.headers.get("cf-connecting-ip")) ??
        firstValidIp(req.headers.get("x-real-ip")) ??
        firstValidIp(req.headers.get("x-forwarded-for")) ??
        "unknown-client");
}

async function checkBootstrapRateLimits(
  req: NextRequest,
  capability: string,
): Promise<NextResponse | null> {
  const ipBlocked = await checkRateLimit(requestIp(req), {
    windowMs: 15 * 60_000,
    maxRequests: 30,
    keyPrefix: "rl:hire-share-packet-bootstrap-ip",
    failClosed: true,
  });
  if (ipBlocked) return noStore(ipBlocked);
  const capabilityBlocked = await checkRateLimit(
    capabilityRateLimitKey(capability),
    {
      windowMs: 15 * 60_000,
      maxRequests: 30,
      keyPrefix: "rl:hire-share-packet-bootstrap-capability",
      failClosed: true,
    },
  );
  return capabilityBlocked ? noStore(capabilityBlocked) : null;
}

/** Sessionless, fragment-capability bootstrap for a fixed packet snapshot. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ packetId: string }> },
) {
  const { packetId } = await params;
  if (!OBJECT_ID.test(packetId)) return inactive();
  let capability: string;
  try {
    capability = BodySchema.parse(await req.json()).capability;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return inactive();
    return NextResponse.json(
      { error: "The share packet could not be loaded" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
  if (!isCapabilityForPacket(capability, packetId)) return inactive();
  const blocked = await checkBootstrapRateLimits(req, capability);
  if (blocked) return blocked;
  try {
    const view = await bootstrapSharePacket({ packetId, capability });
    if (!view) return inactive();
    return NextResponse.json(
      { state: "ok", snapshot: view.snapshot },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { error: "The share packet could not be loaded" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
