"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeft,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Droplets,
  ExternalLink,
  RefreshCw,
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

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function shortAddr(addr: string) {
  return addr ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : "—";
}

function formatTime(blockTime: number | null) {
  if (!blockTime) return "—";
  return new Date(blockTime * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* ─── Web Serial helpers ─────────────────────────────────────────────────── */

/**
 * Opens the Web Serial port picker, opens the port, reads the greeting
 * ("DEVICE:A\nREADY\n") and returns the port + detected device ID.
 * Throws if the user cancels or the port fails to open.
 */
async function openSerialPort(): Promise<{ port: SerialPort; deviceId: string }> {
  if (!navigator.serial) throw new Error("Web Serial not supported in this browser");

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  // Arduino resets on port open and prints "DEVICE:X\nREADY\n" within ~2s.
  const reader = port.readable!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let deviceId = "?";

  const greetTimeout = setTimeout(
    () => reader.cancel("timeout greeting").catch(() => undefined),
    3000,
  );

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const match = /DEVICE:([AB])/.exec(buf);
      if (match?.[1]) {
        deviceId = match[1];
        break;
      }
      if (buf.includes("READY")) break;
    }
  } catch {
    // timeout or cancelled — still proceed
  } finally {
    clearTimeout(greetTimeout);
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  return { port, deviceId };
}

/**
 * Sends SIGN to the device and waits up to 30 s for CONFIRMED or REJECTED.
 * Returns true on confirmation, false otherwise.
 */
async function requestDeviceConfirmation(port: SerialPort): Promise<boolean> {
  const writer = port.writable!.getWriter();
  const reader = port.readable!.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let confirmed = false;

  const cancelTimer = setTimeout(
    () => reader.cancel("sign timeout").catch(() => undefined),
    30_000,
  );

  try {
    await writer.write(enc.encode("SIGN\n"));

    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("CONFIRMED")) { confirmed = true; break; }
      if (buf.includes("REJECTED")) break;
    }

    if (!confirmed) {
      // Tell device to return to idle
      await writer.write(enc.encode("CANCEL\n")).catch(() => undefined);
    }
  } catch {
    // timeout cancelled the read
    await writer.write(enc.encode("CANCEL\n")).catch(() => undefined);
  } finally {
    clearTimeout(cancelTimer);
    try { writer.releaseLock(); } catch { /* already released */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  return confirmed;
}

/* ─── Page ───────────────────────────────────────────────────────────────── */
export default function HomePage() {
  const [ledgerA, setLedgerA] = useState<WalletInfo | null>(null);
  const [ledgerB, setLedgerB] = useState<WalletInfo | null>(null);
  const [txHistory, setTxHistory] = useState<TxRecord[]>([]);

  const [loadingBalances, setLoadingBalances] = useState(false);
  const [loadingHistory, setLoadingHistory]   = useState(false);
  const [sendingFrom, setSendingFrom]         = useState<"A" | "B" | null>(null);
  const [airdropping, setAirdropping]         = useState<"A" | "B" | null>(null);
  const [awaitingHw, setAwaitingHw]           = useState<"A" | "B" | null>(null);

  // Web Serial ports per ledger
  const [portA, setPortA]           = useState<SerialPort | null>(null);
  const [portB, setPortB]           = useState<SerialPort | null>(null);
  const [connectingHw, setConnectingHw] = useState<"A" | "B" | null>(null);

  // Whether the current browser supports Web Serial
  const hasSerial = useRef(
    typeof window !== "undefined" && "serial" in navigator,
  ).current;

  const addrA = ledgerA?.address ?? "";
  const addrB = ledgerB?.address ?? "";

  /* ── Data fetching ─────────────────────────────────────────────────────── */
  const fetchBalances = useCallback(async () => {
    setLoadingBalances(true);
    try {
      const res  = await fetch("/api/balance");
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
      const res  = await fetch("/api/history");
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

  useEffect(() => { refreshAll(); }, [refreshAll]);

  /* ── Hardware connect ──────────────────────────────────────────────────── */
  const connectHardware = async (ledger: "A" | "B") => {
    setConnectingHw(ledger);
    try {
      const { port, deviceId } = await openSerialPort();

      if (ledger === "A") setPortA(port);
      else setPortB(port);

      if (deviceId !== "?" && deviceId !== ledger) {
        toast.warning(
          `Device identifies as Ledger ${deviceId} — you connected it to Ledger ${ledger}. OK for demo, but double-check which board this is.`,
        );
      } else {
        toast.success(
          `Ledger ${ledger} hardware connected${deviceId !== "?" ? ` (Device ${deviceId})` : ""}`,
        );
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotFoundError") {
        // NotFoundError = user closed the picker without selecting — silent
        toast.error(err instanceof Error ? err.message : "Failed to connect");
      }
    } finally {
      setConnectingHw(null);
    }
  };

  /* ── Airdrop ───────────────────────────────────────────────────────────── */
  const handleAirdrop = async (wallet: "A" | "B") => {
    setAirdropping(wallet);
    try {
      const res  = await fetch("/api/airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const data = (await res.json()) as ApiResponse;
      if (!res.ok || data.error) { toast.error(data.error ?? "Airdrop failed"); return; }
      toast.success(`Airdropped 1 SOL to Ledger ${wallet}`, {
        description: (
          <a href={`https://explorer.solana.com/tx/${data.signature}?cluster=testnet`}
             target="_blank" rel="noopener noreferrer" className="underline">
            View on Explorer →
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

  /* ── Transfer ──────────────────────────────────────────────────────────── */
  const handleTransfer = async (from: "A" | "B") => {
    setSendingFrom(from);
    try {
      const port = from === "A" ? portA : portB;

      // If hardware is connected, require device confirmation first
      if (port) {
        setAwaitingHw(from);
        toast.loading(`Waiting for Ledger ${from} hardware…`, { id: "hw-confirm" });

        const confirmed = await requestDeviceConfirmation(port);

        setAwaitingHw(null);
        toast.dismiss("hw-confirm");

        if (!confirmed) {
          toast.error(`Ledger ${from} hardware rejected or timed out`);
          return;
        }
      }

      const res  = await fetch("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, amount: 0.01 }),
      });
      const data = (await res.json()) as ApiResponse;

      if (!res.ok || data.error) { toast.error(data.error ?? "Transfer failed"); return; }

      toast.success(`Sent 0.01 SOL from Ledger ${from}`, {
        description: (
          <a href={`https://explorer.solana.com/tx/${data.signature}?cluster=testnet`}
             target="_blank" rel="noopener noreferrer" className="underline">
            View on Explorer →
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
            <p className="text-muted-foreground text-sm">DIY Hardware Wallet Network</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1.5">
              <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
              Solana Testnet
            </Badge>
            <Button
              variant="ghost" size="icon"
              onClick={refreshAll}
              disabled={loadingBalances || loadingHistory}
              title="Refresh"
            >
              <RefreshCw className={cn(loadingBalances || loadingHistory && "animate-spin")} />
            </Button>
          </div>
        </header>

        <Separator />

        {/* Ledger Cards */}
        <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <LedgerCard
            label="Ledger A" index="A"
            wallet={ledgerA}
            loading={loadingBalances}
            sendingNow={sendingFrom === "A"}
            airdropping={airdropping === "A"}
            awaitingHardware={awaitingHw === "A"}
            serialConnected={portA !== null}
            connectingHardware={connectingHw === "A"}
            hasSerial={hasSerial}
            onSend={() => handleTransfer("A")}
            onAirdrop={() => handleAirdrop("A")}
            onConnectHardware={() => connectHardware("A")}
          />
          <LedgerCard
            label="Ledger B" index="B"
            wallet={ledgerB}
            loading={loadingBalances}
            sendingNow={sendingFrom === "B"}
            airdropping={airdropping === "B"}
            awaitingHardware={awaitingHw === "B"}
            serialConnected={portB !== null}
            connectingHardware={connectingHw === "B"}
            hasSerial={hasSerial}
            onSend={() => handleTransfer("B")}
            onAirdrop={() => handleAirdrop("B")}
            onConnectHardware={() => connectHardware("B")}
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
            <h2 className="text-lg font-semibold">Transaction History</h2>
            {loadingHistory && (
              <CircleDashed className="text-muted-foreground size-4 animate-spin" />
            )}
          </div>

          {txHistory.length === 0 && !loadingHistory ? (
            <Card>
              <CardContent className="text-muted-foreground py-10 text-center text-sm">
                No transactions yet. Airdrop some SOL and send a transfer.
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
                        {tx.status === "success"
                          ? <CheckCircle2 className="size-4 text-emerald-400" />
                          : <XCircle className="size-4 text-destructive" />}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs tabular-nums">
                        {formatTime(tx.blockTime)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <AddressLabel addr={tx.from} addrA={addrA} addrB={addrB} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <AddressLabel addr={tx.to} addrA={addrA} addrB={addrB} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {tx.amount > 0 ? (
                          <span className="text-sm font-medium">
                            {tx.amount.toFixed(4)}
                            <span className="text-muted-foreground ml-1 text-xs">SOL</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                        {tx.fee.toFixed(6)}
                      </TableCell>
                      <TableCell>
                        <a
                          href={`https://explorer.solana.com/tx/${tx.signature}?cluster=testnet`}
                          target="_blank" rel="noopener noreferrer"
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

/* ─── LedgerCard ─────────────────────────────────────────────────────────── */
function LedgerCard({
  label, index, wallet, loading,
  sendingNow, airdropping, awaitingHardware,
  serialConnected, connectingHardware, hasSerial,
  onSend, onAirdrop, onConnectHardware,
}: {
  label: string;
  index: "A" | "B";
  wallet: WalletInfo | null;
  loading: boolean;
  sendingNow: boolean;
  airdropping: boolean;
  awaitingHardware: boolean;
  serialConnected: boolean;
  connectingHardware: boolean;
  hasSerial: boolean;
  onSend: () => void;
  onAirdrop: () => void;
  onConnectHardware: () => void;
}) {
  const short = wallet ? shortAddr(wallet.address) : "—";
  const busy  = sendingNow || airdropping || awaitingHardware || loading || connectingHardware;

  let sendLabel = "Send 0.01 SOL";
  if (awaitingHardware) sendLabel = "Waiting for hardware…";
  else if (sendingNow)  sendLabel = "Sending…";

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Cpu className="text-primary size-4" />
            {label}
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Hardware connection indicator */}
            <span
              className={cn(
                "size-2 rounded-full transition-colors",
                serialConnected ? "bg-emerald-400" : "bg-muted-foreground/30",
              )}
              title={serialConnected ? "Arduino connected" : "No hardware"}
            />
            <Badge variant="secondary">Arduino #{index}</Badge>
          </div>
        </div>
        <CardDescription className="font-mono text-xs">
          {loading ? "Loading…" : short}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1">
        <p className="text-5xl font-bold tabular-nums">
          {loading || wallet === null
            ? <span className="text-muted-foreground text-3xl">—</span>
            : wallet.balance.toFixed(4)}
        </p>
        <p className="text-muted-foreground mt-1 text-sm">SOL</p>
      </CardContent>

      <CardFooter className="flex flex-col gap-2">
        <Button className="w-full" onClick={onSend} disabled={busy}>
          <ArrowRightLeft data-icon="inline-start" />
          {sendLabel}
        </Button>

        <Button variant="outline" className="w-full" onClick={onAirdrop} disabled={busy}>
          <Droplets data-icon="inline-start" />
          {airdropping ? "Requesting…" : "Airdrop 1 SOL"}
        </Button>

        {hasSerial && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "w-full gap-2 text-xs",
              serialConnected && "text-emerald-400 hover:text-emerald-300",
            )}
            onClick={onConnectHardware}
            disabled={busy || connectingHardware}
          >
            <Usb className="size-3" />
            {connectingHardware
              ? "Connecting…"
              : serialConnected
              ? "Hardware connected ✓"
              : "Connect Arduino"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/* ─── AddressLabel ───────────────────────────────────────────────────────── */
function AddressLabel({ addr, addrA, addrB }: { addr: string; addrA: string; addrB: string }) {
  if (!addr) return <span className="text-muted-foreground">—</span>;
  if (addr === addrA) return <span className="text-primary font-semibold">Ledger A</span>;
  if (addr === addrB) return <span className="font-semibold text-violet-400">Ledger B</span>;
  return <span>{shortAddr(addr)}</span>;
}
