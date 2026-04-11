/*
 * cryptX Ledger — Arduino Uno R3  (v3 — Protected EEPROM Edition)
 * ───────────────────────────────────────────────────────────────────────
 * Physical authorization device for Solana transactions.
 *
 * SECURITY MODEL
 * ───────────────
 * 1. EEPROM DATA IS XOR-SCRAMBLED at rest.
 *    All 8 bytes of the cryptX map region are XORed with a rotating
 *    8-byte key (SECRET_KEY) before writing, and decrypted on read.
 *    A raw forensic dump will show garbage instead of real values.
 *
 * 2. STATS COMMAND REQUIRES CHALLENGE-RESPONSE.
 *    The host must prove it knows SECRET_KEY before the device will
 *    return decoded stats.  Protocol:
 *      Host  → CHALLENGE
 *      Device→ NONCE:<8 hex bytes>   (random-ish, millis-seeded)
 *      Host  → AUTH:<8 hex bytes>    (nonce XORed with SECRET_KEY)
 *      Device→ STATS:<c>,<r>,<streak>,<locked>   or   AUTH_FAIL
 *
 *    Any other client (e.g. a raw serial terminal or forensic tool
 *    that doesn't know the key) cannot read the real counters.
 *
 * 3. EEPROM DUMPER SKETCH will show encrypted bytes, not plaintext.
 *    The companion forensic script (cryptx_dump.py) can decrypt it
 *    IF it has the same key — demonstrating the forensics workflow.
 *
 * KEY CONFIGURATION
 * ──────────────────
 * Change SECRET_KEY to any 8 bytes you want.
 * The same key must be set in:
 *   - serial-bridge/bridge.mjs  (SECRET_KEY constant)
 *   - forensics/cryptx_dump.py  (XOR_KEY constant)
 *
 * SETUP BEFORE FLASHING
 * ──────────────────────
 *   Board #1:  set  DEFAULT_ID 'A'    (default)
 *   Board #2:  set  DEFAULT_ID 'B'
 *   After first flash the ID is in EEPROM — use SETID to change.
 *
 * BUTTON
 * ──────────────────────────────
 *   AUTO_CONFIRM 1  → auto-confirms after AUTO_DELAY_MS
 *   AUTO_CONFIRM 0  → physical button on Pin 2
 *     Single click = CONFIRM,  Double click (< 500ms) = REJECT
 *
 * SERIAL PROTOCOL  (115200 baud, newline-terminated)
 * ────────────────────────────────────────────────────
 *   PING            → PONG
 *   SIGN            → PENDING → CONFIRMED | REJECTED | LOCKED
 *   CANCEL          → READY
 *   SETID <X>       → ID_SAVED  (X = A-Z)
 *   CHALLENGE       → NONCE:<8 hex bytes>
 *   AUTH <8 hex>    → STATS:<c>,<r>,<streak>,<locked>  |  AUTH_FAIL
 *   RESET_STATS     → STATS_RESET   (no auth required — physical access only)
 *   UNLOCK          → UNLOCKED
 *
 * EEPROM MEMORY MAP  (all values XOR-encrypted at rest)
 * ────────────────────────────────────────────────────────
 *   0x00  2B  Total confirm count  (uint16, little-endian)
 *   0x02  2B  Total reject count   (uint16, little-endian)
 *   0x04  1B  Consecutive rejects  (uint8)
 *   0x05  1B  Lockout flag         (uint8, 0x01 = locked)
 *   0x06  1B  Device ID            (char, A-Z)
 *   0x07  1B  Magic byte           (0xCE after XOR decode)
 *   0x08+     Reserved
 */

#include <EEPROM.h>

// ── User configuration ────────────────────────────────────────────────────────
#define DEFAULT_ID    'A'   // <- Change to 'B' on the second board
#define AUTO_CONFIRM   1    // 1 = no button  |  0 = require button

// ── Secret key — CHANGE THIS, keep in sync with bridge.mjs + cryptx_dump.py ──
static const uint8_t SECRET_KEY[8] = {
  0x4B, 0x72, 0x79, 0x70, 0x74, 0x58, 0x21, 0x01  // "KryptX!"+0x01
};

// ── EEPROM addresses ──────────────────────────────────────────────────────────
#define ADDR_CONFIRM_COUNT   0
#define ADDR_REJECT_COUNT    2
#define ADDR_CONSEC_REJECTS  4
#define ADDR_LOCKOUT         5
#define ADDR_DEVICE_ID       6
#define ADDR_MAGIC           7

#define MAGIC_BYTE           0xCE
#define MAX_CONSEC_REJECTS   5

// ── Timing ────────────────────────────────────────────────────────────────────
const unsigned long AUTO_DELAY_MS   = 600UL;
const int           PIN_BUTTON       = 2;
const unsigned long SIGN_TIMEOUT_MS  = 30000UL;
const unsigned long DOUBLE_CLICK_MS  = 500UL;

// ── State ─────────────────────────────────────────────────────────────────────
enum DeviceState { IDLE, PENDING_SIGN, AWAIT_AUTH };
DeviceState   deviceState = IDLE;
unsigned long pendingTs   = 0;
String        inputBuf    = "";
char          deviceId    = DEFAULT_ID;

// Challenge-response state
uint8_t       currentNonce[8];
bool          nonceIssued = false;

#if !AUTO_CONFIRM
  unsigned long firstClickTs       = 0;
  bool          waitingSecondClick = false;
#endif

// =============================================================================
// XOR helpers — encrypt/decrypt a single EEPROM byte
// =============================================================================

// XOR a value at a given address with the rotating key
uint8_t xorByte(uint8_t value, uint8_t addr) {
  return value ^ SECRET_KEY[addr % 8];
}

// =============================================================================
// EEPROM read/write (transparently encrypted)
// =============================================================================

uint8_t eepromRead(uint8_t addr) {
  return xorByte(EEPROM.read(addr), addr);
}

void eepromWrite(uint8_t addr, uint8_t value) {
  EEPROM.write(addr, xorByte(value, addr));
}

// uint16 helpers (little-endian, both bytes encrypted individually)
uint16_t eepromRead16(uint8_t addr) {
  uint8_t lo = eepromRead(addr);
  uint8_t hi = eepromRead(addr + 1);
  return (uint16_t)lo | ((uint16_t)hi << 8);
}

void eepromWrite16(uint8_t addr, uint16_t value) {
  eepromWrite(addr,     (uint8_t)(value & 0xFF));
  eepromWrite(addr + 1, (uint8_t)(value >> 8));
}

// =============================================================================
// EEPROM init
// =============================================================================

void initEEPROM() {
  // Check magic byte (stored encrypted — if it decodes to MAGIC_BYTE we're good)
  if (eepromRead(ADDR_MAGIC) != MAGIC_BYTE) {
    // First boot: write defaults (will be XOR'd before storage)
    eepromWrite16(ADDR_CONFIRM_COUNT,  0);
    eepromWrite16(ADDR_REJECT_COUNT,   0);
    eepromWrite(ADDR_CONSEC_REJECTS,   0);
    eepromWrite(ADDR_LOCKOUT,          0);
    eepromWrite(ADDR_DEVICE_ID,        (uint8_t)DEFAULT_ID);
    eepromWrite(ADDR_MAGIC,            MAGIC_BYTE);
  }
  // Load device ID
  uint8_t stored = eepromRead(ADDR_DEVICE_ID);
  if (stored >= 'A' && stored <= 'Z') {
    deviceId = (char)stored;
  }
}

// =============================================================================
// Audit log
// =============================================================================

void logConfirm() {
  uint16_t n = eepromRead16(ADDR_CONFIRM_COUNT);
  eepromWrite16(ADDR_CONFIRM_COUNT, n + 1);
  eepromWrite(ADDR_CONSEC_REJECTS, 0);  // reset streak on confirm
}

void logReject() {
  uint16_t n = eepromRead16(ADDR_REJECT_COUNT);
  eepromWrite16(ADDR_REJECT_COUNT, n + 1);
  uint8_t streak = eepromRead(ADDR_CONSEC_REJECTS) + 1;
  eepromWrite(ADDR_CONSEC_REJECTS, streak);
  if (streak >= MAX_CONSEC_REJECTS) {
    eepromWrite(ADDR_LOCKOUT, 0x01);
  }
}

bool isLockedOut() {
  return eepromRead(ADDR_LOCKOUT) == 0x01;
}

void unlock() {
  eepromWrite(ADDR_LOCKOUT, 0x00);
  eepromWrite(ADDR_CONSEC_REJECTS, 0);
}

void resetStats() {
  eepromWrite16(ADDR_CONFIRM_COUNT, 0);
  eepromWrite16(ADDR_REJECT_COUNT,  0);
  eepromWrite(ADDR_CONSEC_REJECTS,  0);
  eepromWrite(ADDR_LOCKOUT,         0);
}

// =============================================================================
// Challenge-response helpers
// =============================================================================

// Generate a nonce from millis() spread across 8 bytes
void generateNonce(uint8_t* nonce) {
  unsigned long t = millis();
  // Mix millis with address-based XOR for more variety
  for (uint8_t i = 0; i < 8; i++) {
    nonce[i] = (uint8_t)((t >> ((i % 4) * 8)) ^ (i * 0x5A));
  }
}

// Verify the response: host should send nonce[i] XOR SECRET_KEY[i]
bool verifyAuth(const String& hexResponse) {
  if (hexResponse.length() != 16) return false;  // 8 bytes = 16 hex chars
  for (uint8_t i = 0; i < 8; i++) {
    // Parse two hex chars
    char hi = hexResponse.charAt(i * 2);
    char lo = hexResponse.charAt(i * 2 + 1);
    uint8_t val = (uint8_t)((hexCharToInt(hi) << 4) | hexCharToInt(lo));
    uint8_t expected = currentNonce[i] ^ SECRET_KEY[i];
    if (val != expected) return false;
  }
  return true;
}

uint8_t hexCharToInt(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

// Print nonce as hex
void printNonce(const uint8_t* nonce) {
  Serial.print("NONCE:");
  for (uint8_t i = 0; i < 8; i++) {
    if (nonce[i] < 0x10) Serial.print("0");
    Serial.print(nonce[i], HEX);
  }
  Serial.println();
}

// Print stats (only called after successful auth)
void printStats() {
  uint16_t confirms = eepromRead16(ADDR_CONFIRM_COUNT);
  uint16_t rejects  = eepromRead16(ADDR_REJECT_COUNT);
  uint8_t  streak   = eepromRead(ADDR_CONSEC_REJECTS);
  uint8_t  locked   = eepromRead(ADDR_LOCKOUT);

  Serial.print("STATS:");
  Serial.print(confirms);
  Serial.print(",");
  Serial.print(rejects);
  Serial.print(",");
  Serial.print(streak);
  Serial.print(",");
  Serial.println(locked);
}

// =============================================================================
// Setup
// =============================================================================

void setup() {
  Serial.begin(115200);

#if !AUTO_CONFIRM
  pinMode(PIN_BUTTON, INPUT_PULLUP);
#endif

  initEEPROM();

  Serial.print("DEVICE:");
  Serial.println(deviceId);
  Serial.println("READY");
}

// =============================================================================
// Main loop
// =============================================================================

void loop() {
  readSerial();

  if (deviceState == PENDING_SIGN) {

#if AUTO_CONFIRM
    if (millis() - pendingTs >= AUTO_DELAY_MS) {
      doConfirm();
    }
#else
    if (digitalRead(PIN_BUTTON) == LOW) {
      delay(40);
      if (digitalRead(PIN_BUTTON) == LOW) {
        unsigned long now = millis();
        if (waitingSecondClick && (now - firstClickTs < DOUBLE_CLICK_MS)) {
          waitingSecondClick = false;
          doReject();
        } else {
          firstClickTs       = now;
          waitingSecondClick = true;
        }
        while (digitalRead(PIN_BUTTON) == LOW) {}
      }
    }

    if (waitingSecondClick && (millis() - firstClickTs >= DOUBLE_CLICK_MS)) {
      waitingSecondClick = false;
      doConfirm();
    }

    if (millis() - pendingTs >= SIGN_TIMEOUT_MS) {
      waitingSecondClick = false;
      doReject();
    }
#endif

  }
}

// =============================================================================
// Serial reader
// =============================================================================

void readSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      inputBuf.trim();
      handleCmd(inputBuf);
      inputBuf = "";
    } else if (c != '\r') {
      inputBuf += c;
    }
  }
}

// =============================================================================
// Command handler
// =============================================================================

void handleCmd(const String& cmd) {

  if (cmd == "PING") {
    Serial.println("PONG");

  } else if (cmd == "SIGN") {
    if (isLockedOut()) { Serial.println("LOCKED"); return; }
    deviceState = PENDING_SIGN;
    pendingTs   = millis();
#if !AUTO_CONFIRM
    waitingSecondClick = false;
#endif
    Serial.println("PENDING");

  } else if (cmd == "CANCEL") {
    deviceState = IDLE;
#if !AUTO_CONFIRM
    waitingSecondClick = false;
#endif
    Serial.println("READY");

  } else if (cmd.startsWith("SETID ") && cmd.length() == 7) {
    char newId = cmd.charAt(6);
    if (newId >= 'A' && newId <= 'Z') {
      deviceId = newId;
      eepromWrite(ADDR_DEVICE_ID, (uint8_t)newId);
      Serial.println("ID_SAVED");
      Serial.print("DEVICE:");
      Serial.println(deviceId);
    }

  // ── Challenge-response auth for STATS ──────────────────────────────────────
  } else if (cmd == "CHALLENGE") {
    generateNonce(currentNonce);
    nonceIssued = true;
    printNonce(currentNonce);

  } else if (cmd.startsWith("AUTH ")) {
    if (!nonceIssued) {
      Serial.println("AUTH_FAIL");  // must request CHALLENGE first
      return;
    }
    nonceIssued = false;  // nonce is one-use only
    String response = cmd.substring(5);
    response.trim();
    if (verifyAuth(response)) {
      printStats();
    } else {
      Serial.println("AUTH_FAIL");
    }

  // ── These don't need auth (require physical access to device) ──────────────
  } else if (cmd == "RESET_STATS") {
    resetStats();
    Serial.println("STATS_RESET");

  } else if (cmd == "UNLOCK") {
    unlock();
    Serial.println("UNLOCKED");
    Serial.println("READY");
  }
}

// =============================================================================
// Confirm / Reject
// =============================================================================

void doConfirm() {
  deviceState = IDLE;
  logConfirm();
  Serial.println("CONFIRMED");
}

void doReject() {
  deviceState = IDLE;
  logReject();
  if (isLockedOut()) {
    Serial.println("LOCKED");
  } else {
    Serial.println("REJECTED");
  }
}
