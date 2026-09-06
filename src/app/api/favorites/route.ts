import { favoriteKeys } from "@/db/queries";

/**
 * The identities of every saved favourite. The chat panel is the one
 * client-rendered surface that draws save buttons, and it needs to know
 * which options are already saved; the pages get the same set server-side.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const keys = await favoriteKeys();
  return Response.json({ keys: [...keys] });
}
