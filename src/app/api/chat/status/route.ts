import { MissingCredentials, provider } from "@/lib/chat/provider";

/**
 * Is the chat configured? The panel asks on open and explains itself when
 * the answer is no. The app works without a key; only this panel needs one.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { name, model } = provider();
    return Response.json({ ready: true, provider: name, model });
  } catch (err) {
    if (err instanceof MissingCredentials) {
      return Response.json({ ready: false, reason: err.message });
    }
    throw err;
  }
}
