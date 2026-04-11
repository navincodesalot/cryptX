/**
 * cryptX Serial Bridge
 * ─────────────────────
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
 *   GET  /status           → { ledgerA: { port, connected }, ledgerB: { ... } }
 *   POST /confirm          → body { wallet: "A"|"B" }
 *                            Sends SIGN to device, waits for CONFIRMED
 *                            Response: { confirmed: true } or 408 with error
 */

import express from "express";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── Load .env from project root ───────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dir, "../.env") });

const BRIDGE_PORT       = 3456;
const BAUD_RATE         = 115200;
const SIGN_TIMEOUT_MS   = 28_000;  // 2s less than Arduino's 30s timeout

const COM_A = process.env.BRIDGE_COM_A ?? "COM3";
const COM_B = process.env.BRIDGE_COM_B ?? "COM4";

// ── Open a serial port and attach a readline parser ──────────────────────────
function openDevice(comPath) {
  console.log(`Opening ${comPath}…`);

  const port = new SerialPort({ path: comPath, baudRate: BAUD_RATE, autoOpen: false });
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

  parser.on("data", (line) => {
    console.log(`[${comPath}] ← ${line.trim()}`);
  });

  port.on("error", (err) => console.error(`[${comPath}] Error: ${err.message}`));
  port.on("close", () => console.warn(`[${comPath}] Disconnected`));

  port.open((err) => {
    if (err) {
      console.error(`[${comPath}] Failed to open: ${err.message}`);
      console.error(`  → Check Device Manager for the correct COM port and update BRIDGE_COM_A / BRIDGE_COM_B in .env`);
    } else {
      console.log(`[${comPath}] Connected ✓`);
    }
  });

  return { port, parser };
}

const deviceA = openDevice(COM_A);
const deviceB = openDevice(COM_B);

// ── Wait for a response line from a device ────────────────────────────────────
function waitForResponse(parser, expected, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      parser.removeListener("data", handler);
      reject(new Error(`Timeout: no "${expected}" within ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(raw) {
      const line = raw.trim();
      if (line === expected || line === "REJECTED") {
        clearTimeout(timer);
        parser.removeListener("data", handler);
        resolve(line);
      }
    }

    parser.on("data", handler);
  });
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// GET /status
app.get("/status", (_req, res) => {
  res.json({
    ledgerA: { port: COM_A, connected: deviceA.port.isOpen },
    ledgerB: { port: COM_B, connected: deviceB.port.isOpen },
  });
});

// POST /confirm  { wallet: "A"|"B" }
app.post("/confirm", async (req, res) => {
  const { wallet } = req.body ?? {};

  if (wallet !== "A" && wallet !== "B") {
    return res.status(400).json({ error: 'wallet must be "A" or "B"' });
  }

  const device = wallet === "A" ? deviceA : deviceB;
  const label  = `Ledger ${wallet}`;

  if (!device.port.isOpen) {
    return res
      .status(503)
      .json({ error: `${label} is not connected (${wallet === "A" ? COM_A : COM_B})` });
  }

  console.log(`[bridge] → Sending SIGN to ${label}`);

  // Send SIGN command to the Arduino
  device.port.write("SIGN\n", (writeErr) => {
    if (writeErr) {
      return res.status(500).json({ error: `Write error: ${writeErr.message}` });
    }
  });

  // Wait for button press (CONFIRMED) or rejection/timeout
  try {
    const result = await waitForResponse(device.parser, "CONFIRMED", SIGN_TIMEOUT_MS);

    if (result === "CONFIRMED") {
      console.log(`[bridge] ${label} confirmed ✓`);
      return res.json({ confirmed: true });
    } else {
      console.warn(`[bridge] ${label} rejected`);
      return res.status(408).json({ confirmed: false, error: "Device rejected or timed out" });
    }
  } catch (err) {
    console.error(`[bridge] ${label} timeout: ${err.message}`);
    // Send CANCEL so the Arduino returns to idle
    device.port.write("CANCEL\n");
    return res.status(408).json({ confirmed: false, error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(BRIDGE_PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║   cryptX Serial Bridge — port 3456   ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`  Ledger A: ${COM_A}`);
  console.log(`  Ledger B: ${COM_B}`);
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
