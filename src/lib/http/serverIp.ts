import { headers } from "next/headers";

/** IP for server components / route handlers using `headers()`. */
export async function getIpFromIncomingHeaders(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = h.get("x-real-ip");
  if (real?.trim()) return real.trim();
  return "unknown";
}
