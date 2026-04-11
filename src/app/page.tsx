"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Download,
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
import { Textarea } from "@/components/ui/textarea";
import { BIP39_ENGLISH, phraseToIndices } from "@/lib/bip39Words";

const HARDWARE_MODE =
  process.env.NEXT_PUBLIC_HARDWARE_MODE === "true";

const PIN_LENGTH = 6;
/** Must match firmware SIGN_TIMEOUT_MS (ledger.ino) */
const SIGN_SESSION_MS = 30_000;

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
  /** 1–5 = device-reported seconds left for hold-to-cancel; null = idle */
  signCancelHold: number | null;
  /** Client-side deadline for PIN signing window (synced on STATE:SIGNING) */
  signExpiresAt: number | null;
}

const INITIAL_HW: HwState = {
  connected: false,
  mode: "UNKNOWN",
  deviceId: "?",
  pinSet: false,
  pinFails: 0,
  pinProgress: 0,
  signCancelHold: null,
  signExpiresAt: null,
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

/**
 * Parses buffered serial lines from the firmware (between SEED_BEGIN and SEED_END).
 * Must not use waitFor() for SEED_IDX lines — they can arrive in the same USB chunk
 * before any microtask runs, so those lines would be dropped.
 */
function parseSeedLinesToWords(buffer: string[]): string[] {
  const start = buffer.indexOf("SEED_BEGIN");
  const end = buffer.indexOf("SEED_END");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Device did not send SEED_BEGIN … SEED_END");
  }
  const idxLines = buffer
    .slice(start + 1, end)
    .filter((l) => l.startsWith("SEED_IDX:"));
  if (idxLines.length !== 12) {
    throw new Error(
      `Expected 12 SEED_IDX lines, got ${idxLines.length} — check firmware`,
    );
  }
  return idxLines.map((line) => {
    const n = Number.parseInt(line.slice(9), 10);
    if (Number.isNaN(n) || n < 0 || n > 2047) {
      throw new Error("Invalid SEED_IDX from device");
    }
    const w = BIP39_ENGLISH[n];
    if (w === undefined) throw new Error("Invalid SEED_IDX from device");
    return w;
  });
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
      const signing = mode === "SIGNING";
      setState((p) => ({
        ...p,
        mode,
        deviceId,
        pinSet,
        pinFails,
        pinProgress: signing ? p.pinProgress : 0,
        signCancelHold: null,
        signExpiresAt: signing ? Date.now() + SIGN_SESSION_MS : null,
      }));
    } else if (parts.length === 1) {
      const m = parts[0] ?? "UNKNOWN";
      const signing = m === "SIGNING";
      setState((p) => ({
        ...p,
        mode: m,
        pinProgress: 0,
        signCancelHold: null,
        signExpiresAt: signing ? Date.now() + SIGN_SESSION_MS : null,
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
      signCancelHold: null,
      signExpiresAt: null,
    }));
  } else if (line === "PIN_MISMATCH") {
    setState((p) => ({ ...p, pinProgress: 0 }));
  } else if (line === "REJECTED") {
    setState((p) => ({
      ...p,
      pinProgress: 0,
      signCancelHold: null,
      signExpiresAt: null,
    }));
  } else if (line.startsWith("SIGN_CANCEL:")) {
    // "SIGN_CANCEL:" is 12 chars; digit(s) start at index 12 (slice(11) was ":5" → NaN)
    const n = Number.parseInt(line.slice(12).trim(), 10);
    if (n >= 1 && n <= 5) {
      setState((p) => ({ ...p, signCancelHold: n }));
    }
  } else if (line === "SIGN_CANCEL_ABORT") {
    setState((p) => ({ ...p, signCancelHold: null }));
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

/** Counts down the ~30s firmware signing window (starts when STATE:SIGNING is seen). */
function SigningDeadline({ endsAt }: { endsAt: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (endsAt == null) return;
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [endsAt]);
  if (endsAt == null) return null;
  const sec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  if (sec <= 0) return null;
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      Signing window ~{sec}s left
    </p>
  );
}

/** Synced to device SIGN_CANCEL:1–5 lines (hold-to-cancel). */
function CancelHoldProgress({ sec }: { sec: number | null }) {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-[11px] leading-snug">
        {sec == null
          ? "Hold both buttons ~5s to cancel on the device."
          : "Cancelling on device — release to stop."}
      </p>
      <div className="flex gap-1">
        {Array.from({ length: 5 }).map((_, i) => {
          const filled = sec != null && 6 - sec > i;
          return (
            <span
              key={i}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-all duration-200",
                filled ? "bg-amber-500/90" : "bg-muted-foreground/20",
              )}
            />
          );
        })}
      </div>
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

  const [seedBackupModal, setSeedBackupModal] = useState<{
    ledger: "A" | "B";
    words: string[];
  } | null>(null);
  const [seedDownloaded, setSeedDownloaded] = useState(false);
  const [sendingAck, setSendingAck] = useState(false);
  const [recoverModal, setRecoverModal] = useState<{
    ledger: "A" | "B";
  } | null>(null);
  const [recoverPhraseInput, setRecoverPhraseInput] = useState("");
  const [verifyingPhrase, setVerifyingPhrase] = useState(false);

  const deviceARef = useRef<DeviceConnection | null>(null);
  const deviceBRef = useRef<DeviceConnection | null>(null);

  /** Must not read `navigator` during SSR — it differs on client (Web Serial) and causes hydration mismatches. */
  const [hasSerial, setHasSerial] = useState(false);
  useEffect(() => {
    setHasSerial(
      typeof navigator !== "undefined" && "serial" in navigator,
    );
  }, []);

  const addrA = ledgerA?.address ?? "";
  const addrB = ledgerB?.address ?? "";

  useEffect(() => {
    return () => {
      deviceARef.current?.close();
      deviceBRef.current?.close();
    };
  }, []);

  // Auto-open recovery modal the moment a device is wiped
  useEffect(() => {
    if (hwStateA.connected && hwStateA.mode === "WIPED") {
      setRecoverPhraseInput("");
      setRecoverModal((prev) => prev ?? { ledger: "A" });
    }
  }, [hwStateA.mode, hwStateA.connected]);

  useEffect(() => {
    if (hwStateB.connected && hwStateB.mode === "WIPED") {
      setRecoverPhraseInput("");
      setRecoverModal((prev) => prev ?? { ledger: "B" });
    }
  }, [hwStateB.mode, hwStateB.connected]);

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
        signCancelHold: null,
        signExpiresAt: null,
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

    const prevOnLine = device.onLine;
    const buf: string[] = [];
    let finished = false;
    let resolveDone!: () => void;
    let rejectDone!: (e: Error) => void;
    const doneP = new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        device.onLine = prevOnLine;
        rejectDone(new Error("Timed out waiting for SEED_END from device"));
      }
    }, 25_000);

    device.onLine = (line: string) => {
      prevOnLine?.(line);
      buf.push(line);
      if (line === "SEED_END" && !finished) {
        finished = true;
        clearTimeout(timeout);
        device.onLine = prevOnLine;
        resolveDone();
      }
    };

    try {
      await device.send(`SETID ${ledger}`);
      await doneP;
      const words = parseSeedLinesToWords(buf);
      setSeedDownloaded(false);
      setSeedBackupModal({ ledger, words });
    } catch (e) {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        device.onLine = prevOnLine;
      }
      toast.error(
        e instanceof Error
          ? e.message
          : "Registration or seed transfer failed — check USB & firmware",
      );
    }
  };

  /* ── Confirm seed backup → send SEED_ACK to device ─────────────────────── */
  const confirmSeedBackup = async () => {
    if (!seedBackupModal) return;
    const { ledger } = seedBackupModal;
    const device = ledger === "A" ? deviceARef.current : deviceBRef.current;
    setSendingAck(true);
    try {
      if (device) {
        await device.send("SEED_ACK");
        // Device will emit SEED_ACKED then transition to STATE:SET_PIN — handled by onLine
      }
      setSeedBackupModal(null);
      toast.success(
        `Ledger ${ledger} seed saved — now set your PIN on the device`,
      );
    } catch {
      toast.error("Failed to send acknowledgement to device");
    } finally {
      setSendingAck(false);
    }
  };

  /* ── Recover ───────────────────────────────────────────────────────────── */
  const recoverDevice = (ledger: "A" | "B") => {
    setRecoverPhraseInput("");
    setRecoverModal({ ledger });
  };

  const confirmRecover = async () => {
    if (!recoverModal) return;
    const { ledger } = recoverModal;
    const device =
      ledger === "A" ? deviceARef.current : deviceBRef.current;
    if (!device) {
      toast.error(`Ledger ${ledger} is not connected`);
      return;
    }
    const indices = phraseToIndices(recoverPhraseInput);
    if (!indices) {
      toast.error(
        "Enter exactly 12 valid English BIP-39 words from the word list",
      );
      return;
    }
    setVerifyingPhrase(true);
    try {
      await device.send("SEED_VERIFY");
      await device.waitFor((l) => l === "SVI_READY", 8000);
      for (let i = 0; i < 12; i++) {
        const idx = indices[i];
        if (idx === undefined) throw new Error("missing index");
        await device.send(`SVI ${idx}`);
        const line = await device.waitFor(
          (l) =>
            l === "SVI_NEXT" || l === "SEED_OK" || l === "SEED_BAD",
          8000,
        );
        if (line === "SEED_BAD") {
          toast.error("Incorrect seed phrase — try again");
          return;
        }
        if (i < 11 && line !== "SVI_NEXT") {
          toast.error("Unexpected response from device");
          return;
        }
        if (i === 11 && line !== "SEED_OK") {
          toast.error("Unexpected response from device");
          return;
        }
      }
      await device.send("RECOVER");
      await device
        .waitFor((l) => l === "RECOVERED", 5000)
        .catch(() => null);
      setRecoverModal(null);
      setRecoverPhraseInput("");
      toast.success(
        `Ledger ${ledger} recovered — go through setup again`,
      );
    } catch {
      toast.error("Recovery failed — check device is in WIPED mode");
    } finally {
      setVerifyingPhrase(false);
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
        if (result === "REJECTED") {
          toast.error("Transaction cancelled on device");
          return;
        }
        if (result === "timeout") {
          toast.error("Transaction timed out waiting for PIN");
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

      {/* ── Seed Phrase Backup Modal ─────────────────────────────────── */}
      {seedBackupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="bg-background/80 fixed inset-0 backdrop-blur-sm" />
          <div className="bg-popover relative z-10 flex w-full max-w-lg flex-col gap-4 rounded-xl p-6 shadow-lg ring-1 ring-foreground/10">
            <div className="flex flex-col gap-1">
              <h2 className="font-heading text-base font-medium leading-none">
                Backup Your Seed Phrase
              </h2>
              <p className="text-muted-foreground text-sm">
                These words were generated on your Arduino and the indices are
                stored in device memory. This page maps them to the standard
                BIP-39 English list. Write them down in order — you need them
                after a PIN wipe. Never share them with anyone.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {seedBackupModal.words.map((word, i) => (
                <div
                  key={i}
                  className="bg-muted flex items-center gap-2 rounded-md px-3 py-2"
                >
                  <span className="text-muted-foreground w-5 text-right font-mono text-xs">
                    {i + 1}.
                  </span>
                  <span className="font-mono text-sm font-medium">
                    {word}
                  </span>
                </div>
              ))}
            </div>

            <div className="bg-amber-500/10 flex items-start gap-2 rounded-lg p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <p className="text-xs text-amber-500">
                This is the only time your seed phrase will be shown. Store it
                securely — you cannot view it again.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  const content = seedBackupModal.words
                    .map((w, i) => `${i + 1}. ${w}`)
                    .join("\n");
                  const blob = new Blob([content], { type: "text/plain" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `ledger-${seedBackupModal.ledger}-seed.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                  setSeedDownloaded(true);
                }}
              >
                <Download className="mr-2 size-4" />
                Download as .txt
              </Button>
              <Button
                className="w-full"
                disabled={!seedDownloaded || sendingAck}
                onClick={confirmSeedBackup}
              >
                {sendingAck
                  ? "Confirming…"
                  : seedDownloaded
                    ? "I've Saved It — Continue"
                    : "Download first to continue"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Seed Phrase Recovery Modal ────────────────────────────────── */}
      {recoverModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Non-interactive backdrop — clicking it does nothing */}
          <div className="bg-background/80 fixed inset-0 backdrop-blur-sm" />
          <div className="bg-popover relative z-10 flex w-full max-w-lg flex-col gap-4 rounded-xl p-6 shadow-lg ring-1 ring-foreground/10">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <ShieldAlert className="text-destructive size-4 shrink-0" />
                <h2 className="font-heading text-base font-medium leading-none">
                  Recovery Mode — Device Wiped
                </h2>
              </div>
              <p className="text-muted-foreground text-sm">
                Ledger {recoverModal.ledger} was wiped after 3 wrong PIN
                attempts. Enter all 12 seed words in order to unlock the
                device. This modal cannot be dismissed.
              </p>
            </div>

            <Textarea
              placeholder="word1 word2 word3 …"
              rows={4}
              value={recoverPhraseInput}
              onChange={(e) => setRecoverPhraseInput(e.target.value)}
              className="font-mono text-sm"
            />

            <Button
              className="w-full"
              disabled={
                verifyingPhrase ||
                recoverPhraseInput.trim().split(/\s+/).length !== 12
              }
              onClick={confirmRecover}
            >
              {verifyingPhrase ? "Verifying…" : "Verify & Recover"}
            </Button>
          </div>
        </div>
      )}
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
    hwState.mode === "SEED_BACKUP" ||
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

        {showSetupFlow && hwState.mode === "SEED_BACKUP" && (
          <div className="bg-muted/50 space-y-3 rounded-lg p-4">
            <p className="text-sm font-medium">Seed Phrase Backup</p>
            <p className="text-muted-foreground text-xs">
              The device is waiting for you to save your seed phrase. If the
              panel didn&apos;t open, click below to re-send.
            </p>
            <Button
              size="sm"
              className="w-full"
              onClick={onRegister}
              disabled={busy}
            >
              Re-send Seed Phrase
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
              Enter your PIN with the two buttons (same dots as setup). Hold
              both at once on the device to cancel — progress syncs below.
            </p>
            <PinDots filled={hwState.pinProgress} />
            <SigningDeadline endsAt={hwState.signExpiresAt} />
            <CancelHoldProgress sec={hwState.signCancelHold} />
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
