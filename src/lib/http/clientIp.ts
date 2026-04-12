/**
 * Best-effort client IP from reverse-proxy headers.
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real?.trim()) return real.trim();
  return "unknown";
}

export function resolveClientIp(req: Request, bodyHint?: string): string {
  const fromHeader = getClientIp(req);
  if (fromHeader !== "unknown") return fromHeader;
  if (bodyHint?.trim()) return bodyHint.trim();
  return "unknown";
}
