import type { Metadata } from "next";
import SharePacketEntry from "./SharePacketEntry";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Share packet — IPG Hire",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** The public authority remains only in the fragment, never in this request. */
export default async function SharePacketPage({
  params,
}: {
  params: Promise<{ packetId: string }>;
}) {
  const { packetId } = await params;
  return <SharePacketEntry packetId={packetId} />;
}
