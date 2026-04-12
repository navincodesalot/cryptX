# cryptX

> A reverse-engineered hardware ledger for the Solana blockchain, with custom PIN + seed phrase authentication, real-time balance monitoring, and live fraud detection using log analysis.

**[cryptx.work](https://cryptx.work)**

---

cryptX is a fully functional hardware crypto wallet built on Solana — bringing real signing security to blockchain transactions without the $150 price tag. Inspired by the *cryptex*, a cylindrical puzzle box designed to hide secrets, the device enforces physical approval for every transaction, just like a real Ledger.

---

## Features

- **Hardware-enforced signing** — every transaction requires physical button confirmation on-device before it hits the chain
- **Full authentication lifecycle** — 6-digit PIN setup, BIP-39 seed phrase backup, and challenge-response device authentication
- **Self-destruct wipe** — three wrong PIN attempts permanently wipes the device via EEPROM reset
- **Live Solana transactions** — send and receive SOL on Solana testnet with real-time balance updates
- **AI fraud detection** — Gemini-powered log analysis continuously monitors device behavior and flags anomalies
- **Device blacklisting** — compromised devices are automatically blocked before they can do damage
- **Real-time dashboard** — full transaction history pulled from the blockchain, AI risk reports, and live device status

---

## How It Works

```
┌──────────────────────┐        USB Serial        ┌──────────────────────┐
│   Arduino Uno        │ ◄──────────────────────► │   Next.js Dashboard  │
│                      │                           │                      │
│  • PIN state machine │   signed tx payload       │  • Solana Web3.js    │
│  • BIP-39 seed gen   │ ──────────────────────►   │  • Transaction relay │
│  • SipHash-2-4 auth  │                           │  • Gemini AI audit   │
│  • State persistence │   signing request         │  • Device blacklist  │
│  • Grove LCD display │ ◄──────────────────────   │  • Live dashboard    │
└──────────────────────┘                           └──────────────────────┘
```

The private key never leaves the device. The Arduino constructs and signs the transaction locally; the dashboard only ever receives the signed payload and relays it to the Solana RPC.

---

## Hardware

| Component | Purpose |
|---|---|
| Arduino Uno | Main microcontroller running the wallet state machine |
| Grove Base Shield | Stacking shield that breaks out Arduino pins to Grove connectors for clean module wiring |
| Grove LCD (RGB backlit, I2C) | Displays PIN prompts, seed words, and transaction details |
| 2× Push buttons | Physical confirm / reject controls |

---

## Security Architecture

**Challenge-response authentication**
Device identity is cryptographically bound to the physical silicon using SipHash-2-4 with keys derived from the chip's own hardware signature. A fresh challenge is issued on every connection — no replay attacks.

**BIP-39 seed phrases**
Seed generation follows the real BIP-39 standard used by every major hardware wallet. Words are displayed one-by-one on the LCD and verified before the device ever signs anything.

**Signing boundary**
The private key is generated and stored exclusively on-device. Transaction payloads are signed in firmware; only the serialized signed transaction is exposed over USB.

**EEPROM self-destruct**
Three consecutive wrong PIN attempts trigger a full EEPROM wipe, destroying all wallet state.

---

## Fraud Detection

Every device action — connection events, PIN attempts, transaction signings — is logged and fed into a Gemini AI agent via the `/api/audit` and `/api/insights` endpoints.

The agent flags patterns including:
- Repeated authentication failures
- Mid-transaction disconnects
- Unusual signing velocity
- Unrecognized device signatures

Flagged devices are written to a blacklist and blocked from future transaction submissions in real time.

---

## Tech Stack

**Firmware**
- C++ (Arduino)
- SipHash-2-4
- BIP-39 word list
- I2C / LCD
- EEPROM

**Dashboard**
- [Next.js 16](https://nextjs.org) (App Router)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Vercel AI SDK](https://sdk.vercel.ai) + Gemini
- MongoDB (device logs + blacklist)
- Auth0
- Tailwind CSS + shadcn/ui

---

## Project Structure

```
cryptX/
├── firmware/
│   └── ledger/
│       └── ledger.ino        # Arduino wallet firmware
├── src/
│   ├── app/
│   │   ├── dashboard/        # Real-time wallet dashboard
│   │   └── api/
│   │       ├── transfer/     # Solana transaction relay
│   │       ├── balance/      # Live SOL balance
│   │       ├── history/      # On-chain transaction history
│   │       ├── log/          # Device event ingestion
│   │       ├── audit/        # Security audit records
│   │       ├── insights/     # Gemini AI risk reports
│   │       ├── security/     # Device blacklist management
│   │       ├── seed/         # Seed phrase verification
│   │       └── session/      # Device session handling
│   └── components/
│       ├── dashboard/        # Dashboard UI components
│       └── cosmic/           # Visual / loader components
```

---

## Getting Started

### Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io)
- Arduino IDE (for firmware)
- MongoDB instance
- Auth0 application
- Google Gemini API key
- Solana RPC endpoint (testnet)

### Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

### Dashboard

```bash
pnpm install
pnpm dev
```

The dashboard runs at `http://localhost:3000`.

### Firmware

Open `firmware/ledger/ledger.ino` in the Arduino IDE, select the **Arduino Uno** board, and upload to the device. The device will walk through first-time setup on the LCD.

---

## API Reference

| Route | Method | Description |
|---|---|---|
| `/api/balance` | GET | Fetch live SOL balance for a wallet |
| `/api/transfer` | POST | Relay a signed transaction to Solana |
| `/api/history` | GET | Pull on-chain transaction history |
| `/api/log` | POST | Ingest a device event log |
| `/api/logs` | GET | Retrieve stored device logs |
| `/api/audit` | GET/POST | Read or write security audit records |
| `/api/insights` | POST | Run Gemini AI analysis on device logs |
| `/api/security` | GET/POST | Manage device blacklist |
| `/api/seed` | POST | Verify BIP-39 seed phrase |
| `/api/session` | GET/POST | Manage active device session |
| `/api/airdrop` | POST | Request testnet SOL airdrop |
| `/api/health` | GET | Service health check |

---

## What's Next

- **ESP32 migration** — move from Arduino to ESP32 to enable native Ed25519 signing directly on-device, making cryptX a legitimate hardware signer rather than a simulator
- **Cross-device blacklist network** — shared threat intelligence across multiple wallets with the AI agent learning from patterns across thousands of devices
- **Mainnet support** — production RPC and real SOL once the hardware signing boundary is hardened

---
