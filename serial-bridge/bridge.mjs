/**
 * cryptX Serial Bridge  (v2 — EEPROM Edition)
 * ─────────────────────────────────────────────
 * Runs alongside `pnpm dev`.  Keeps two serial connections open (one per
 * Arduino) and exposes a tiny HTTP API that the Next.js transfer route
 * calls when HARDWARE_MODE=true.
 *
 * Usage:
 *   cd serial-bridge && npm install && node bridge.mjs
 *
 * Required env vars (read from ../.env):
 *   BRIDGE_COM_A   COM port for Ledger A   e.g. COM3
 *   BRIDGE_COM_B   COM port for Ledger B   e.g. COM4
 *
 * HTTP endpoints:
 *   GET  /status                  → { ledgerA: {...}, ledgerB: {...} }
 *   POST /confirm                 → body { wallet: "A"|"B" }
 *   GET  /stats                   → body { wallet: "A"|"B" }
 *   POST /unlock                  → body { wallet: "A"|"B" }
 *   POST /reset-stats             → body { wallet: "A"|"B" }
 *   POST /setid                   → body { wallet: "A"|"B", id: "X" }
 */

import express  from "express";
import { SerialPort }      from "serialport";
import { ReadlineParser }  from "@serialport/parser-readline";
import dotenv   from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath }   from "url";

// ── Load .env from project root ───────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dir, "../.env") });

const BRIDGE_PORT     = 3456;
const BAUD_RATE       = 115200;
const SIGN_TIMEOUT_MS = 28_000;   // 2s less than Arduino's 30s timeout
const CMD_TIMEOUT_MS  = 3_000;    // timeout for non-sign commands

const COM_A = process.env.BRIDGE_COM_A ?? "COM3";
const COM_B = process.env.BRIDGE_COM_B ?? "COM4";

// ── Per-device runtime state ──────────────────────────────────────────────────
const deviceMeta = {
  A: { id: "A", locked: false, confirms: 0, rejects: 0, streak: 0 },
  B: { id: "B", locked: false, confirms: 0, rejects: 0, streak: 0 },
};

// ── Open a serial port and attach a readline parser ──────────────────────────
function openDevice(comPath, wallet) {
  console.log(`Opening ${comPath} (Ledger ${wallet})…`);

  const port   = new SerialPort({ path: comPath, baudRate: BAUD_RATE, autoOpen: false });
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

  parser.on("data", (line) => {
    const msg = line.trim();
    console.log(`[${comPath}] ← ${msg}`);

    // Keep meta in sync from unsolicited messages
    if (msg.startsWith("DEVICE:")) {
      deviceMeta[wallet].id = msg.slice(7);
    } else if (msg === "LOCKED") {
      deviceMeta[wallet].locked = true;
    } else if (msg === "UNLOCKED") {
      deviceMeta[wallet].locked = false;
    } else if (msg.startsWith("STATS:")) {
      parseStats(wallet, msg);
    }
  });

  port.on("error", (err) => console.error(`[${comPath}] Error: ${err.message}`));
  port.on("close", ()    => console.warn(`[${comPath}] Disconnected`));

  port.open((err) => {
    if (err) {
      console.error(`[${comPath}] Failed to open: ${err.message}`);
      console.error(`  → Check Device Manager for the correct COM port`);
    } else {
      console.log(`[${comPath}] Connected ✓`);
      // Fetch initial stats on connect
      setTimeout(() => sendCmd(port, parser, "STATS", CMD_TIMEOUT_MS).catch(() => {}), 500);
    }
  });

  return { port, parser };
}

const deviceA = openDevice(COM_A, "A");
const deviceB = openDevice(COM_B, "B");

function getDevice(wallet) {
  return wallet === "A" ? deviceA : deviceB;
}

// ── Parse STATS response ──────────────────────────────────────────────────────
function parseStats(wallet, msg) {
  // STATS:<confirms>,<rejects>,<streak>,<locked>
  const parts = msg.replace("STATS:", "").split(",").map(Number);
  if (parts.length === 4) {
    deviceMeta[wallet].confirms = parts[0];
    deviceMeta[wallet].rejects  = parts[1];
    deviceMeta[wallet].streak   = parts[2];
    deviceMeta[wallet].locked   = parts[3] === 1;
  }
}

// ── Wait for a specific response line ────────────────────────────────────────
function waitForResponse(parser, expectedSet, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      parser.removeListener("data", handler);
      reject(new Error(`Timeout: none of [${[...expectedSet].join("|")}] within ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(raw) {
      const line = raw.trim();
      if (expectedSet.has(line)) {
        clearTimeout(timer);
        parser.removeListener("data", handler);
        resolve(line);
      }
    }

    parser.on("data", handler);
  });
}

// ── Send a command and wait for any of a set of expected responses ────────────
async function sendCmd(port, parser, cmd, timeoutMs, expectedSet) {
  await new Promise((res, rej) =>
    port.write(`${cmd}\n`, (err) => (err ? rej(err) : res()))
  );
  if (!expectedSet) return null;
  return waitForResponse(parser, expectedSet, timeoutMs);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Helper to validate wallet param
function requireWallet(req, res) {
  const { wallet } = req.body ?? {};
  if (wallet !== "A" && wallet !== "B") {
    res.status(400).json({ error: 'wallet must be "A" or "B"' });
    return null;
  }
  return wallet;
}

// GET /status
app.get("/status", (_req, res) => {
  res.json({
    ledgerA: { port: COM_A, connected: deviceA.port.isOpen, ...deviceMeta.A },
    ledgerB: { port: COM_B, connected: deviceB.port.isOpen, ...deviceMeta.B },
  });
});

// GET /stats?wallet=A
app.get("/stats", async (req, res) => {
  const wallet = req.query.wallet;
  if (wallet !== "A" && wallet !== "B") {
    return res.status(400).json({ error: 'wallet must be "A" or "B"' });
  }
  const { port, parser } = getDevice(wallet);
  if (!port.isOpen) return res.status(503).json({ error: `Ledger ${wallet} not connected` });

  try {
    const raw = await sendCmd(port, parser, "STATS", CMD_TIMEOUT_MS,
      new Set(["STATS:0,0,0,0"].length ? null : null));  // fire and let passive parser update

    // Actually just send STATS and listen for STATS: prefix
    port.write("STATS\n");
    await new Promise((resolve) => setTimeout(resolve, 400));  // give device time to respond
    res.json(deviceMeta[wallet]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /confirm  { wallet: "A"|"B" }
app.post("/confirm", async (req, res) => {
  const wallet = requireWallet(req, res);
  if (!wallet) return;

  const { port, parser } = getDevice(wallet);
  const label = `Ledger ${wallet}`;

  if (!port.isOpen) {
    return res.status(503).json({ error: `${label} is not connected` });
  }

  if (deviceMeta[wallet].locked) {
    return res.status(423).json({ error: `${label} is locked after too many rejections. Send UNLOCK first.` });
  }

  console.log(`[bridge] → Sending SIGN to ${label}`);

  try {
    const result = await sendCmd(
      port, parser, "SIGN", SIGN_TIMEOUT_MS,
      new Set(["CONFIRMED", "REJECTED", "LOCKED"])
    );

    if (result === "CONFIRMED") {
      deviceMeta[wallet].confirms++;
      deviceMeta[wallet].streak = 0;
      console.log(`[bridge] ${label} confirmed ✓`);
      return res.json({ confirmed: true });
    } else if (result === "LOCKED") {
      deviceMeta[wallet].locked = true;
      return res.status(423).json({ confirmed: false, error: `${label} is now locked` });
    } else {
      deviceMeta[wallet].rejects++;
      deviceMeta[wallet].streak++;
      console.warn(`[bridge] ${label} rejected`);
      return res.status(408).json({ confirmed: false, error: "Device rejected or timed out" });
    }
  } catch (err) {
    console.error(`[bridge] ${label} timeout: ${err.message}`);
    port.write("CANCEL\n");
    return res.status(408).json({ confirmed: false, error: err.message });
  }
});

// POST /unlock  { wallet: "A"|"B" }
app.post("/unlock", async (req, res) => {
  const wallet = requireWallet(req, res);
  if (!wallet) return;
  const { port, parser } = getDevice(wallet);
  if (!port.isOpen) return res.status(503).json({ error: `Ledger ${wallet} not connected` });

  try {
    await sendCmd(port, parser, "UNLOCK", CMD_TIMEOUT_MS, new Set(["UNLOCKED"]));
    deviceMeta[wallet].locked = false;
    deviceMeta[wallet].streak = 0;
    res.json({ unlocked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /reset-stats  { wallet: "A"|"B" }
app.post("/reset-stats", async (req, res) => {
  const wallet = requireWallet(req, res);
  if (!wallet) return;
  const { port, parser } = getDevice(wallet);
  if (!port.isOpen) return res.status(503).json({ error: `Ledger ${wallet} not connected` });

  try {
    await sendCmd(port, parser, "RESET_STATS", CMD_TIMEOUT_MS, new Set(["STATS_RESET"]));
    deviceMeta[wallet] = { ...deviceMeta[wallet], confirms: 0, rejects: 0, streak: 0, locked: false };
    res.json({ reset: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /setid  { wallet: "A"|"B", id: "X" }
app.post("/setid", async (req, res) => {
  const wallet = requireWallet(req, res);
  if (!wallet) return;
  const { id } = req.body ?? {};
  if (!id || !/^[A-Z]$/.test(id)) {
    return res.status(400).json({ error: "id must be a single uppercase letter A-Z" });
  }

  const { port, parser } = getDevice(wallet);
  if (!port.isOpen) return res.status(503).json({ error: `Ledger ${wallet} not connected` });

  try {
    await sendCmd(port, parser, `SETID ${id}`, CMD_TIMEOUT_MS, new Set(["ID_SAVED"]));
    deviceMeta[wallet].id = id;
    res.json({ saved: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(BRIDGE_PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   cryptX Serial Bridge v2 — port 3456   ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Ledger A: ${COM_A}`);
  console.log(`  Ledger B: ${COM_B}`);
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /status");
  console.log("  GET  /stats?wallet=A|B");
  console.log("  POST /confirm       { wallet }");
  console.log("  POST /unlock        { wallet }");
  console.log("  POST /reset-stats   { wallet }");
  console.log("  POST /setid         { wallet, id }");
  console.log("");
  console.log("Tip: run `node bridge.mjs list` to see available COM ports");
});

// ── Helper: list available serial ports ──────────────────────────────────────
if (process.argv[2] === "list") {
  const ports = await SerialPort.list();
  console.log("Available COM ports:");
  ports.forEach((p) => console.log(`  ${p.path}  —  ${p.friendlyName ?? p.manufacturer ?? ""}`));
  process.exit(0);
}

// =============================================================================
// Challenge-response auth helper (added for v3 protected firmware)
// Must match SECRET_KEY in ledger.ino and XOR_KEY in cryptx_dump.py
// =============================================================================

const SECRET_KEY = Buffer.from([0x4B, 0x72, 0x79, 0x70, 0x74, 0x58, 0x21, 0x01]);

/**
 * Performs CHALLENGE → AUTH handshake and returns decoded stats.
 * Throws if auth fails or device doesn't respond in time.
 */
async function getAuthenticatedStats(port, parser) {
  // Step 1: request a nonce
  const nonceRaw = await sendCmd(port, parser, "CHALLENGE", CMD_TIMEOUT_MS,
    new Set(["NONCE_WAIT"])  // we'll intercept NONCE: lines manually below
  ).catch(() => null);

  // Actually listen for NONCE: prefix manually
  port.write("CHALLENGE\n");
  const nonceLine = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("NONCE timeout")), CMD_TIMEOUT_MS);
    function h(raw) {
      const line = raw.trim();
      if (line.startsWith("NONCE:")) {
        clearTimeout(t);
        parser.removeListener("data", h);
        resolve(line);
      }
    }
    parser.on("data", h);
  });

  // Step 2: parse the 8-byte nonce
  const nonceHex = nonceLine.slice(6);  // strip "NONCE:"
  const nonce = Buffer.from(nonceHex, "hex");

  // Step 3: compute response = nonce[i] XOR SECRET_KEY[i]
  const response = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    response[i] = nonce[i] ^ SECRET_KEY[i];
  }

  // Step 4: send AUTH and wait for STATS or AUTH_FAIL
  port.write(`AUTH ${response.toString("hex").toUpperCase()}\n`);
  const result = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("AUTH timeout")), CMD_TIMEOUT_MS);
    function h(raw) {
      const line = raw.trim();
      if (line.startsWith("STATS:") || line === "AUTH_FAIL") {
        clearTimeout(t);
        parser.removeListener("data", h);
        resolve(line);
      }
    }
    parser.on("data", h);
  });

  if (result === "AUTH_FAIL") throw new Error("AUTH_FAIL: wrong key or stale nonce");
  return result;  // "STATS:<c>,<r>,<streak>,<locked>"
}

// GET /stats?wallet=A  (now uses challenge-response)
// Replace the old /stats handler by re-registering it
app.get("/stats/authenticated", async (req, res) => {
  const wallet = req.query.wallet;
  if (wallet !== "A" && wallet !== "B") {
    return res.status(400).json({ error: 'wallet must be "A" or "B"' });
  }
  const { port, parser } = getDevice(wallet);
  if (!port.isOpen) return res.status(503).json({ error: `Ledger ${wallet} not connected` });

  try {
    const statsLine = await getAuthenticatedStats(port, parser);
    parseStats(wallet, statsLine);
    res.json(deviceMeta[wallet]);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});
