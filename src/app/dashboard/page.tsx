"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRightLeft,
  BarChart2,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  LogOut,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Usb,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { BIP39_ENGLISH, phraseToIndices } from "@/lib/bip39Words";
import {
  canonicalLedgerDeviceId,
  parseMetaSaltHex,
} from "@/lib/ledgerDeviceId";
import { CopyableAddress, TxAddressCell } from "@/components/copyable-address";
import { OrbitLoader } from "@/components/cosmic/orbit-loader";
import { TxShootingStar } from "@/components/cosmic/tx-shooting-star";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { sendClientLedgerLog } from "@/lib/logging/clientLog";

const HARDWARE_MODE = process.env.NEXT_PUBLIC_HARDWARE_MODE === "true";

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
  /** True when more txs exist on-chain than this list (API caps merged results). */
  hasMore?: boolean;
}
interface ApiResponse {
  signature?: string;
  error?: string;
}

interface HwState {
  connected: boolean;
  mode: string;
  deviceId: string;
  /** Mongo log chain id — canonical, no UI slot prefix (see `canonicalLedgerDeviceId`). */
  logDeviceId: string;
  pinSet: boolean;
  pinFails: number;
  /** From STATE line when firmware sends 6+ fields (else false after legacy 4-field STATE). */
  seedSet: boolean;
  seedHostAck: boolean;
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
  logDeviceId: "",
  pinSet: false,
  pinFails: 0,
  seedSet: false,
  seedHostAck: false,
  pinProgress: 0,
  signCancelHold: null,
  signExpiresAt: null,
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */
/** Renders chain time in the viewer's local timezone (avoids UTC from SSR). */
function LocalTxTime({ blockTime }: { blockTime: number | null }) {
  const label = useMemo(() => {
    if (blockTime == null) return "—";
    const d = new Date(blockTime * 1000);
    return d.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  }, [blockTime]);

  return <span suppressHydrationWarning>{label}</span>;
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
  onDisconnect: (() => void) | null = null;

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
      this.onDisconnect?.();
    }
  }

  async send(cmd: string) {
    this.writer ??= this.port.writable!.getWriter();
    const enc = new TextEncoder();
    await this.writer.write(enc.encode(cmd + "\n"));
  }

  waitFor(test: (line: string) => boolean, timeoutMs: number): Promise<string> {
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
    } catch {
      /* */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* */
    }
    try {
      await this.port.close();
    } catch {
      /* */
    }
    this.reader = null;
    this.writer = null;
  }
}

/**
 * Parses buffered serial lines from the firmware (between SEED_BEGIN and SEED_END).
 * Must not use waitFor() for SEED_IDX lines — they can arrive in the same USB chunk
 * before any microtask runs, so those lines would be dropped.
 */
/** Parses STATE:mode,id,pin_set,fails[,seed_set,seed_host_ack] from firmware. */
function parseFullStateLine(line: string): {
  mode: string;
  deviceId: string;
  pinSet: boolean;
  pinFails: number;
  seedSet: boolean;
  seedHostAck: boolean;
} | null {
  if (!line.startsWith("STATE:")) return null;
  const parts = line.slice(6).split(",");
  if (parts.length < 4) return null;
  const mode = parts[0] ?? "UNKNOWN";
  const deviceId = parts[1] ?? "?";
  const pinSet = (parts[2] ?? "0") === "1";
  const pinFails = parseInt(parts[3] ?? "0", 10) || 0;
  const seedSet = parts.length >= 6 ? (parts[4] ?? "0") === "1" : false;
  const seedHostAck = parts.length >= 6 ? (parts[5] ?? "0") === "1" : false;
  return { mode, deviceId, pinSet, pinFails, seedSet, seedHostAck };
}

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
  ledger: "A" | "B",
  getHwState: () => HwState,
  getLedgerLogId: () => string | null,
) {
  const logId = () => {
    const refId = getLedgerLogId();
    if (refId) return refId;
    const hw = getHwState();
    return hw.logDeviceId || canonicalLedgerDeviceId(hw.deviceId, null);
  };
  if (line.startsWith("STATE:")) {
    const parts = line.slice(6).split(",");
    const full = parseFullStateLine(line);
    if (full) {
      const { mode, deviceId, pinSet, pinFails, seedSet, seedHostAck } = full;
      const signing = mode === "SIGNING";
      setState((p) => ({
        ...p,
        mode,
        deviceId,
        pinSet,
        pinFails,
        seedSet,
        seedHostAck,
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
    const hw = getHwState();
    if (hw.mode === "SIGNING") {
      void sendClientLedgerLog(
        {
          deviceId: logId(),
          action: "AUTH_FAIL",
          status: "FAIL",
          metadata: { reason: "wrong_pin", attemptsLeft: left },
        },
        { usbConnected: true },
      );
    }
    setState((p) => ({
      ...p,
      pinFails: 3 - left,
      pinProgress: 0,
    }));
  } else if (line === "WIPED") {
    void sendClientLedgerLog(
      {
        deviceId: logId(),
        action: "SIGN_TX",
        status: "FAIL",
        metadata: { reason: "device_wiped" },
      },
      { usbConnected: true },
    );
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
              ? "scale-110 border-primary bg-primary/90 shadow-[0_0_12px_oklch(0.62_0.14_300/55%)]"
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
    <p className="text-primary/95 text-xs tabular-nums">
      Signing window ~{sec}s left
    </p>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Page                                                                      */
/* ═══════════════════════════════════════════════════════════════════════════ */
export default function HomePage() {
  const [ledgerA, setLedgerA] = useState<WalletInfo | null>(null);
  const [ledgerB, setLedgerB] = useState<WalletInfo | null>(null);
  const [txHistory, setTxHistory] = useState<TxRecord[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);

  const [loadingBalances, setLoadingBalances] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sendingFrom, setSendingFrom] = useState<"A" | "B" | null>(null);
  const [awaitingHw, setAwaitingHw] = useState<"A" | "B" | null>(null);
  const [connectingHw, setConnectingHw] = useState<"A" | "B" | null>(null);
  /** Visual-only: increments after a confirmed on-chain transfer (shooting star). */
  const [txLaunchSeq, setTxLaunchSeq] = useState(0);

  const [hwStateA, setHwStateA] = useState<HwState>(INITIAL_HW);
  const [hwStateB, setHwStateB] = useState<HwState>(INITIAL_HW);

  const [seedBackupModal, setSeedBackupModal] = useState<{
    ledger: "A" | "B";
    words: string[];
  } | null>(null);
  const [seedDownloaded, setSeedDownloaded] = useState(false);
  const [recoverModal, setRecoverModal] = useState<{
    ledger: "A" | "B";
  } | null>(null);
  const [recoverPhraseInput, setRecoverPhraseInput] = useState("");
  const [verifyingPhrase, setVerifyingPhrase] = useState(false);
  const [blacklistedDevice, setBlacklistedDevice] = useState<{
    ledger: "A" | "B";
    reason: string;
  } | null>(null);
  const [sendAmountA, setSendAmountA] = useState("0.01");
  const [sendAmountB, setSendAmountB] = useState("0.01");

  const deviceARef = useRef<DeviceConnection | null>(null);
  const deviceBRef = useRef<DeviceConnection | null>(null);
  /** Canonical Mongo log id; set before `onLine` so early serial events use the right key. */
  const ledgerLogIdARef = useRef<string | null>(null);
  const ledgerLogIdBRef = useRef<string | null>(null);

  /** Must not read `navigator` during SSR — it differs on client (Web Serial) and causes hydration mismatches. */
  const [hasSerial, setHasSerial] = useState(false);
  useEffect(() => {
    setHasSerial(typeof navigator !== "undefined" && "serial" in navigator);
  }, []);

  const addrA = ledgerA?.address ?? "";
  const addrB = ledgerB?.address ?? "";

  /* eslint-disable react-hooks/exhaustive-deps -- unmount closes live serial refs, not a render snapshot */
  useEffect(() => {
    return () => {
      void deviceARef.current?.close();
      void deviceBRef.current?.close();
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

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
      setHistoryHasMore(Boolean(data.hasMore));
    } catch {
      toast.error("Failed to fetch history");
      setHistoryHasMore(false);
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
    setBlacklistedDevice(null);
    const setState = ledger === "A" ? setHwStateA : setHwStateB;
    const deviceRef = ledger === "A" ? deviceARef : deviceBRef;
    /** True after `port.open` — required for MongoDB ledger log eligibility. */
    let usbSession = false;

    try {
      if (!navigator.serial)
        throw new Error("Web Serial not supported in this browser");

      // Close existing connection if any
      if (deviceRef.current) {
        const prev = ledger === "A" ? hwStateA : hwStateB;
        if (prev.connected) {
          void sendClientLedgerLog(
            {
              deviceId:
                prev.logDeviceId ||
                canonicalLedgerDeviceId(prev.deviceId, null),
              action: "DISCONNECT",
              status: "SUCCESS",
              metadata: { reason: "reconnect_replace" },
            },
            { usbConnected: true },
          );
        }
        await deviceRef.current.close();
        deviceRef.current = null;
        if (ledger === "A") ledgerLogIdARef.current = null;
        else ledgerLogIdBRef.current = null;
        setState(INITIAL_HW);
      }

      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      usbSession = true;

      const device = new DeviceConnection(port);
      const logRef = ledger === "A" ? ledgerLogIdARef : ledgerLogIdBRef;
      const getHw = () => (ledger === "A" ? hwStateA : hwStateB);
      // Defer `onLine` until canonical id exists so logs never use UI-slot–based keys.
      await device.start();

      const deviceLine = await device
        .waitFor((l) => l.startsWith("DEVICE:"), 5000)
        .catch(() => null);
      const detectedId = deviceLine ? deviceLine.slice(7) : "?";

      await device.waitFor((l) => l === "READY", 5000).catch(() => null);

      await device.send("STATE");
      const stateLine = await device
        .waitFor((l) => l.startsWith("STATE:") && l.includes(","), 3000)
        .catch(() => null);

      const parsedState = stateLine ? parseFullStateLine(stateLine) : null;
      const mode = parsedState?.mode ?? "UNKNOWN";
      const pinSet = parsedState?.pinSet ?? false;
      const pinFails = parsedState?.pinFails ?? 0;
      const seedSet = parsedState?.seedSet ?? false;
      const seedHostAck = parsedState?.seedHostAck ?? false;
      const stateDeviceId = parsedState?.deviceId ?? detectedId;

      await device.send("META");
      const metaLine = await device
        .waitFor((l) => l.startsWith("META:"), 3000)
        .catch(() => null);
      const metaSalt = metaLine ? parseMetaSaltHex(metaLine) : null;

      const canonicalId = canonicalLedgerDeviceId(stateDeviceId, metaSalt);
      const idForWrongSlotLog = canonicalLedgerDeviceId(detectedId, metaSalt);

      // Enforce A/B match in hardware mode — skip for INIT/WIPED where ID may not yet be set
      if (
        HARDWARE_MODE &&
        detectedId !== "?" &&
        detectedId !== ledger &&
        mode !== "INIT" &&
        mode !== "WIPED"
      ) {
        void sendClientLedgerLog(
          {
            deviceId: idForWrongSlotLog,
            action: "CONNECT",
            status: "FAIL",
            metadata: {
              reason: "wrong_ledger",
              expectedSlot: ledger,
              reportedId: detectedId,
            },
          },
          { usbConnected: true },
        );
        await device.close();
        toast.error(
          `This device is the wrong ledger. Connect the correct one.`,
        );
        return;
      }

      const blCheck = await fetch(
        `/api/security/blacklist/check?deviceId=${encodeURIComponent(canonicalId)}`,
      );
      const blData = (await blCheck.json()) as {
        blacklisted: boolean;
        reason?: string;
      };
      if (blData.blacklisted) {
        await device.close();
        setBlacklistedDevice({
          ledger,
          reason: blData.reason ?? "Blocked by security policy",
        });
        return;
      }

      setBlacklistedDevice(null);

      deviceRef.current = device;
      logRef.current = canonicalId;

      device.onLine = (line) =>
        processSerialLine(line, setState, ledger, getHw, () => logRef.current);

      device.onDisconnect = () => {
        const hwSnap = ledger === "A" ? hwStateA : hwStateB;
        const duringSigning =
          hwSnap.signExpiresAt != null && hwSnap.signExpiresAt > Date.now();
        const disconnectId = logRef.current;
        logRef.current = null;
        void sendClientLedgerLog(
          {
            deviceId: disconnectId ?? "ledger-unknown",
            action: "DISCONNECT",
            status: "FAIL",
            metadata: { reason: "port_closed", during_signing: duringSigning },
          },
          { usbConnected: false },
        );
        setState(INITIAL_HW);
      };

      setState({
        connected: true,
        mode,
        deviceId: stateDeviceId,
        logDeviceId: canonicalId,
        pinSet,
        pinFails,
        seedSet,
        seedHostAck,
        pinProgress: 0,
        signCancelHold: null,
        signExpiresAt: null,
      });

      void sendClientLedgerLog(
        {
          deviceId: canonicalId,
          action: "CONNECT",
          status: "SUCCESS",
          metadata: { mode, baudRate: 115200 },
        },
        { usbConnected: true },
      );

      toast.success(`Ledger ${ledger} connected — ${mode}`);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotFoundError") {
        void sendClientLedgerLog(
          {
            deviceId: `ledger-${ledger}-unknown`,
            action: "CONNECT",
            status: "FAIL",
            metadata: {
              error: err instanceof Error ? err.message : "Failed to connect",
            },
          },
          { usbConnected: usbSession },
        );
        toast.error(err instanceof Error ? err.message : "Failed to connect");
      }
    } finally {
      setConnectingHw(null);
    }
  };

  /* ── Register (SETID) ─────────────────────────────────────────────────── */
  const registerDevice = async (ledger: "A" | "B") => {
    const device = ledger === "A" ? deviceARef.current : deviceBRef.current;
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

  /* After power loss mid–PIN: device boots INIT; host sends MODE 1 to enter SET_PIN. */
  const resumePinSetup = async (ledger: "A" | "B") => {
    const device = ledger === "A" ? deviceARef.current : deviceBRef.current;
    if (!device) {
      toast.error(`Connect Ledger ${ledger} first`);
      return;
    }
    try {
      await device.send("MODE 1");
      toast.success(`Ledger ${ledger} — finish your PIN on the device`, {
        description: "Use the two buttons for six digits.",
      });
    } catch {
      toast.error("Could not resume PIN setup");
    }
  };

  /* ── Confirm seed backup → send SEED_ACK so device enters PIN setup ──── */
  const confirmSeedBackup = async () => {
    if (!seedBackupModal) return;
    if (!seedDownloaded) {
      toast.error("Download the seed phrase as .txt before continuing");
      return;
    }
    const { ledger } = seedBackupModal;
    const device = ledger === "A" ? deviceARef.current : deviceBRef.current;
    try {
      if (device) {
        await device.send("SEED_ACK");
      }
    } catch {
      /* device may have disconnected — PIN setup still works on reconnect */
    }
    setSeedBackupModal(null);
    toast.success(
      `Ledger ${ledger} seed saved — now set your PIN on the device`,
    );
  };

  /* ── Recover ───────────────────────────────────────────────────────────── */
  const recoverDevice = (ledger: "A" | "B") => {
    setRecoverPhraseInput("");
    setRecoverModal({ ledger });
  };

  const confirmRecover = async () => {
    if (!recoverModal) return;
    const { ledger } = recoverModal;
    const device = ledger === "A" ? deviceARef.current : deviceBRef.current;
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
          (l) => l === "SVI_NEXT" || l === "SEED_OK" || l === "SEED_BAD",
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
      const prevOnLine = device.onLine;
      const buf: string[] = [];
      let recoverDone = false;
      let resolveRecover!: () => void;
      let rejectRecover!: (e: Error) => void;
      const recoverP = new Promise<void>((res, rej) => {
        resolveRecover = res;
        rejectRecover = rej;
      });
      const recoverTimeout = setTimeout(() => {
        if (!recoverDone) {
          recoverDone = true;
          device.onLine = prevOnLine;
          rejectRecover(new Error("Timed out waiting for RECOVERED"));
        }
      }, 15_000);

      device.onLine = (line: string) => {
        prevOnLine?.(line);
        buf.push(line);
        if (line === "RECOVERED" && !recoverDone) {
          recoverDone = true;
          clearTimeout(recoverTimeout);
          device.onLine = prevOnLine;
          resolveRecover();
        }
      };

      await device.send("RECOVER");
      await recoverP;

      const words = parseSeedLinesToWords(buf);
      const hw = ledger === "A" ? hwStateA : hwStateB;
      const logDev =
        hw.logDeviceId || canonicalLedgerDeviceId(hw.deviceId, null);
      void sendClientLedgerLog(
        {
          deviceId: logDev,
          action: "CONNECT",
          status: "SUCCESS",
          metadata: { recovered: true },
        },
        { usbConnected: true },
      );
      setRecoverModal(null);
      setRecoverPhraseInput("");
      setSeedDownloaded(false);
      setSeedBackupModal({ ledger, words });
      toast.success(`Ledger ${ledger} recovered — save your new seed phrase`);
    } catch {
      toast.error("Recovery failed — check device is in WIPED mode");
    } finally {
      setVerifyingPhrase(false);
    }
  };

  /* ── Transfer (with hardware PIN flow) ──────────────────────────────────── */
  const handleTransfer = async (from: "A" | "B", amount: number) => {
    setSendingFrom(from);
    try {
      if (HARDWARE_MODE) {
        const device = from === "A" ? deviceARef.current : deviceBRef.current;
        const hw = from === "A" ? hwStateA : hwStateB;
        const logDev =
          hw.logDeviceId || canonicalLedgerDeviceId(hw.deviceId, null);

        if (!device || !hw.connected) {
          toast.error(`Connect Ledger ${from} first`);
          return;
        }
        if (hw.mode !== "READY") {
          toast.error(`Ledger ${from} is not ready. Complete setup first.`);
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
          void sendClientLedgerLog(
            {
              deviceId: logDev,
              action: "SIGN_TX",
              status: "FAIL",
              metadata: { reason: "device_wiped" },
            },
            { usbConnected: true },
          );
          toast.error(
            `Ledger ${from} was wiped after 3 wrong PINs! Use Recover to re-setup.`,
          );
          return;
        }
        if (result === "REJECTED") {
          void sendClientLedgerLog(
            {
              deviceId: logDev,
              action: "SIGN_TX",
              status: "CANCELLED",
              metadata: { reason: "cancelled_on_device" },
            },
            { usbConnected: true },
          );
          toast.error("Transaction cancelled on device");
          return;
        }
        if (result === "timeout") {
          void sendClientLedgerLog(
            {
              deviceId: logDev,
              action: "SIGN_TX",
              status: "FAIL",
              metadata: { reason: "pin_timeout" },
            },
            { usbConnected: true },
          );
          toast.error("Transaction timed out waiting for PIN");
          return;
        }
        if (result.startsWith("ERR:")) {
          void sendClientLedgerLog(
            {
              deviceId: logDev,
              action: "SIGN_TX",
              status: "FAIL",
              metadata: { reason: "device_error", detail: result },
            },
            { usbConnected: true },
          );
          toast.error(result);
          return;
        }
        if (result !== "CONFIRMED") {
          void sendClientLedgerLog(
            {
              deviceId: logDev,
              action: "SIGN_TX",
              status: "FAIL",
              metadata: { reason: "unexpected", detail: result },
            },
            { usbConnected: true },
          );
          toast.error(`Unexpected: ${result}`);
          return;
        }

        void sendClientLedgerLog(
          {
            deviceId: logDev,
            action: "SIGN_TX",
            status: "SUCCESS",
            metadata: { amount, asset: "SOL", cluster: "testnet" },
          },
          { usbConnected: true },
        );
      }

      const res = await fetch("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, amount }),
      });
      const data = (await res.json()) as ApiResponse;

      if (!res.ok || data.error) {
        toast.error(data.error ?? "Transfer failed");
        return;
      }

      toast.success(`Sent ${amount} SOL from Ledger ${from}`, {
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
      setTxLaunchSeq((n) => n + 1);

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
    <>
      <TxShootingStar launchKey={txLaunchSeq} />
      <main className="text-foreground relative bg-transparent px-4 py-4 md:px-8 md:py-5">
        <div className="mx-auto max-w-4xl space-y-4 md:space-y-5">
          <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
                Wallet
              </h1>
              <p className="text-muted-foreground text-xs md:text-sm">
                Hardware wallets · Solana testnet
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refreshAll}
                      disabled={loadingBalances || loadingHistory}
                    />
                  }
                >
                  {loadingBalances || loadingHistory ? (
                    <OrbitLoader className="size-4" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  <span className="ml-2">Refresh</span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Refresh balances and on-chain history
                </TooltipContent>
              </Tooltip>
            </div>
          </header>

          <Separator className="my-0" />

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

          {/* Ledger Cards — items-start avoids stretching short cards when one column is taller */}
          <section className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 sm:gap-4">
            <LedgerCard
              label="Ledger A"
              index="A"
              wallet={ledgerA}
              loading={loadingBalances}
              hwState={hwStateA}
              hardwareMode={HARDWARE_MODE}
              sendingNow={sendingFrom === "A"}
              awaitingHardware={awaitingHw === "A"}
              connectingHardware={connectingHw === "A"}
              hasSerial={hasSerial}
              isBlacklisted={blacklistedDevice?.ledger === "A"}
              sendAmount={sendAmountA}
              setSendAmount={setSendAmountA}
              onSend={(amount) => handleTransfer("A", amount)}
              onConnect={() => connectHardware("A")}
              onRegister={() => registerDevice("A")}
              onResumePin={() => resumePinSetup("A")}
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
              awaitingHardware={awaitingHw === "B"}
              connectingHardware={connectingHw === "B"}
              hasSerial={hasSerial}
              isBlacklisted={blacklistedDevice?.ledger === "B"}
              sendAmount={sendAmountB}
              setSendAmount={setSendAmountB}
              onSend={(amount) => handleTransfer("B", amount)}
              onConnect={() => connectHardware("B")}
              onRegister={() => registerDevice("B")}
              onResumePin={() => resumePinSetup("B")}
              onRecover={() => recoverDevice("B")}
            />
          </section>

          {/* Transfer indicator */}
          <div className="text-muted-foreground flex flex-col gap-3 py-0.5 sm:flex-row sm:items-start sm:justify-center sm:gap-4">
            {addrA ? (
              <CopyableAddress
                address={addrA}
                className="min-w-0 flex-1"
                textClassName="text-[10px] leading-snug md:text-xs"
              />
            ) : (
              <span className="text-center text-xs">—</span>
            )}
            <ArrowRightLeft className="mx-auto size-4 shrink-0 sm:mt-1" />
            {addrB ? (
              <CopyableAddress
                address={addrB}
                className="min-w-0 flex-1"
                textClassName="text-[10px] leading-snug md:text-xs"
              />
            ) : (
              <span className="text-center text-xs">—</span>
            )}
          </div>

          <Separator className="my-0" />

          {/* Transaction History */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold md:text-lg">
                Transaction History
              </h2>
              {loadingHistory && (
                <OrbitLoader className="text-muted-foreground size-4" />
              )}
            </div>

            {txHistory.length === 0 && !loadingHistory ? (
              <Card>
                <CardContent className="text-muted-foreground py-10 text-center text-sm">
                  No transactions yet. Send a transfer once you have SOL.
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
                            <XCircle className="text-destructive size-4" />
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs tabular-nums">
                          <LocalTxTime blockTime={tx.blockTime} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <TxAddressCell
                            addr={tx.from}
                            addrA={addrA}
                            addrB={addrB}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <TxAddressCell
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
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <a
                                  href={`https://explorer.solana.com/tx/${tx.signature}?cluster=testnet`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-muted-foreground hover:text-foreground inline-flex rounded p-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                  aria-label="View transaction on Solana Explorer"
                                />
                              }
                            >
                              <ExternalLink className="size-3" />
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              View on Solana Explorer
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {historyHasMore && txHistory.length > 0 && (
                    <TableFooter>
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={7}
                          className="text-muted-foreground py-2.5 text-center text-xs"
                        >
                          <span className="text-foreground/80 font-medium tracking-widest">
                            ···
                          </span>
                          <span className="mt-1 block font-normal tracking-normal">
                            Older on-chain transfers aren&apos;t all listed here
                            (newest first; list is capped).
                          </span>
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </Card>
            )}
          </section>
        </div>

        {/* ── Seed Phrase Backup Modal ─────────────────────────────────── */}
        {seedBackupModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-background/80 fixed inset-0 backdrop-blur-sm" />
            <div className="bg-popover ring-foreground/10 relative z-10 flex w-full max-w-lg flex-col gap-4 rounded-xl p-6 shadow-lg ring-1">
              <div className="flex flex-col gap-1">
                <h2 className="font-heading text-base leading-none font-medium">
                  Backup Your Seed Phrase
                </h2>
                <p className="text-muted-foreground text-sm">
                  These words were generated on your ledger device and the
                  indices are stored in device memory. This page maps them to
                  the standard BIP-39 English list. Write them down in order —
                  you need them after a PIN wipe. Never share them with anyone.
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

              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <p className="text-xs text-amber-500">
                  This is the only time your seed phrase will be shown. Store it
                  securely — you cannot view it again. The device will not move
                  to PIN setup until you download the .txt file below.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    const content = seedBackupModal.words.join(" ");
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
                  type="button"
                  className="w-full"
                  disabled={!seedDownloaded}
                  onClick={confirmSeedBackup}
                >
                  {seedDownloaded
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
            <div className="bg-popover ring-foreground/10 relative z-10 flex w-full max-w-lg flex-col gap-4 rounded-xl p-6 shadow-lg ring-1">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="text-destructive size-4 shrink-0" />
                  <h2 className="font-heading text-base leading-none font-medium">
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

        {/* ── Blacklisted Device Modal ─────────────────────────────────── */}
        {blacklistedDevice && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-background/80 fixed inset-0 backdrop-blur-sm" />
            <div className="bg-popover ring-destructive/40 relative z-10 flex w-full max-w-md flex-col gap-4 rounded-xl p-6 shadow-lg ring-1">
              <div className="flex items-center gap-3">
                <ShieldAlert className="text-destructive size-6 shrink-0" />
                <h2 className="text-base font-semibold">Device Blocked</h2>
              </div>
              <p className="text-muted-foreground text-sm">
                Ledger {blacklistedDevice.ledger} has been flagged and is no
                longer permitted to use this platform.
              </p>
              <p className="text-muted-foreground text-xs">
                Reason: {blacklistedDevice.reason}
              </p>
              <div className="bg-muted space-y-1 rounded-lg p-4 text-sm">
                <p className="font-medium">Contact Support</p>
                <p className="text-muted-foreground">
                  Email: support@cryptx.dev
                </p>
                <p className="text-muted-foreground">
                  Discord: discord.gg/cryptx
                </p>
                <p className="text-muted-foreground">
                  Reference ID: {blacklistedDevice.ledger}-blocked
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full sm:flex-1"
                  onClick={() => setBlacklistedDevice(null)}
                >
                  Try again
                </Button>
                <a
                  href="/auth/logout"
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "inline-flex w-full flex-1 gap-1.5 sm:w-auto",
                  )}
                  onClick={() => {
                    void fetch("/api/session/log", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ event: "logout" }),
                    });
                  }}
                >
                  <LogOut className="mr-2 size-3.5" />
                  Log out
                </a>
              </div>
              <p className="text-muted-foreground text-xs">
                If support removed your device from the block list, tap Try
                again and connect your ledger again — the port opens as soon as
                the check passes.
              </p>
            </div>
          </div>
        )}
      </main>
    </>
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
  awaitingHardware,
  connectingHardware,
  hasSerial,
  isBlacklisted,
  sendAmount,
  setSendAmount,
  onSend,
  onConnect,
  onRegister,
  onResumePin,
  onRecover,
}: {
  label: string;
  index: "A" | "B";
  wallet: WalletInfo | null;
  loading: boolean;
  hwState: HwState;
  hardwareMode: boolean;
  sendingNow: boolean;
  awaitingHardware: boolean;
  connectingHardware: boolean;
  hasSerial: boolean;
  isBlacklisted: boolean;
  sendAmount: string;
  setSendAmount: (v: string) => void;
  onSend: (amount: number) => void;
  onConnect: () => void;
  onRegister: () => void;
  onResumePin: () => void;
  onRecover: () => void;
}) {
  const busy = sendingNow || awaitingHardware || loading || connectingHardware;

  const isSetup =
    hwState.mode === "INIT" ||
    hwState.mode === "SET_PIN" ||
    hwState.mode === "CONFIRM_PIN";
  const isWiped = hwState.mode === "WIPED";
  const isSigning = hwState.mode === "SIGNING" || awaitingHardware;
  const isReady = hwState.mode === "READY";
  const showSetupFlow =
    hardwareMode && hwState.connected && (isSetup || isWiped);

  const parsedAmount = parseFloat(sendAmount);
  const amountValid =
    !Number.isNaN(parsedAmount) &&
    parsedAmount > 0 &&
    parsedAmount <= (wallet?.balance ?? 0);
  const amountOverBalance =
    !Number.isNaN(parsedAmount) &&
    parsedAmount > 0 &&
    parsedAmount > (wallet?.balance ?? 0);

  let sendLabel = `Send ${amountValid ? parsedAmount : "—"} SOL`;
  if (awaitingHardware) sendLabel = "Enter PIN on device…";
  else if (sendingNow) sendLabel = "Sending…";

  const sendDisabled =
    busy ||
    isBlacklisted ||
    !amountValid ||
    (hardwareMode && (!hwState.connected || !isReady));

  return (
    <Card
      size="sm"
      className="flex w-full min-w-0 flex-col gap-2 py-3 has-data-[slot=card-footer]:pb-0"
    >
      <CardHeader className="gap-0.5 px-3 pb-2 pt-0 [.border-b]:pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <Cpu className="text-primary size-3.5" />
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
                      : "bg-primary shadow-[0_0_10px_oklch(0.62_0.12_300/45%)]"
                    : "bg-muted-foreground/30",
                )}
                title={
                  hwState.connected ? `Mode: ${hwState.mode}` : "Not connected"
                }
              />
            )}
            <Badge
              variant="outline"
              className="border-primary/35 bg-primary/10 text-primary font-medium"
            >
              Ledger {index}
            </Badge>
          </div>
        </div>
        <CardDescription className="block w-full min-w-0 p-0 font-normal">
          {loading ? (
            <span className="text-muted-foreground inline-flex items-center gap-1.5 font-mono text-[11px]">
              <OrbitLoader className="size-3.5 shrink-0" />
              <span>Syncing…</span>
            </span>
          ) : wallet ? (
            <CopyableAddress
              address={wallet.address}
              className="w-full"
              textClassName="text-[11px] md:text-xs"
            />
          ) : (
            <span className="text-muted-foreground font-mono text-[11px]">
              —
            </span>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3 px-3">
        {/* ── Balance (always shown) ─────────────────────────── */}
        <div>
          <p className="text-3xl font-bold tabular-nums leading-none md:text-4xl">
            {loading || wallet === null ? (
              <span className="text-muted-foreground text-2xl">—</span>
            ) : (
              wallet.balance.toFixed(4)
            )}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">SOL</p>
        </div>

        {/* ── Hardware: connect (tap this block — no separate footer connect button) ─ */}
        {hardwareMode &&
          !hwState.connected &&
          (hasSerial ? (
            <button
              type="button"
              className={cn(
                "border-primary/25 bg-primary/5 flex w-full flex-col items-center gap-2 rounded-lg border py-4 transition-colors",
                "hover:bg-primary/10 hover:border-primary/35 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                (busy || connectingHardware || isBlacklisted) &&
                  "pointer-events-none opacity-50",
                connectingHardware && "border-primary/40 bg-primary/10",
              )}
              onClick={onConnect}
              disabled={busy || connectingHardware || isBlacklisted}
            >
              <Usb className="text-primary size-7 shrink-0" />
              <p className="text-center text-sm leading-snug">
                <span className="text-primary block font-medium">
                  {connectingHardware ? "Connecting…" : "Connect a ledger"}
                </span>
                {!connectingHardware && (
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    Tap here to pair over USB
                  </span>
                )}
              </p>
            </button>
          ) : (
            <div className="border-muted-foreground/20 bg-muted/30 flex flex-col items-center gap-1.5 rounded-lg border py-4">
              <Usb className="text-muted-foreground size-7" />
              <p className="text-muted-foreground px-3 text-center text-xs">
                Web Serial is not available in this browser. Use Chrome or Edge
                to connect a ledger.
              </p>
            </div>
          ))}

        {showSetupFlow &&
          hwState.mode === "INIT" &&
          hwState.seedSet &&
          hwState.seedHostAck &&
          !hwState.pinSet &&
          hwState.deviceId === index && (
            <div className="bg-muted/50 space-y-2 rounded-lg p-3">
              <p className="text-xs font-medium">Resume PIN setup</p>
              <p className="text-muted-foreground text-[11px] leading-snug">
                This device already has a seed and host confirmation. After
                unplugging, it starts in a safe idle state — continue here, then
                enter your PIN on the hardware.
              </p>
              <Button
                size="sm"
                className="w-full"
                onClick={onResumePin}
                disabled={busy}
              >
                Continue PIN on device
              </Button>
            </div>
          )}

        {showSetupFlow &&
          hwState.mode === "INIT" &&
          !(
            hwState.seedSet &&
            hwState.seedHostAck &&
            !hwState.pinSet &&
            hwState.deviceId === index
          ) && (
            <div className="bg-muted/50 space-y-2 rounded-lg p-3">
              <p className="text-xs font-medium">Device Setup</p>
              <p className="text-muted-foreground text-[11px]">
                Register this device as Ledger {index}
              </p>
              <Button size="sm" className="w-full" onClick={onRegister}>
                Register as Ledger {index}
              </Button>
            </div>
          )}

        {showSetupFlow &&
          (hwState.mode === "SET_PIN" || hwState.mode === "CONFIRM_PIN") && (
            <div className="bg-muted/50 space-y-2 rounded-lg p-3">
              <p className="text-xs font-medium">
                {hwState.mode === "SET_PIN" ? "Create PIN" : "Confirm PIN"}
              </p>
              <p className="text-muted-foreground text-[11px] leading-snug">
                Press and release one button at a time: btn 1 = digit 1, btn 2 =
                digit 2. The digit is counted on release. Six digits submit
                automatically. If both buttons are pressed together, nothing is
                counted until both are released.
              </p>
              <PinDots filled={hwState.pinProgress} />
            </div>
          )}

        {showSetupFlow && isWiped && (
          <div className="bg-destructive/10 space-y-2 rounded-lg p-3">
            <div className="flex items-center gap-1.5">
              <ShieldAlert className="text-destructive size-3.5" />
              <p className="text-destructive text-xs font-medium">
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
          <div className="border-primary/35 bg-primary/10 space-y-2 rounded-lg border p-3 shadow-[0_0_24px_-12px_oklch(0.55_0.1_300/28%)]">
            <p className="text-primary text-xs font-medium">
              Signing transaction
            </p>
            <p className="text-muted-foreground text-[11px]">
              Enter your PIN on the device using the two buttons.
            </p>
            <PinDots filled={hwState.pinProgress} />
            <SigningDeadline endsAt={hwState.signExpiresAt} />
            {hwState.pinFails > 0 && (
              <p className="text-destructive text-xs">
                {hwState.pinFails} wrong attempt
                {hwState.pinFails > 1 ? "s" : ""} — {3 - hwState.pinFails} left
              </p>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-col gap-1.5 px-3 pb-3 pt-2">
        {isBlacklisted && (
          <div className="bg-destructive/10 flex w-full items-center gap-2 rounded-lg px-3 py-2">
            <ShieldAlert className="text-destructive size-4 shrink-0" />
            <p className="text-destructive text-xs font-medium">
              Device Blocked
            </p>
          </div>
        )}

        {/* Amount input */}
        <div className="flex w-full items-center gap-2">
          <Input
            type="number"
            step="any"
            min="0"
            placeholder="Amount"
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
            className="flex-1 font-mono text-sm tabular-nums"
            disabled={isBlacklisted}
          />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 font-mono text-xs"
            onClick={() => setSendAmount("0.01")}
            disabled={isBlacklisted}
          >
            0.01
          </Button>
        </div>
        {amountOverBalance && (
          <p className="text-destructive w-full text-xs">
            Exceeds balance ({wallet?.balance.toFixed(4)} SOL)
          </p>
        )}

        <Button
          className="w-full"
          onClick={() => onSend(parsedAmount)}
          disabled={sendDisabled}
        >
          <ArrowRightLeft className="mr-2 size-4" />
          {sendLabel}
        </Button>

        {hardwareMode && hwState.connected && (
          <div className="flex w-full gap-2">
            <a
              href={`/dashboard/insights?deviceId=${encodeURIComponent(
                hwState.logDeviceId ||
                  canonicalLedgerDeviceId(hwState.deviceId, null),
              )}`}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "w-full gap-1.5 text-xs",
              )}
            >
              <BarChart2 className="size-3" />
              Insights
            </a>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}

