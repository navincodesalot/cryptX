#include <EEPROM.h>

/*
 * cryptX Ledger — Arduino Uno R3  (v2 — EEPROM Edition)
 * ───────────────────────────────────────────────────────────────────────
 * Physical authorization device for Solana transactions.
 *
 * SETUP BEFORE FLASHING
 * ──────────────────────
 *   Board #1:  set  DEFAULT_ID 'A'    (default, no change needed)
 *   Board #2:  set  DEFAULT_ID 'B'    (change the line below)
 *   After first flash the ID is stored in EEPROM and can be changed
 *   over Serial with:  SETID X   (no reflash needed)
 *
 * BUTTON (optional)
 * ──────────────────────────────
 *   AUTO_CONFIRM 1  → no button needed; auto-confirms after a short delay
 *   AUTO_CONFIRM 0  → physical button required
 *     Wiring: Pin 2 → GND  (built-in pull-up, no extra resistor)
 *     Single click  = CONFIRM
 *     Double click  (< 500 ms apart) = REJECT
 *
 * SERIAL PROTOCOL  (115200 baud, newline-terminated)
 * ────────────────────────────────────────────────────
 *   Host → Device:
 *     PING               → PONG
 *     SIGN               → PENDING  (then CONFIRMED | REJECTED | LOCKED)
 *     CANCEL             → READY
 *     SETID <X>          → ID_SAVED  (X = single letter A-Z)
 *     STATS              → STATS:<confirms>,<rejects>,<streak>,<locked>
 *     RESET_STATS        → STATS_RESET
 *     UNLOCK             → UNLOCKED
 *
 *   Device → Host:
 *     PONG | DEVICE:<id> | READY | PENDING | CONFIRMED | REJECTED |
 *     LOCKED | ID_SAVED | STATS:<c>,<r>,<streak>,<locked> |
 *     STATS_RESET | UNLOCKED
 *
 * EEPROM MEMORY MAP
 * ──────────────────
 *   0x00  (2B)  Total confirm count    (uint16)
 *   0x02  (2B)  Total reject count     (uint16)
 *   0x04  (1B)  Consecutive reject streak (uint8)
 *   0x05  (1B)  Lockout flag            (uint8, 0x01 = locked)
 *   0x06  (1B)  Device ID              (char, A-Z)
 *   0x07  (1B)  Magic byte             (0xCE = initialized)
 *   0x08-0x3FF  Reserved / future use
 */

#include <EEPROM.h>

// ── Configuration ─────────────────────────────────────────────────────────────
#define DEFAULT_ID    'A'   // <- Change to 'B' on the second board
#define AUTO_CONFIRM   1    // 1 = no button needed  |  0 = require button press

// ── EEPROM addresses ──────────────────────────────────────────────────────────
#define ADDR_CONFIRM_COUNT   0   // uint16  -- total confirmed transactions
#define ADDR_REJECT_COUNT    2   // uint16  -- total rejected transactions
#define ADDR_CONSEC_REJECTS  4   // uint8   -- consecutive reject streak
#define ADDR_LOCKOUT         5   // uint8   -- 0x01 = device locked
#define ADDR_DEVICE_ID       6   // char    -- 'A'-'Z'
#define ADDR_MAGIC           7   // uint8   -- 0xCE proves EEPROM was initialized

#define MAGIC_BYTE           0xCE
#define MAX_CONSEC_REJECTS   5   // lock device after this many consecutive rejects

// ── Auto-confirm delay (only when AUTO_CONFIRM 1) ─────────────────────────────
const unsigned long AUTO_DELAY_MS   = 600UL;

// ── Button settings (only when AUTO_CONFIRM 0) ────────────────────────────────
const int           PIN_BUTTON       = 2;
const unsigned long SIGN_TIMEOUT_MS  = 30000UL;
const unsigned long DOUBLE_CLICK_MS  = 500UL;

// ── Runtime state ─────────────────────────────────────────────────────────────
enum DeviceState { IDLE, PENDING_SIGN };
DeviceState   deviceState = IDLE;
unsigned long pendingTs   = 0;
String        inputBuf    = "";
char          deviceId    = DEFAULT_ID;   // loaded from EEPROM at boot

#if !AUTO_CONFIRM
  unsigned long firstClickTs       = 0;
  bool          waitingSecondClick = false;
#endif

// =============================================================================
// EEPROM helpers
// =============================================================================

void initEEPROM() {
  if (EEPROM.read(ADDR_MAGIC) != MAGIC_BYTE) {
    // First boot -- write defaults
    EEPROM.put(ADDR_CONFIRM_COUNT,  (uint16_t)0);
    EEPROM.put(ADDR_REJECT_COUNT,   (uint16_t)0);
    EEPROM.write(ADDR_CONSEC_REJECTS, 0);
    EEPROM.write(ADDR_LOCKOUT,        0);
    EEPROM.write(ADDR_DEVICE_ID,      (uint8_t)DEFAULT_ID);
    EEPROM.write(ADDR_MAGIC,          MAGIC_BYTE);
  }
  // Load device ID from EEPROM (may have been changed via SETID)
  char stored = (char)EEPROM.read(ADDR_DEVICE_ID);
  if (stored >= 'A' && stored <= 'Z') {
    deviceId = stored;
  }
}

// ── Audit log helpers ─────────────────────────────────────────────────────────

void logConfirm() {
  uint16_t n;
  EEPROM.get(ADDR_CONFIRM_COUNT, n);
  EEPROM.put(ADDR_CONFIRM_COUNT, (uint16_t)(n + 1));
  // Confirmed -> reset the consecutive-reject streak
  EEPROM.write(ADDR_CONSEC_REJECTS, 0);
}

void logReject() {
  uint16_t n;
  EEPROM.get(ADDR_REJECT_COUNT, n);
  EEPROM.put(ADDR_REJECT_COUNT, (uint16_t)(n + 1));

  // Increment consecutive-reject streak and check for lockout
  uint8_t streak = EEPROM.read(ADDR_CONSEC_REJECTS) + 1;
  EEPROM.write(ADDR_CONSEC_REJECTS, streak);
  if (streak >= MAX_CONSEC_REJECTS) {
    EEPROM.write(ADDR_LOCKOUT, 0x01);
  }
}

bool isLockedOut() {
  return EEPROM.read(ADDR_LOCKOUT) == 0x01;
}

void unlock() {
  EEPROM.write(ADDR_LOCKOUT, 0x00);
  EEPROM.write(ADDR_CONSEC_REJECTS, 0);
}

void resetStats() {
  EEPROM.put(ADDR_CONFIRM_COUNT,    (uint16_t)0);
  EEPROM.put(ADDR_REJECT_COUNT,     (uint16_t)0);
  EEPROM.write(ADDR_CONSEC_REJECTS, 0);
  EEPROM.write(ADDR_LOCKOUT,        0);
}

// ── Print stats line ──────────────────────────────────────────────────────────
void printStats() {
  uint16_t confirms, rejects;
  EEPROM.get(ADDR_CONFIRM_COUNT, confirms);
  EEPROM.get(ADDR_REJECT_COUNT,  rejects);
  uint8_t streak = EEPROM.read(ADDR_CONSEC_REJECTS);
  uint8_t locked = EEPROM.read(ADDR_LOCKOUT);

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

  // Announce identity so the bridge can auto-identify this board
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
    // Auto-confirm after short delay (no button needed)
    if (millis() - pendingTs >= AUTO_DELAY_MS) {
      doConfirm();
    }

#else
    // ── Physical button mode ────────────────────────────────────────────────
    if (digitalRead(PIN_BUTTON) == LOW) {
      delay(40);  // debounce
      if (digitalRead(PIN_BUTTON) == LOW) {
        unsigned long now = millis();

        if (waitingSecondClick && (now - firstClickTs < DOUBLE_CLICK_MS)) {
          // Double-click -> REJECT
          waitingSecondClick = false;
          doReject();
        } else {
          // First click -> start double-click window
          firstClickTs       = now;
          waitingSecondClick = true;
        }

        while (digitalRead(PIN_BUTTON) == LOW) {}  // wait for release
      }
    }

    // Single-click window expired -> CONFIRM
    if (waitingSecondClick && (millis() - firstClickTs >= DOUBLE_CLICK_MS)) {
      waitingSecondClick = false;
      doConfirm();
    }

    // Overall timeout -> REJECT
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

  // ── PING ──────────────────────────────────────────────────────────────────
  if (cmd == "PING") {
    Serial.println("PONG");

  // ── SIGN ──────────────────────────────────────────────────────────────────
  } else if (cmd == "SIGN") {
    if (isLockedOut()) {
      Serial.println("LOCKED");   // device is locked -- unlock required
      return;
    }
    deviceState = PENDING_SIGN;
    pendingTs   = millis();
#if !AUTO_CONFIRM
    waitingSecondClick = false;
#endif
    Serial.println("PENDING");

  // ── CANCEL ────────────────────────────────────────────────────────────────
  } else if (cmd == "CANCEL") {
    deviceState = IDLE;
#if !AUTO_CONFIRM
    waitingSecondClick = false;
#endif
    Serial.println("READY");

  // ── SETID <X>  -- change device ID without reflashing ──────────────────────
  } else if (cmd.startsWith("SETID ") && cmd.length() == 7) {
    char newId = cmd.charAt(6);
    if (newId >= 'A' && newId <= 'Z') {
      deviceId = newId;
      EEPROM.write(ADDR_DEVICE_ID, (uint8_t)newId);
      Serial.println("ID_SAVED");
      // Re-announce so the bridge updates
      Serial.print("DEVICE:");
      Serial.println(deviceId);
    }

  // ── STATS -- return audit counters ─────────────────────────────────────────
  } else if (cmd == "STATS") {
    printStats();

  // ── RESET_STATS -- zero the audit log ──────────────────────────────────────
  } else if (cmd == "RESET_STATS") {
    resetStats();
    Serial.println("STATS_RESET");

  // ── UNLOCK -- clear the lockout flag ───────────────────────────────────────
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
  // If the reject caused a lockout, tell the host immediately
  if (isLockedOut()) {
    Serial.println("LOCKED");
  } else {
    Serial.println("REJECTED");
  }
}
