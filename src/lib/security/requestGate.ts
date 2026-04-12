import { auth0 } from "@/lib/auth0";
import { getClientIp } from "@/lib/http/clientIp";
import { getDb } from "@/lib/mongo/client";
import { isBlacklisted } from "@/lib/security/blacklist";

/**
 * Stable device key for audit logs + blacklist checks on API routes.
 */
export async function getAuditDeviceId(req: Request): Promise<{
  ip: string;
  deviceId: string;
}> {
  const ip = getClientIp(req);
  const session = await auth0.getSession();
  const deviceId = session?.user?.sub
    ? `user:${session.user.sub}`
    : `anon:${ip}`;
  return { ip, deviceId };
}

export async function isRequestBlocked(
  ip: string,
  deviceId: string,
): Promise<boolean> {
  try {
    const db = await getDb();
    return await isBlacklisted(db, ip, deviceId);
  } catch {
    return false;
  }
}
