"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Droplets,
  ExternalLink,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Usb,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const HARDWARE_MODE =
  process.env.NEXT_PUBLIC_HARDWARE_MODE === "true";

const PIN_LENGTH = 6;

/* ─── Types ─────────────────────────────────────────────────────────────── */
interface WalletInfo {
  address: string;
  balance: number;
}
interface BalanceResponse {
  ledgerA: WalletInfo;
  ledgerB: WalletInfo;
}
interface TxRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  status: "success" | "failed";
  from: string;
  to: string;
  amount: number;
  fee: number;
}
interface HistoryResponse {
  transactions: TxRecord[];
}
interface ApiResponse {
  signature?: string;
  error?: string;
}

interface HwState {
  connected: boolean;
  mode: string;
  deviceId: string;
  pinSet: boolean;
  pinFails: number;
  pinProgress: number;
}

const INITIAL_HW: HwState = {
  connected: false,
  mode: "UNKNOWN",
  deviceId: "?",
  pinSet: false,
  pinFails: 0,
  pinProgress: 0,
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function shortAddr(addr: string) {
  return addr ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : "—";
}

/** Renders chain time in the viewer's local timezone (avoids UTC from SSR). */
function LocalTxTime({ blockTime }: { blockTime: number | null }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (blockTime == null) {
      setLabel("—");
      return;
    }
    const d = new Date(blockTime * 1000);
    setLabel(
      d.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    );
  }, [blockTime]);

  return <span suppressHydrationWarning>{label ?? "—"}</span>;
}

/* ─── Managed serial connection ──────────────────────────────────────────── */

type LineWaiter = {
  test: (line: string) => boolean;
  resolve: (line: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

class DeviceConnection {
  port: SerialPort;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private running = false;
  private buf = "";
  private waiters = new Set<LineWaiter>();
  onLine: ((line: string) => void) | null = null;

  constructor(port: SerialPort) {
    this.port = port;
  }

  async start() {
    this.reader = this.port.readable!.getReader();
    this.running = true;
    void this.readLoop();
  }

  private async readLoop() {
    const dec = new TextDecoder();
    try {
      while (this.running && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buf += dec.decode(value, { stream: true });
        const lines = this.buf.split("\n");
        this.buf = lines.pop()!;
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          for (const w of this.waiters) {
            if (w.test(line)) {
              clearTimeout(w.timer);
              this.waiters.delete(w);
              w.resolve(line);
            }
          }
          this.onLine?.(line);
        }
      }
    } catch {
      /* port closed */
    }
  }

  async send(cmd: string) {
    if (!this.writer) {
      this.writer = this.port.writable!.getWriter();
    }
    const enc = new TextEncoder();
    await this.writer.write(enc.encode(cmd + "\n"));
  }

  waitFor(
    test: (line: string) => boolean,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("Timeout"));
      }, timeoutMs);
      const waiter: LineWaiter = { test, resolve, timer };
      this.waiters.add(waiter);
    });
  }

  async close() {
    this.running = false;
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.clear();
    try {
      await this.reader?.cancel();
    } catch { /* */ }
    try {
      this.reader?.releaseLock();
    } catch { /* */ }
    try {
      this.writer?.releaseLock();
    } catch { /* */ }
    try {
      await this.port.close();
    } catch { /* */ }
    this.reader = null;
    this.writer = null;
  }
}

function processSerialLine(
  line: string,
  setState: React.Dispatch<React.SetStateAction<HwState>>,
) {
  if (line.startsWith("STATE:")) {
    const parts = line.slice(6).split(",");
    if (parts.length >= 4) {
      const mode = parts[0] ?? "UNKNOWN";
      const deviceId = parts[1] ?? "?";
      const pinSet = (parts[2] ?? "0") === "1";
      const pinFails = parseInt(parts[3] ?? "0", 10) || 0;
      setState((p) => ({
        ...p,
        mode,
        deviceId,
        pinSet,
        pinFails,
      }));
    } else if (parts.length === 1) {
      setState((p) => ({
        ...p,
        mode: parts[0] ?? "UNKNOWN",
        pinProgress: 0,
      }));
    }
  } else if (line.startsWith("PIN_PROGRESS:")) {
    setState((p) => ({
      ...p,
      pinProgress: parseInt(line.slice(13), 10) || 0,
    }));
  } else if (line === "PIN_OK") {
    setState((p) => ({ ...p, pinFails: 0 }));
  } else if (line.startsWith("PIN_FAIL:")) {
    const left = parseInt(line.slice(9), 10) || 0;
    setState((p) => ({
      ...p,
      pinFails: 3 - left,
      pinProgress: 0,
    }));
  } else if (line === "WIPED") {
    setState((p) => ({
      ...p,
      mode: "WIPED",
      pinSet: false,
      pinProgress: 0,
    }));
  } else if (line === "PIN_MISMATCH") {
    setState((p) => ({ ...p, pinProgress: 0 }));
  } else if (line.startsWith("DEVICE:")) {
    setState((p) => ({ ...p, deviceId: line.slice(7) }));
  }
}

/* ─── PIN progress dots ──────────────────────────────────────────────────── */
function PinDots({ filled }: { filled: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: PIN_LENGTH }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "size-3 rounded-full border transition-all",
            i < filled
              ? "border-primary bg-primary scale-110"
              : "border-muted-foreground/40 bg-transparent",
          )}
        />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Page                                                                      */
/* ═══════════════════════════════════════════════════════════════════════════ */
export default function HomePage() {
  const [ledgerA, setLedgerA] = useState<WalletInfo | null>(null);
  const [ledgerB, setLedgerB] = useState<WalletInfo | null>(null);
  const [txHistory, setTxHistory] = useState<TxRecord[]>([]);

  const [loadingBalances, setLoadingBalances] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sendingFrom, setSendingFrom] = useState<"A" | "B" | null>(null);
  const [airdropping, setAirdropping] = useState<"A" | "B" | null>(null);
  const [awaitingHw, setAwaitingHw] = useState<"A" | "B" | null>(null);
  const [connectingHw, setConnectingHw] = useState<"A" | "B" | null>(null);

  const [hwStateA, setHwStateA] = useState<HwState>(INITIAL_HW);
  const [hwStateB, setHwStateB] = useState<HwState>(INITIAL_HW);

  const deviceARef = useRef<DeviceConnection | null>(null);
  const deviceBRef = useRef<DeviceConnection | null>(null);

  const hasSerial = useRef(
    typeof window !== "undefined" && "serial" in navigator,
  ).current;

  const addrA = ledgerA?.address ?? "";
  const addrB = ledgerB?.address ?? "";

  useEffect(() => {
    return () => {
      deviceARef.current?.close();
      deviceBRef.current?.close();
    };
  }, []);

  /* ── Data fetching ─────────────────────────────────────────────────────── */
  const fetchBalances = useCallback(async () => {
    setLoadingBalances(true);
    try {
      const res = await fetch("/api/balance");
      const data = (await res.json()) as BalanceResponse;
      setLedgerA(data.ledgerA);
      setLedgerB(data.ledgerB);
    } catch {
      toast.error("Failed to fetch balances");
    } finally {
      setLoadingBalances(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch("/api/history");
      const data = (await res.json()) as HistoryResponse;
      setTxHistory(data.transactions ?? []);
    } catch {
      toast.error("Failed to fetch history");
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    void fetchBalances();
    void fetchHistory();
  }, [fetchBalances, fetchHistory]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  /* ── Hardware connect ──────────────────────────────────────────────────── */
  const connectHardware = async (ledger: "A" | "B") => {
    setConnectingHw(ledger);
    const setState = ledger === "A" ? setHwStateA : setHwStateB;
    const deviceRef = ledger === "A" ? deviceARef : deviceBRef;

    try {
      if (!navigator.serial)
        throw new Error("Web Serial not supported in this browser");

      // Close existing connection if any
      if (deviceRef.current) {
        await deviceRef.current.close();
        deviceRef.current = null;
        setState(INITIAL_HW);
      }

      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });

      const device = new DeviceConnection(port);
      device.onLine = (line) => processSerialLine(line, setState);
      await device.start();

      // Wait for greeting
      const deviceLine = await device
        .waitFor((l) => l.startsWith("DEVICE:"), 5000)
        .catch(() => null);
      const detectedId = deviceLine ? deviceLine.slice(7) : "?";

      // Wait for READY
      await device.waitFor((l) => l === "READY", 5000).catch(() => null);

      // Get full state
      await device.send("STATE");
      const stateLine = await device
        .waitFor(
          (l) => l.startsWith("STATE:") && l.includes(","),
          3000,
        )
        .catch(() => null);

      let mode = "UNKNOWN";
      let pinSet = false;
      let pinFails = 0;

      if (stateLine) {
        const parts = stateLine.slice(6).split(",");
        if (parts.length >= 4) {
          mode = parts[0] ?? "UNKNOWN";
          pinSet = (parts[2] ?? "0") === "1";
          pinFails = parseInt(parts[3] ?? "0", 10) || 0;
        }
      }

      // Enforce A/B match in hardware mode
      if (
        HARDWARE_MODE &&
        detectedId !== "?" &&
        detectedId !== ledger &&
        mode !== "INIT"
      ) {
        await device.close();
        toast.error(
          `This device is Ledger ${detectedId}, not Ledger ${ledger}. Connect the correct device.`,
        );
        return;
      }

      deviceRef.current = device;
      setState({
        connected: true,
        mode,
        deviceId: detectedId,
        pinSet,
        pinFails,
        pinProgress: 0,
      });

      toast.success(`Ledger ${ledger} connected — ${mode}`);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotFoundError") {
        toast.error(
          err instanceof Error ? err.message : "Failed to connect",
        );
      }
    } finally {
      setConnectingHw(null);
    }
  };

  /* ── Register (SETID) ─────────────────────────────────────────────────── */
  const registerDevice = async (ledger: "A" | "B") => {
    const device =
      ledger === "A" ? deviceARef.current : deviceBRef.current;
    if (!device) return;
    try {
      await device.send(`SETID ${ledger}`);
      toast.success(`Registered as Ledger ${ledger} — now set your PIN`);
    } catch {
      toast.error("Failed to register device");
    }
  };

  /* ── Recover ───────────────────────────────────────────────────────────── */
  const recoverDevice = async (ledger: "A" | "B") => {
    const device =
      ledger === "A" ? deviceARef.current : deviceBRef.current;
    if (!device) return;
    try {
      await device.send("RECOVER");
      await device
        .waitFor((l) => l === "RECOVERED", 3000)
        .catch(() => null);
      toast.success(
        `Ledger ${ledger} recovered — go through setup again`,
      );
    } catch {
      toast.error("Recovery failed");
    }
  };

  /* ── Airdrop ───────────────────────────────────────────────────────────── */
  const handleAirdrop = async (wallet: "A" | "B") => {
    setAirdropping(wallet);
    try {
      const res = await fetch("/api/airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const data = (await res.json()) as ApiResponse;
      if (!res.ok || data.error) {
        toast.error(data.error ?? "Airdrop failed");
        return;
      }
      toast.success(`Airdropped 1 SOL to Ledger ${wallet}`, {
        description: (
          <a
            href={`https://explorer.solana.com/tx/${data.signature}?cluster=testnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View on Explorer
          </a>
        ),
      });
      await fetchBalances();
    } catch {
      toast.error("Network error during airdrop");
    } finally {
      setAirdropping(null);
    }
  };

  /* ── Transfer (with hardware PIN flow) ──────────────────────────────────── */
  const handleTransfer = async (from: "A" | "B") => {
    setSendingFrom(from);
    try {
      if (HARDWARE_MODE) {
        const device =
          from === "A" ? deviceARef.current : deviceBRef.current;
        const hw = from === "A" ? hwStateA : hwStateB;

        if (!device || !hw.connected) {
          toast.error(`Connect Ledger ${from} first`);
          return;
        }
        if (hw.mode !== "READY") {
          toast.error(
            `Ledger ${from} is not ready. Complete setup first.`,
          );
          return;
        }

        setAwaitingHw(from);
        toast.loading(`Enter PIN on Ledger ${from}…`, {
          id: "hw-confirm",
        });

        await device.send("SIGN");

        const result = await device
          .waitFor(
            (l) =>
              l === "CONFIRMED" ||
              l === "REJECTED" ||
              l === "WIPED" ||
              l.startsWith("ERR:"),
            35_000,
          )
          .catch(() => "timeout");

        setAwaitingHw(null);
        toast.dismiss("hw-confirm");

        if (result === "WIPED") {
          toast.error(
            `Ledger ${from} was wiped after 3 wrong PINs! Use Recover to re-setup.`,
          );
          return;
        }
        if (result === "REJECTED" || result === "timeout") {
          toast.error(`Transaction cancelled or timed out`);
          return;
        }
        if (result.startsWith("ERR:")) {
          toast.error(result);
          return;
        }
        if (result !== "CONFIRMED") {
          toast.error(`Unexpected: ${result}`);
          return;
        }
      }

      const res = await fetch("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, amount: 0.01 }),
      });
      const data = (await res.json()) as ApiResponse;

      if (!res.ok || data.error) {
        toast.error(data.error ?? "Transfer failed");
        return;
      }

      toast.success(`Sent 0.01 SOL from Ledger ${from}`, {
        description: (
          <a
            href={`https://explorer.solana.com/tx/${data.signature}?cluster=testnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View on Explorer
          </a>
        ),
      });

      await fetchBalances();
      await fetchHistory();
    } catch {
      toast.error("Network error during transfer");
    } finally {
      setSendingFrom(null);
      setAwaitingHw(null);
      toast.dismiss("hw-confirm");
    }
  };

  /* ── Render ────────────────────────────────────────────────────────────── */
  return (
    <main className="bg-background text-foreground min-h-screen p-6 md:p-10">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Header */}
        <header className="flex items-start justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">
              crypt<span className="text-primary">X</span>
            </h1>
            <p className="text-muted-foreground text-sm">
              DIY Hardware Wallet Network
            </p>
          </div>
          <div className="flex items-center gap-2">
            {HARDWARE_MODE && (
              <Badge variant="outline" className="gap-1.5">
                <KeyRound className="size-3" />
                Hardware Mode
              </Badge>
            )}
            <Badge variant="outline" className="gap-1.5">
              <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
              Solana Testnet
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              onClick={refreshAll}
              disabled={loadingBalances || loadingHistory}
              title="Refresh"
            >
              <RefreshCw
                className={cn(
                  (loadingBalances || loadingHistory) && "animate-spin",
                )}
              />
            </Button>
          </div>
        </header>

        <Separator />

        {/* No Web Serial warning */}
        {HARDWARE_MODE && !hasSerial && (
          <Card className="border-destructive">
            <CardContent className="flex items-center gap-3 py-4">
              <AlertTriangle className="text-destructive size-5 shrink-0" />
              <p className="text-sm">
                Hardware Mode is on but your browser does not support Web
                Serial. Use Chrome or Edge.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Ledger Cards */}
        <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <LedgerCard
            label="Ledger A"
            index="A"
            wallet={ledgerA}
            loading={loadingBalances}
            hwState={hwStateA}
            hardwareMode={HARDWARE_MODE}
            sendingNow={sendingFrom === "A"}
            airdropping={airdropping === "A"}
            awaitingHardware={awaitingHw === "A"}
            connectingHardware={connectingHw === "A"}
            hasSerial={hasSerial}
            onSend={() => handleTransfer("A")}
            onAirdrop={() => handleAirdrop("A")}
            onConnect={() => connectHardware("A")}
            onRegister={() => registerDevice("A")}
            onRecover={() => recoverDevice("A")}
          />
          <LedgerCard
            label="Ledger B"
            index="B"
            wallet={ledgerB}
            loading={loadingBalances}
            hwState={hwStateB}
            hardwareMode={HARDWARE_MODE}
            sendingNow={sendingFrom === "B"}
            airdropping={airdropping === "B"}
            awaitingHardware={awaitingHw === "B"}
            connectingHardware={connectingHw === "B"}
            hasSerial={hasSerial}
            onSend={() => handleTransfer("B")}
            onAirdrop={() => handleAirdrop("B")}
            onConnect={() => connectHardware("B")}
            onRegister={() => registerDevice("B")}
            onRecover={() => recoverDevice("B")}
          />
        </section>

        {/* Transfer indicator */}
        <div className="text-muted-foreground flex items-center justify-center gap-3 text-sm">
          <span className="font-mono text-xs">{shortAddr(addrA)}</span>
          <ArrowRightLeft className="size-4" />
          <span className="font-mono text-xs">{shortAddr(addrB)}</span>
        </div>

        <Separator />

        {/* Transaction History */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              Transaction History
            </h2>
            {loadingHistory && (
              <CircleDashed className="text-muted-foreground size-4 animate-spin" />
            )}
          </div>

          {txHistory.length === 0 && !loadingHistory ? (
            <Card>
              <CardContent className="text-muted-foreground py-10 text-center text-sm">
                No transactions yet. Airdrop some SOL and send a
                transfer.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Time</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {txHistory.map((tx) => (
                    <TableRow key={tx.signature}>
                      <TableCell>
                        {tx.status === "success" ? (
                          <CheckCircle2 className="size-4 text-emerald-400" />
                        ) : (
                          <XCircle className="size-4 text-destructive" />
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs tabular-nums">
                        <LocalTxTime blockTime={tx.blockTime} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <AddressLabel
                          addr={tx.from}
                          addrA={addrA}
                          addrB={addrB}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <AddressLabel
                          addr={tx.to}
                          addrA={addrA}
                          addrB={addrB}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {tx.amount > 0 ? (
                          <span className="text-sm font-medium">
                            {tx.amount.toFixed(4)}
                            <span className="text-muted-foreground ml-1 text-xs">
                              SOL
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                        {tx.fee.toFixed(6)}
                      </TableCell>
                      <TableCell>
                        <a
                          href={`https://explorer.solana.com/tx/${tx.signature}?cluster=testnet`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          title="View on Explorer"
                        >
                          <ExternalLink className="size-3" />
                        </a>
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  LedgerCard                                                                */
/* ═══════════════════════════════════════════════════════════════════════════ */
function LedgerCard({
  label,
  index,
  wallet,
  loading,
  hwState,
  hardwareMode,
  sendingNow,
  airdropping,
  awaitingHardware,
  connectingHardware,
  hasSerial,
  onSend,
  onAirdrop,
  onConnect,
  onRegister,
  onRecover,
}: {
  label: string;
  index: "A" | "B";
  wallet: WalletInfo | null;
  loading: boolean;
  hwState: HwState;
  hardwareMode: boolean;
  sendingNow: boolean;
  airdropping: boolean;
  awaitingHardware: boolean;
  connectingHardware: boolean;
  hasSerial: boolean;
  onSend: () => void;
  onAirdrop: () => void;
  onConnect: () => void;
  onRegister: () => void;
  onRecover: () => void;
}) {
  const short = wallet ? shortAddr(wallet.address) : "—";
  const busy =
    sendingNow ||
    airdropping ||
    awaitingHardware ||
    loading ||
    connectingHardware;

  const isSetup =
    hwState.mode === "INIT" ||
    hwState.mode === "SET_PIN" ||
    hwState.mode === "CONFIRM_PIN";
  const isWiped = hwState.mode === "WIPED";
  const isSigning =
    hwState.mode === "SIGNING" || awaitingHardware;
  const isReady = hwState.mode === "READY";
  const showSetupFlow =
    hardwareMode && hwState.connected && (isSetup || isWiped);

  let sendLabel = "Send 0.01 SOL";
  if (awaitingHardware) sendLabel = "Enter PIN on device…";
  else if (sendingNow) sendLabel = "Sending…";

  const sendDisabled =
    busy ||
    (hardwareMode && (!hwState.connected || !isReady));

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Cpu className="text-primary size-4" />
            {label}
          </CardTitle>
          <div className="flex items-center gap-2">
            {hardwareMode && (
              <span
                className={cn(
                  "size-2 rounded-full transition-colors",
                  hwState.connected
                    ? isReady
                      ? "bg-emerald-400"
                      : "bg-amber-400"
                    : "bg-muted-foreground/30",
                )}
                title={
                  hwState.connected
                    ? `Mode: ${hwState.mode}`
                    : "Not connected"
                }
              />
            )}
            <Badge variant="secondary">Arduino #{index}</Badge>
          </div>
        </div>
        <CardDescription className="font-mono text-xs">
          {loading ? "Loading…" : short}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1 space-y-4">
        {/* ── Balance (always shown) ─────────────────────────── */}
        <div>
          <p className="text-5xl font-bold tabular-nums">
            {loading || wallet === null ? (
              <span className="text-muted-foreground text-3xl">—</span>
            ) : (
              wallet.balance.toFixed(4)
            )}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">SOL</p>
        </div>

        {/* ── Hardware status overlay ────────────────────────── */}
        {hardwareMode && !hwState.connected && (
          <div className="bg-muted/50 flex flex-col items-center gap-3 rounded-lg py-6">
            <Usb className="text-muted-foreground size-8" />
            <p className="text-muted-foreground text-sm">
              Connect your Arduino to begin
            </p>
          </div>
        )}

        {showSetupFlow && hwState.mode === "INIT" && (
          <div className="bg-muted/50 space-y-3 rounded-lg p-4">
            <p className="text-sm font-medium">Device Setup</p>
            <p className="text-muted-foreground text-xs">
              Register this Arduino as Ledger {index}
            </p>
            <Button
              size="sm"
              className="w-full"
              onClick={onRegister}
            >
              Register as Ledger {index}
            </Button>
          </div>
        )}

        {showSetupFlow &&
          (hwState.mode === "SET_PIN" ||
            hwState.mode === "CONFIRM_PIN") && (
            <div className="bg-muted/50 space-y-3 rounded-lg p-4">
              <p className="text-sm font-medium">
                {hwState.mode === "SET_PIN"
                  ? "Create PIN"
                  : "Confirm PIN"}
              </p>
              <p className="text-muted-foreground text-xs">
                Press and release one button at a time: btn 1 = digit 1, btn
                2 = digit 2. The digit is counted on release. Six digits
                submit automatically. If both buttons are pressed together,
                nothing is counted until both are released.
              </p>
              <PinDots filled={hwState.pinProgress} />
            </div>
          )}

        {showSetupFlow && isWiped && (
          <div className="bg-destructive/10 space-y-3 rounded-lg p-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="text-destructive size-4" />
              <p className="text-destructive text-sm font-medium">
                Device Wiped
              </p>
            </div>
            <p className="text-muted-foreground text-xs">
              3 wrong PIN attempts. Recover to re-setup.
            </p>
            <Button
              size="sm"
              variant="destructive"
              className="w-full"
              onClick={onRecover}
            >
              <RotateCcw className="mr-2 size-3" />
              Recover Device
            </Button>
          </div>
        )}

        {hardwareMode && hwState.connected && isSigning && (
          <div className="bg-amber-500/10 space-y-3 rounded-lg p-4">
            <p className="text-sm font-medium text-amber-500">
              Signing Transaction
            </p>
            <p className="text-muted-foreground text-xs">
              Enter your PIN on the device
            </p>
            <PinDots filled={hwState.pinProgress} />
            {hwState.pinFails > 0 && (
              <p className="text-destructive text-xs">
                {hwState.pinFails} wrong attempt
                {hwState.pinFails > 1 ? "s" : ""} —{" "}
                {3 - hwState.pinFails} left
              </p>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-col gap-2">
        {/* Send / Airdrop always shown (disabled if hardware not ready) */}
        <Button
          className="w-full"
          onClick={onSend}
          disabled={sendDisabled}
        >
          <ArrowRightLeft className="mr-2 size-4" />
          {sendLabel}
        </Button>

        <Button
          variant="outline"
          className="w-full"
          onClick={onAirdrop}
          disabled={busy}
        >
          <Droplets className="mr-2 size-4" />
          {airdropping ? "Requesting…" : "Airdrop 1 SOL"}
        </Button>

        {/* Connect button */}
        {hasSerial && hardwareMode && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "w-full gap-2 text-xs",
              hwState.connected &&
                isReady &&
                "text-emerald-400 hover:text-emerald-300",
            )}
            onClick={onConnect}
            disabled={busy || connectingHardware}
          >
            <Usb className="size-3" />
            {connectingHardware
              ? "Connecting…"
              : hwState.connected
                ? isReady
                  ? "Connected"
                  : `Connected — ${hwState.mode}`
                : "Connect Arduino"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/* ─── AddressLabel ───────────────────────────────────────────────────────── */
function AddressLabel({
  addr,
  addrA,
  addrB,
}: {
  addr: string;
  addrA: string;
  addrB: string;
}) {
  if (!addr) return <span className="text-muted-foreground">—</span>;
  if (addr === addrA)
    return (
      <span className="text-primary font-semibold">Ledger A</span>
    );
  if (addr === addrB)
    return (
      <span className="font-semibold text-violet-400">Ledger B</span>
    );
  return <span>{shortAddr(addr)}</span>;
}
