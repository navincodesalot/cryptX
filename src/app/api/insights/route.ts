import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { queryLogs } from "@/lib/logs/repository";
import { getDb } from "@/lib/mongo/client";
import { ensureIndexes } from "@/lib/mongo/indexes";
import { getBlacklistCollection } from "@/lib/security/blacklist";

const insightsSchema = z.object({
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  summary: z.string(),
  riskyBehaviors: z.array(
    z.object({
      label: z.string(),
      count: z.number(),
      severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
      description: z.string(),
    }),
  ),
  normalBehaviors: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
    }),
  ),
  recommendation: z.enum(["CLEAR", "MONITOR", "BLACKLIST"]),
});

export type InsightsAnalysis = z.infer<typeof insightsSchema>;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const deviceId = searchParams.get("deviceId") ?? "";

    if (!deviceId.startsWith("ledger-")) {
      return NextResponse.json(
        { error: "deviceId query param must start with 'ledger-'" },
        { status: 400 },
      );
    }

    const db = await getDb();
    await ensureIndexes(db);

    const logs = await queryLogs(db, { deviceId, limit: 200 });

    if (logs.length === 0) {
      return NextResponse.json({
        analysis: {
          riskLevel: "LOW",
          summary: "No activity recorded for this device yet.",
          riskyBehaviors: [],
          normalBehaviors: [
            {
              label: "No activity",
              description: "Device has no logged events.",
            },
          ],
          recommendation: "CLEAR",
        } satisfies InsightsAnalysis,
        logCount: 0,
      });
    }

    const blacklistCol = getBlacklistCollection(db);
    const blacklistEntry = await blacklistCol.findOne({
      type: "device",
      value: deviceId,
    });

    const compactLogs = logs.map((l) => ({
      t: l.timestamp instanceof Date ? l.timestamp.toISOString() : l.timestamp,
      a: l.action,
      s: l.status,
      m: l.metadata,
    }));

    const prompt = `You are a security analyst for a hardware cryptocurrency wallet platform called cryptX.
Analyze the following activity logs for device "${deviceId}" and classify the behavior as risky or normal.

${blacklistEntry ? `IMPORTANT: This device is currently BLACKLISTED. Reason: "${blacklistEntry.reason}". This is a strong signal of prior malicious activity.` : "This device is NOT currently blacklisted."}

## Activity Logs (${logs.length} most recent, newest first)
${JSON.stringify(compactLogs, null, 0)}

## Legend
- a = action: CONNECT, DISCONNECT, SIGN_TX, SEND_TX, AUTH_FAIL, AUTH_SUCCESS, MALICIOUS_ACTIVITY, BALANCE_FETCH, HISTORY_FETCH, SESSION_LOGOUT
- s = status: SUCCESS, FAIL, CANCELLED
- m = metadata (contains contextual info like reason, amounts, error details)

## Risky Patterns to Look For
1. **Disconnects during transactions**: DISCONNECT with status FAIL where metadata.during_signing is true — device unplugged mid-transaction
2. **Excessive PIN failures**: Multiple AUTH_FAIL events with metadata.reason "wrong_pin", especially in short succession
3. **Device wipes**: SIGN_TX FAIL with metadata.reason "device_wiped" — indicates 3 wrong PIN attempts triggered a security wipe
4. **Wrong device connections**: CONNECT FAIL with metadata.reason "wrong_ledger" — a device with identity X tried to connect to slot Y, potentially someone using a stolen device
5. **Transaction spikes**: Unusually high volume of SEND_TX in a short period
6. **Repeated seed recovery**: Multiple CONNECT SUCCESS with metadata.recovered true — frequent resets could indicate brute-force attempts
7. **Existing blacklist**: MALICIOUS_ACTIVITY events logged by the system's threat detection

## Normal Patterns
1. Low ratio of AUTH_FAIL to total auth events over time
2. Consistent, spaced out connect/disconnect cycles
3. No MALICIOUS_ACTIVITY events
4. Successful transactions without preceding failed signing attempts
5. Gradual, organic transaction activity

Analyze the logs and return your structured assessment.`;

    const { object } = await generateObject({
      model: google("gemini-3-flash-preview"),
      schema: insightsSchema,
      prompt,
    });

    return NextResponse.json({
      analysis: object,
      logCount: logs.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
