/*
 * cryptX Ledger — Arduino Uno R3  (v4 — LCD + PIN Edition)
 * ───────────────────────────────────────────────────────────────────────
 * Hardware wallet simulator for Solana transactions.
 * Grove LCD RGB Backlight + 2 buttons + EEPROM-backed state machine.
 *
 * HARDWARE
 * ────────
 *   Grove LCD RGB:  I2C (A4=SDA, A5=SCL) — standard Wire
 *   Button 1:       Pin 2, INPUT_PULLUP (active LOW)
 *   Button 2:       Pin 3, INPUT_PULLUP (active LOW)
 *
 * STATE MACHINE
 * ─────────────
 *   INIT        → Awaiting SETID from host
 *   SET_PIN     → User creates 6-digit PIN via buttons
 *   CONFIRM_PIN → User re-enters PIN to confirm
 *   READY       → Idle, waiting for SIGN commands
 *   SIGNING     → PIN entry required to approve transaction
 *   WIPED       → 3 wrong PINs, device wiped, needs RECOVER
 *
 * PIN INPUT
 * ─────────
 *   Digit 1 / 2 is registered on BUTTON RELEASE after a solo press (not on press-edge)
 *   If both buttons are ever down together → ignore until both are released
 *   6 digits → auto-submit.
 *
 * SERIAL PROTOCOL  (115200 baud, newline-terminated)
 * ────────────────────────────────────────────────────
 *   PING            → PONG
 *   STATE           → STATE:<mode>,<id>,<pin_set>,<fails>
 *   SETID <X>       → ID_SAVED + DEVICE:<X> + auto-transition to SET_PIN
 *   MODE <n>        → mode switch (with guards)
 *   SIGN            → PENDING (then PIN entry on device)
 *   CANCEL          → READY
 *   RECOVER         → clears EEPROM, restarts at INIT
 *   CHALLENGE       → NONCE:<8 hex bytes>
 *   AUTH <hex>      → STATS:<c>,<r>,<streak>,<locked>  |  AUTH_FAIL
 *   RESET_STATS     → STATS_RESET
 *   UNLOCK          → UNLOCKED
 *
 * UNSOLICITED OUTPUT (emitted on events)
 * ──────────────────────────────────────
 *   STATE:<mode_name>     on every mode transition
 *   PIN_PROGRESS:<n>      as each PIN digit is entered (0-6)
 *   PIN_OK                PIN accepted
 *   PIN_FAIL:<remaining>  wrong PIN, N attempts left
 *   WIPED                 3 strikes, device wiped
 *   CONFIRMED             transaction approved
 *   REJECTED              transaction rejected (timeout/cancel)
 *
 * EEPROM MEMORY MAP  (all values XOR-encrypted at rest)
 * ────────────────────────────────────────────────────────
 *   0x00  1B  Device state      (0=UNINIT, 1=REGISTERED, 2=PIN_SET)
 *   0x01  1B  Device ID         (char, A-Z)
 *   0x02  6B  PIN digits        (each byte 1 or 2)
 *   0x08  1B  PIN set flag      (0xAA = set)
 *   0x09  1B  Failed PIN attempts (0-3)
 *   0x0A  2B  Total confirms    (uint16 LE)
 *   0x0C  2B  Total rejects     (uint16 LE)
 *   0x0E  1B  Consecutive reject streak
 *   0x0F  1B  Magic byte        (0xCE)
 *
 * SECRET KEY
 * ──────────
 *   Keep the same key in any host tooling that verifies STATS (CHALLENGE/AUTH).
 */

#include <Wire.h>
#include <EEPROM.h>
#include "rgb_lcd.h"

rgb_lcd lcd;

// ── User configuration ────────────────────────────────────────────────────────
#define DEFAULT_ID 'A'

// ── Secret key — keep in sync with host tools that use CHALLENGE/AUTH ────────
static const uint8_t SECRET_KEY[8] = {
  0x4B, 0x72, 0x79, 0x70, 0x74, 0x58, 0x21, 0x01
};

// ── EEPROM addresses ─────────────────────────────────────────────────────────
#define ADDR_DEV_STATE       0x00
#define ADDR_DEVICE_ID       0x01
#define ADDR_PIN_START       0x02   // 6 bytes: 0x02–0x07
#define ADDR_PIN_FLAG        0x08
#define ADDR_PIN_FAILS       0x09
#define ADDR_CONFIRM_COUNT   0x0A   // 2 bytes
#define ADDR_REJECT_COUNT    0x0C   // 2 bytes
#define ADDR_CONSEC_REJECTS  0x0E
#define ADDR_MAGIC           0x0F

#define MAGIC_BYTE           0xCE
#define PIN_SET_FLAG         0xAA
#define PIN_LENGTH           6
#define MAX_PIN_FAILS        3
#define MAX_CONSEC_REJECTS   5

// ── Hardware pins ────────────────────────────────────────────────────────────
#define PIN_BTN1  2
#define PIN_BTN2  3

// ── Timing ───────────────────────────────────────────────────────────────────
#define SIGN_TIMEOUT_MS  30000UL

// ── State machine ────────────────────────────────────────────────────────────
enum Mode {
  MODE_INIT,         // 0
  MODE_SET_PIN,      // 1
  MODE_CONFIRM_PIN,  // 2
  MODE_READY,        // 3
  MODE_SIGNING,      // 4
  MODE_WIPED         // 5
};

Mode          currentMode    = MODE_INIT;
char          deviceId       = DEFAULT_ID;
String        inputBuf       = "";

// PIN entry state
uint8_t       pinBuf[PIN_LENGTH];
uint8_t       pinPos         = 0;
uint8_t       tempPin[PIN_LENGTH];  // holds first entry during confirm flow

// Signing timeout
unsigned long signStartTime  = 0;

// Challenge-response
uint8_t       currentNonce[8];
bool          nonceIssued    = false;

// ═══════════════════════════════════════════════════════════════════════════════
// XOR helpers
// ═══════════════════════════════════════════════════════════════════════════════

uint8_t xorByte(uint8_t value, uint8_t addr) {
  return value ^ SECRET_KEY[addr % 8];
}

uint8_t eepromRead(uint8_t addr) {
  return xorByte(EEPROM.read(addr), addr);
}

void eepromWrite(uint8_t addr, uint8_t value) {
  EEPROM.write(addr, xorByte(value, addr));
}

uint16_t eepromRead16(uint8_t addr) {
  uint8_t lo = eepromRead(addr);
  uint8_t hi = eepromRead(addr + 1);
  return (uint16_t)lo | ((uint16_t)hi << 8);
}

void eepromWrite16(uint8_t addr, uint16_t value) {
  eepromWrite(addr,     (uint8_t)(value & 0xFF));
  eepromWrite(addr + 1, (uint8_t)(value >> 8));
}

// ═══════════════════════════════════════════════════════════════════════════════
// EEPROM init & wipe
// ═══════════════════════════════════════════════════════════════════════════════

void initEEPROM() {
  if (eepromRead(ADDR_MAGIC) != MAGIC_BYTE) {
    wipeEEPROM();
  }
}

void wipeEEPROM() {
  eepromWrite(ADDR_DEV_STATE, 0);
  eepromWrite(ADDR_DEVICE_ID, (uint8_t)DEFAULT_ID);
  for (uint8_t i = 0; i < PIN_LENGTH; i++) {
    eepromWrite(ADDR_PIN_START + i, 0);
  }
  eepromWrite(ADDR_PIN_FLAG, 0);
  eepromWrite(ADDR_PIN_FAILS, 0);
  eepromWrite16(ADDR_CONFIRM_COUNT, 0);
  eepromWrite16(ADDR_REJECT_COUNT, 0);
  eepromWrite(ADDR_CONSEC_REJECTS, 0);
  eepromWrite(ADDR_MAGIC, MAGIC_BYTE);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIN helpers
// ═══════════════════════════════════════════════════════════════════════════════

bool isPinSet() {
  return eepromRead(ADDR_PIN_FLAG) == PIN_SET_FLAG;
}

void savePin(const uint8_t* pin) {
  for (uint8_t i = 0; i < PIN_LENGTH; i++) {
    eepromWrite(ADDR_PIN_START + i, pin[i]);
  }
  eepromWrite(ADDR_PIN_FLAG, PIN_SET_FLAG);
  eepromWrite(ADDR_DEV_STATE, 2);
  eepromWrite(ADDR_PIN_FAILS, 0);
}

bool checkPin(const uint8_t* pin) {
  for (uint8_t i = 0; i < PIN_LENGTH; i++) {
    if (eepromRead(ADDR_PIN_START + i) != pin[i]) return false;
  }
  return true;
}

uint8_t getPinFails() {
  return eepromRead(ADDR_PIN_FAILS);
}

void setPinFails(uint8_t n) {
  eepromWrite(ADDR_PIN_FAILS, n);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stats / audit log
// ═══════════════════════════════════════════════════════════════════════════════

void logConfirm() {
  uint16_t n = eepromRead16(ADDR_CONFIRM_COUNT);
  eepromWrite16(ADDR_CONFIRM_COUNT, n + 1);
  eepromWrite(ADDR_CONSEC_REJECTS, 0);
}

void logReject() {
  uint16_t n = eepromRead16(ADDR_REJECT_COUNT);
  eepromWrite16(ADDR_REJECT_COUNT, n + 1);
  uint8_t streak = eepromRead(ADDR_CONSEC_REJECTS) + 1;
  eepromWrite(ADDR_CONSEC_REJECTS, streak);
}

void resetStats() {
  eepromWrite16(ADDR_CONFIRM_COUNT, 0);
  eepromWrite16(ADDR_REJECT_COUNT, 0);
  eepromWrite(ADDR_CONSEC_REJECTS, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LCD helpers
// ═══════════════════════════════════════════════════════════════════════════════

void lcdClear() {
  lcd.clear();
}

void lcdShow(const char* line1, const char* line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1);
  if (line2) {
    lcd.setCursor(0, 1);
    lcd.print(line2);
  }
}

void lcdShowPinProgress(const char* header, uint8_t filled) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(header);
  lcd.setCursor(0, 1);
  for (uint8_t i = 0; i < PIN_LENGTH; i++) {
    lcd.print(i < filled ? '*' : '_');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mode transitions
// ═══════════════════════════════════════════════════════════════════════════════

const char* modeName(Mode m) {
  switch (m) {
    case MODE_INIT:        return "INIT";
    case MODE_SET_PIN:     return "SET_PIN";
    case MODE_CONFIRM_PIN: return "CONFIRM_PIN";
    case MODE_READY:       return "READY";
    case MODE_SIGNING:     return "SIGNING";
    case MODE_WIPED:       return "WIPED";
    default:               return "UNKNOWN";
  }
}

void enterMode(Mode m) {
  currentMode = m;
  pinPos = 0;

  Serial.print("STATE:");
  Serial.println(modeName(m));

  switch (m) {
    case MODE_INIT:
      lcd.setRGB(255, 165, 0);
      lcdShow("cryptX Ledger", "Awaiting Setup..");
      break;

    case MODE_SET_PIN:
      lcd.setRGB(0, 100, 255);
      lcdShowPinProgress("Create PIN:", 0);
      Serial.println("PIN_PROGRESS:0");
      break;

    case MODE_CONFIRM_PIN:
      lcd.setRGB(0, 100, 255);
      lcdShowPinProgress("Confirm PIN:", 0);
      Serial.println("PIN_PROGRESS:0");
      break;

    case MODE_READY:
      lcd.setRGB(0, 255, 0);
      {
        char line1[17];
        snprintf(line1, sizeof(line1), "Ledger %c Ready", deviceId);
        lcdShow(line1, "Awaiting TX...");
      }
      break;

    case MODE_SIGNING:
      lcd.setRGB(255, 255, 0);
      lcdShowPinProgress("Sign: Enter PIN", 0);
      signStartTime = millis();
      Serial.println("PIN_PROGRESS:0");
      break;

    case MODE_WIPED:
      lcd.setRGB(255, 0, 0);
      lcdShow("!! WIPED !!", "Recover via app");
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Challenge-response (kept from v3)
// ═══════════════════════════════════════════════════════════════════════════════

void generateNonce(uint8_t* nonce) {
  unsigned long t = millis();
  for (uint8_t i = 0; i < 8; i++) {
    nonce[i] = (uint8_t)((t >> ((i % 4) * 8)) ^ (i * 0x5A));
  }
}

uint8_t hexCharToInt(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

bool verifyAuth(const String& hexResponse) {
  if (hexResponse.length() != 16) return false;
  for (uint8_t i = 0; i < 8; i++) {
    char hi = hexResponse.charAt(i * 2);
    char lo = hexResponse.charAt(i * 2 + 1);
    uint8_t val = (uint8_t)((hexCharToInt(hi) << 4) | hexCharToInt(lo));
    uint8_t expected = currentNonce[i] ^ SECRET_KEY[i];
    if (val != expected) return false;
  }
  return true;
}

void printNonce(const uint8_t* nonce) {
  Serial.print("NONCE:");
  for (uint8_t i = 0; i < 8; i++) {
    if (nonce[i] < 0x10) Serial.print("0");
    Serial.print(nonce[i], HEX);
  }
  Serial.println();
}

void printStats() {
  uint16_t confirms = eepromRead16(ADDR_CONFIRM_COUNT);
  uint16_t rejects  = eepromRead16(ADDR_REJECT_COUNT);
  uint8_t  streak   = eepromRead(ADDR_CONSEC_REJECTS);
  uint8_t  locked   = (currentMode == MODE_WIPED) ? 1 : 0;

  Serial.print("STATS:");
  Serial.print(confirms);
  Serial.print(",");
  Serial.print(rejects);
  Serial.print(",");
  Serial.print(streak);
  Serial.print(",");
  Serial.println(locked);
}

void printState() {
  Serial.print("STATE:");
  Serial.print(modeName(currentMode));
  Serial.print(",");
  Serial.print(deviceId);
  Serial.print(",");
  Serial.print(isPinSet() ? "1" : "0");
  Serial.print(",");
  Serial.println(getPinFails());
}

// ═══════════════════════════════════════════════════════════════════════════════
// Button reading — single-button edges only; both pressed together = ignored
// ═══════════════════════════════════════════════════════════════════════════════

// Returns: 0 = nothing, 1 = digit 1, 2 = digit 2
// Release-to-fire: count digit when you *release* a solo button (not on press).
// Chord: both down together → ignore until both are up (arms cleared).
uint8_t readButtons() {
  static bool prevP1 = false;
  static bool prevP2 = false;
  static bool chord  = false;
  static bool arm1   = false;
  static bool arm2   = false;

  bool p1 = (digitalRead(PIN_BTN1) == HIGH);
  bool p2 = (digitalRead(PIN_BTN2) == HIGH);

  if (p1 && p2) {
    chord = true;
    arm1 = arm2 = false;
    prevP1 = p1;
    prevP2 = p2;
    return 0;
  }

  if (chord) {
    if (!p1 && !p2) chord = false;
    prevP1 = p1;
    prevP2 = p2;
    return 0;
  }

  uint8_t out = 0;

  if (p1 && !p2 && !prevP1) arm1 = true;
  if (!p1 && p2 && !prevP2) arm2 = true;

  if (!p1 && prevP1 && arm1 && !p2) {
    out = 1;
    arm1 = false;
  } else if (!p2 && prevP2 && arm2 && !p1) {
    out = 2;
    arm2 = false;
  }

  prevP1 = p1;
  prevP2 = p2;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIN entry — 6th digit auto-finalizes (no dual-button "enter")
// ═══════════════════════════════════════════════════════════════════════════════

void finalizeSixDigitPin() {
  if (currentMode == MODE_SET_PIN) {
    memcpy(tempPin, pinBuf, PIN_LENGTH);
    enterMode(MODE_CONFIRM_PIN);

  } else if (currentMode == MODE_CONFIRM_PIN) {
    bool match = true;
    for (uint8_t i = 0; i < PIN_LENGTH; i++) {
      if (pinBuf[i] != tempPin[i]) { match = false; break; }
    }
    if (match) {
      savePin(pinBuf);
      Serial.println("PIN_OK");
      lcd.setRGB(0, 255, 0);
      lcdShow("PIN Saved!", "");
      delay(1500);
      enterMode(MODE_READY);
    } else {
      Serial.println("PIN_MISMATCH");
      lcd.setRGB(255, 0, 0);
      lcdShow("PINs don't", "match! Retry...");
      delay(2000);
      enterMode(MODE_SET_PIN);
    }

  } else if (currentMode == MODE_SIGNING) {
    if (checkPin(pinBuf)) {
      setPinFails(0);
      logConfirm();
      Serial.println("PIN_OK");
      Serial.println("CONFIRMED");
      lcd.setRGB(0, 255, 0);
      lcdShow("TX Approved!", "");
      delay(2000);
      enterMode(MODE_READY);
    } else {
      uint8_t fails = getPinFails() + 1;
      setPinFails(fails);
      logReject();

      if (fails >= MAX_PIN_FAILS) {
        wipeEEPROM();
        Serial.println("WIPED");
        enterMode(MODE_WIPED);
      } else {
        uint8_t left = MAX_PIN_FAILS - fails;
        Serial.print("PIN_FAIL:");
        Serial.println(left);

        lcd.setRGB(255, 0, 0);
        char msg[17];
        snprintf(msg, sizeof(msg), "Wrong! %d left", left);
        lcdShow("Bad PIN", msg);
        delay(2000);

        pinPos = 0;
        lcd.setRGB(255, 255, 0);
        lcdShowPinProgress("Sign: Enter PIN", 0);
        Serial.println("PIN_PROGRESS:0");
      }
    }
  }
}

void handlePinButton(uint8_t btn) {
  if (btn == 0 || (btn != 1 && btn != 2)) return;
  if (pinPos >= PIN_LENGTH) return;

  pinBuf[pinPos] = btn;
  pinPos++;

  Serial.print("PIN_PROGRESS:");
  Serial.println(pinPos);

  const char* header;
  if (currentMode == MODE_SET_PIN) header = "Create PIN:";
  else if (currentMode == MODE_CONFIRM_PIN) header = "Confirm PIN:";
  else header = "Sign: Enter PIN";

  lcdShowPinProgress(header, pinPos);

  if (pinPos == PIN_LENGTH) {
    finalizeSixDigitPin();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Serial reader
// ═══════════════════════════════════════════════════════════════════════════════

void readSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      inputBuf.trim();
      if (inputBuf.length() > 0) handleCmd(inputBuf);
      inputBuf = "";
    } else if (c != '\r') {
      inputBuf += c;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Command handler
// ═══════════════════════════════════════════════════════════════════════════════

void handleCmd(const String& cmd) {

  if (cmd == "PING") {
    Serial.println("PONG");

  } else if (cmd == "STATE") {
    printState();

  } else if (cmd.startsWith("SETID ") && cmd.length() == 7) {
    char newId = cmd.charAt(6);
    if (newId >= 'A' && newId <= 'Z') {
      deviceId = newId;
      eepromWrite(ADDR_DEVICE_ID, (uint8_t)newId);
      eepromWrite(ADDR_DEV_STATE, 1);  // REGISTERED
      Serial.println("ID_SAVED");
      Serial.print("DEVICE:");
      Serial.println(deviceId);

      if (currentMode == MODE_INIT) {
        char msg[17];
        snprintf(msg, sizeof(msg), "Ledger %c", deviceId);
        lcd.setRGB(0, 255, 0);
        lcdShow(msg, "Registered!");
        delay(1500);
        enterMode(MODE_SET_PIN);
      }
    }

  } else if (cmd.startsWith("MODE ")) {
    int m = cmd.substring(5).toInt();
    switch (m) {
      case 1:
        if (currentMode == MODE_WIPED) {
          Serial.println("ERR:WIPED");
        } else {
          enterMode(MODE_SET_PIN);
        }
        break;
      case 3:
        if (!isPinSet()) {
          Serial.println("ERR:NO_PIN");
        } else {
          enterMode(MODE_READY);
        }
        break;
      default:
        Serial.println("ERR:BAD_MODE");
        break;
    }

  } else if (cmd == "SIGN") {
    if (currentMode == MODE_WIPED) {
      Serial.println("WIPED");
      return;
    }
    if (currentMode != MODE_READY) {
      Serial.println("ERR:NOT_READY");
      return;
    }
    if (!isPinSet()) {
      Serial.println("ERR:NO_PIN");
      return;
    }
    Serial.println("PENDING");
    enterMode(MODE_SIGNING);

  } else if (cmd == "CANCEL") {
    if (currentMode == MODE_SIGNING) {
      Serial.println("REJECTED");
      enterMode(MODE_READY);
    } else {
      Serial.println("READY");
    }

  } else if (cmd == "RECOVER") {
    wipeEEPROM();
    deviceId = DEFAULT_ID;
    Serial.println("RECOVERED");
    enterMode(MODE_INIT);

  } else if (cmd == "CHALLENGE") {
    generateNonce(currentNonce);
    nonceIssued = true;
    printNonce(currentNonce);

  } else if (cmd.startsWith("AUTH ")) {
    if (!nonceIssued) {
      Serial.println("AUTH_FAIL");
      return;
    }
    nonceIssued = false;
    String response = cmd.substring(5);
    response.trim();
    if (verifyAuth(response)) {
      printStats();
    } else {
      Serial.println("AUTH_FAIL");
    }

  } else if (cmd == "RESET_STATS") {
    resetStats();
    Serial.println("STATS_RESET");

  } else if (cmd == "UNLOCK") {
    if (currentMode == MODE_WIPED) {
      wipeEEPROM();
      deviceId = DEFAULT_ID;
      Serial.println("UNLOCKED");
      enterMode(MODE_INIT);
    } else {
      eepromWrite(ADDR_CONSEC_REJECTS, 0);
      Serial.println("UNLOCKED");
      Serial.println("READY");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BTN1, INPUT_PULLUP);
  pinMode(PIN_BTN2, INPUT_PULLUP);

  lcd.begin(16, 2);

  initEEPROM();

  uint8_t storedId = eepromRead(ADDR_DEVICE_ID);
  if (storedId >= 'A' && storedId <= 'Z') {
    deviceId = (char)storedId;
  }

  Serial.print("DEVICE:");
  Serial.println(deviceId);

  uint8_t devState = eepromRead(ADDR_DEV_STATE);

  if (devState >= 2 && isPinSet()) {
    enterMode(MODE_READY);
  } else if (devState >= 1) {
    enterMode(MODE_SET_PIN);
  } else {
    enterMode(MODE_INIT);
  }

  Serial.println("READY");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main loop
// ═══════════════════════════════════════════════════════════════════════════════

void loop() {
  readSerial();

  if (currentMode == MODE_SET_PIN ||
      currentMode == MODE_CONFIRM_PIN ||
      currentMode == MODE_SIGNING) {
    uint8_t btn = readButtons();
    handlePinButton(btn);
  }

  if (currentMode == MODE_SIGNING) {
    if (millis() - signStartTime >= SIGN_TIMEOUT_MS) {
      Serial.println("REJECTED");
      enterMode(MODE_READY);
    }
  }
}
