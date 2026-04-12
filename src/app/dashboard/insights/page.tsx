"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface RiskyBehavior {
  label: string;
  count: number;
  severity: "LOW" | "MEDIUM" | "HIGH";
  description: string;
}

interface NormalBehavior {
  label: string;
  description: string;
}

interface InsightsAnalysis {
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  summary: string;
  riskyBehaviors: RiskyBehavior[];
  normalBehaviors: NormalBehavior[];
  recommendation: "CLEAR" | "MONITOR" | "BLACKLIST";
}

interface InsightsResponse {
  analysis: InsightsAnalysis;
  logCount: number;
  error?: string;
}

interface LogEntry {
  id?: string;
  timestamp: string;
  deviceId: string;
  action: string;
  status: string;
  metadata: Record<string, unknown>;
}

interface LogsResponse {
  logs: LogEntry[];
  count: number;
}

const RISK_COLORS = {
  LOW: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  MEDIUM: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  HIGH: "bg-destructive/10 text-destructive border-destructive/20",
} as const;

const RECOMMENDATION_LABELS = {
  CLEAR: { label: "Clear", icon: ShieldCheck, color: "text-emerald-400" },
  MONITOR: { label: "Monitor", icon: AlertTriangle, color: "text-amber-400" },
  BLACKLIST: { label: "Blacklist", icon: ShieldAlert, color: "text-destructive" },
} as const;

function SeverityBadge({ severity }: { severity: "LOW" | "MEDIUM" | "HIGH" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase",
        RISK_COLORS[severity],
      )}
    >
      {severity}
    </span>
  );
}

function MetadataPreview({ metadata }: { metadata: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(metadata).filter(
    (k) => k !== "ingestion" && metadata[k] !== undefined,
  );
  if (keys.length === 0) return <span className="text-muted-foreground">—</span>;

  const preview = keys.slice(0, 2).map((k) => `${k}: ${JSON.stringify(metadata[k])}`).join(", ");

  return (
    <div className="max-w-[260px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-left text-[11px]"
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span className="truncate">{preview}{keys.length > 2 ? ` +${keys.length - 2}` : ""}</span>
      </button>
      {open && (
        <pre className="bg-muted mt-1 max-h-40 overflow-auto rounded p-2 text-[10px]">
          {JSON.stringify(metadata, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function InsightsPageWrapper() {
  return (
    <Suspense
      fallback={
        <main className="bg-background text-foreground flex min-h-screen items-center justify-center">
          <CircleDashed className="text-muted-foreground size-6 animate-spin" />
        </main>
      }
    >
      <InsightsPage />
    </Suspense>
  );
}

function InsightsPage() {
  const searchParams = useSearchParams();
  const deviceId = searchParams.get("deviceId") ?? "";

  const [analysis, setAnalysis] = useState<InsightsAnalysis | null>(null);
  const [logCount, setLogCount] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingAnalysis, setLoadingAnalysis] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId || !deviceId.startsWith("ledger-")) return;

    setLoadingAnalysis(true);
    setLoadingLogs(true);

    fetch(`/api/insights?deviceId=${encodeURIComponent(deviceId)}`)
      .then((r) => r.json() as Promise<InsightsResponse>)
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setAnalysis(data.analysis);
          setLogCount(data.logCount);
        }
      })
      .catch(() => setError("Failed to fetch analysis"))
      .finally(() => setLoadingAnalysis(false));

    fetch(`/api/logs?deviceId=${encodeURIComponent(deviceId)}&limit=200`)
      .then((r) => r.json() as Promise<LogsResponse>)
      .then((data) => setLogs(data.logs ?? []))
      .catch(() => {})
      .finally(() => setLoadingLogs(false));
  }, [deviceId]);

  if (!deviceId || !deviceId.startsWith("ledger-")) {
    return (
      <main className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
        <Card className="max-w-sm">
          <CardContent className="space-y-4 py-8 text-center">
            <p className="text-muted-foreground text-sm">
              No device selected. Connect a ledger from the dashboard first.
            </p>
            <a
              href="/dashboard"
              className={buttonVariants({ variant: "outline" })}
            >
              <ArrowLeft className="mr-2 size-4" />
              Back to Dashboard
            </a>
          </CardContent>
        </Card>
      </main>
    );
  }

  const Rec = analysis
    ? RECOMMENDATION_LABELS[analysis.recommendation]
    : null;

  return (
    <main className="bg-background text-foreground min-h-screen p-6 md:p-10">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Header */}
        <header className="flex items-start justify-between">
          <div className="space-y-1">
            <a
              href="/dashboard"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
            >
              <ArrowLeft className="size-3.5" />
              Dashboard
            </a>
            <h1 className="text-2xl font-bold tracking-tight">
              Device Insights
            </h1>
            <p className="text-muted-foreground font-mono text-xs">
              {deviceId}
            </p>
          </div>
          {analysis && (
            <div className="flex items-center gap-2">
              <SeverityBadge severity={analysis.riskLevel} />
              {Rec && (
                <Badge variant="outline" className={cn("gap-1.5", Rec.color)}>
                  <Rec.icon className="size-3" />
                  {Rec.label}
                </Badge>
              )}
            </div>
          )}
        </header>

        {/* Loading */}
        {loadingAnalysis && (
          <Card>
            <CardContent className="flex items-center justify-center gap-3 py-12">
              <CircleDashed className="text-muted-foreground size-5 animate-spin" />
              <p className="text-muted-foreground text-sm">
                Analyzing device logs with Gemini...
              </p>
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {error && (
          <Card className="border-destructive">
            <CardContent className="flex items-center gap-3 py-4">
              <AlertTriangle className="text-destructive size-5 shrink-0" />
              <p className="text-sm">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* AI Summary */}
        {analysis && !loadingAnalysis && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">AI Summary</CardTitle>
                <CardDescription>
                  Based on {logCount} recent log entries
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed">{analysis.summary}</p>
              </CardContent>
            </Card>

            {/* Risky Behaviors */}
            {analysis.riskyBehaviors.length > 0 && (
              <section className="space-y-3">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <ShieldAlert className="text-destructive size-5" />
                  Risky Behaviors
                </h2>
                <div className="grid gap-3">
                  {analysis.riskyBehaviors.map((b, i) => (
                    <Card key={i}>
                      <CardContent className="flex items-start gap-4 py-4">
                        <SeverityBadge severity={b.severity} />
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{b.label}</p>
                            <span className="text-muted-foreground text-xs tabular-nums">
                              ({b.count} occurrence{b.count !== 1 ? "s" : ""})
                            </span>
                          </div>
                          <p className="text-muted-foreground text-xs leading-relaxed">
                            {b.description}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            )}

            {/* Normal Behaviors */}
            {analysis.normalBehaviors.length > 0 && (
              <section className="space-y-3">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <ShieldCheck className="size-5 text-emerald-400" />
                  Normal Behaviors
                </h2>
                <Card>
                  <CardContent className="space-y-3 py-4">
                    {analysis.normalBehaviors.map((b, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium">{b.label}</p>
                          <p className="text-muted-foreground text-xs">
                            {b.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </section>
            )}
          </>
        )}

        {/* Raw Log Table */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Raw Logs</h2>
            {loadingLogs && (
              <CircleDashed className="text-muted-foreground size-4 animate-spin" />
            )}
          </div>

          {logs.length === 0 && !loadingLogs ? (
            <Card>
              <CardContent className="text-muted-foreground py-10 text-center text-sm">
                No logs recorded for this device.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Time</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log, i) => (
                    <TableRow key={log.id ?? i}>
                      <TableCell>
                        {log.status === "SUCCESS" ? (
                          <CheckCircle2 className="size-3.5 text-emerald-400" />
                        ) : log.status === "FAIL" ? (
                          <AlertTriangle className="text-destructive size-3.5" />
                        ) : (
                          <CircleDashed className="text-muted-foreground size-3.5" />
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs tabular-nums">
                        <LogTimestamp iso={log.timestamp} />
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            log.action === "MALICIOUS_ACTIVITY"
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-[10px]"
                        >
                          {log.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{log.status}</TableCell>
                      <TableCell>
                        <MetadataPreview metadata={log.metadata ?? {}} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}

function LogTimestamp({ iso }: { iso: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date(iso);
    setLabel(
      d.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    );
  }, [iso]);
  return <span suppressHydrationWarning>{label ?? iso}</span>;
}
