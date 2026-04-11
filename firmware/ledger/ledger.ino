/*
 * cryptX Ledger — Arduino Uno R3  (v5 — SipHash AUTH + derived keys)
 * ───────────────────────────────────────────────────────────────────────────
 * Hardware wallet simulator for Solana transactions.
 * Grove LCD RGB Backlight + 2 buttons + EEPROM-backed state machine.
 *
 * LOCK / FUSE BITS (ATmega328P — not set from sketch; verify in datasheet)
 * ───────────────────────────────────────────────────────────────────────────
 * Without lock bits firmware can be dumped and any obfuscation is recoverable.
 * After programming set lock bits with avrdude / Atmel Studio / Arduino-as-ISP
 * per Microchip ATmega328P datasheet "Memory Programming" (Lock Bits).
 * Example workflow only — WRONG VALUES CAN DISABLE ISP OR BRICK THE CHIP:
 *   avrdude -c usbasp -p m328p -U lock:w:0xCF:m
 * Always confirm the hex mask against your programmer and the current datasheet.
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
 *   SEED_BACKUP → Seed generated & sent; waiting for host SEED_ACK before PIN setup
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
 *   On boot / META: META:SIG=<6 hex>;SALT=<16 hex>  (host stores for AUTH)
 *   PING            → PONG
 *   STATE           → STATE:<mode>,<id>,<pin_set>,<fails>
 *   SETID <X>       → ID_SAVED | ERR:ID_LOCKED | ERR:BAD_ID
 *   SEED_ACK        → SEED_ACKED (MODE_SEED_BACKUP only) then enters SET_PIN
 *   MODE <n>        → mode switch (with guards)
 *   SIGN            → PENDING (then PIN entry on device)
 *   CANCEL          → READY  (same as holding both buttons 5s while SIGNING)
 *   RECOVER         → clears EEPROM, restarts at INIT (requires prior SEED_OK)
 *   SEED_VERIFY     → start 12-word index check (MODE_WIPED only)
 *   SVI <0-2047>    → submit one expected word index (after SEED_VERIFY); 12th match → SEED_OK
 *   CHALLENGE       → NONCE:<8 hex bytes>
 *   AUTH <hex>      → STATS:<c>,<r>,<streak>,<locked>  |  AUTH_FAIL  |  AUTH_LOCKOUT
 *   RESET_STATS     → STATS_RESET
 *   UNLOCK          → UNLOCKED  (WIPED: same as RECOVER — needs SEED_OK first)
 *
 *   After SETID (new registration), device prints:
 *     SEED_BEGIN / SEED_IDX:<0-2047> ×12 / SEED_END  (indices = BIP-39 English list)
 *   SEED_VERIFY     → SVI_READY  (MODE_WIPED + seed stored)
 *   SVI <n>         → SVI_NEXT ×11 then SEED_OK  |  SEED_BAD on wrong index
 *
 * AUTH: host sends SipHash-2-4(authKey, nonce_8_bytes) as 16 hex chars.
 * authKey is derived from chip signature + EEPROM salt + device id + runtime
 * peppers (see src/lib/ledgerSipAuth.ts — keep in sync).
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
 *   SIGN_CANCEL:<n>       during SIGNING, hold-to-cancel countdown (n = 5…1 sec left)
 *   SIGN_CANCEL_ABORT     released buttons before cancel completed
 *
 * EEPROM MEMORY MAP  (v5)
 * ──────────────────────────────────────────────────────────────────────────
 *   Plaintext:       0x0F magic (0xCC), 0x10–0x17 per-device salt
 *   XOR-masked (mask from SipHash(sig+salt, storage peppers)): all other addrs
 *
 *   0x00  1B  Device state      (0=UNINIT, 1=REGISTERED, 2=PIN_SET)
 *   0x01  1B  Device ID         (char, A-Z)
 *   0x02  6B  PIN digits        (each byte 1 or 2)
 *   0x08  1B  PIN set flag      (0xAA = set)
 *   0x09  1B  Failed PIN attempts (0-3)
 *   0x0A  2B  Total confirms    (uint16 LE)
 *   0x0C  2B  Total rejects     (uint16 LE)
 *   0x0E  1B  Consecutive reject streak
 *   0x0F  1B  Magic byte        (0xCC) — plaintext
 *   0x10  8B  Per-device salt   — plaintext
 *   0x18  1B  AUTH fail counter
 *   0x19  1B  Seed set flag    (0xAA = 12 word indices stored) — plaintext
 *   0x1A  24B 12× uint16 LE BIP39 word indices (0–2047) — plaintext (survives PIN wipe)
 *
 * SECRET KEY
 * ──────────
 *   Keys are derived at runtime from chip signature + EEPROM salt + peppers.
 *   See loadPepperK0 / loadPepperK1 — keep in sync with src/lib/ledgerSipAuth.ts
 */

#include <Wire.h>
#include <EEPROM.h>
#include <stdint.h>
#include <avr/boot.h>
#include "rgb_lcd.h"

rgb_lcd lcd;

// ── User configuration ────────────────────────────────────────────────────────
#define DEFAULT_ID 'A'

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
#define ADDR_SALT_START      0x10   // 8 bytes: 0x10–0x17  (plaintext)
#define ADDR_SALT_END        0x17
#define ADDR_AUTH_FAILS      0x18
#define ADDR_SEED_FLAG       0x19
#define ADDR_SEED_IDX0       0x1A   // 12 × uint16 LE → …0x31

#define MAGIC_BYTE           0xCC
#define SEED_SET_FLAG        0xAA
#define PIN_SET_FLAG         0xAA
#define PIN_LENGTH           6
#define MAX_PIN_FAILS        3
#define MAX_CONSEC_REJECTS   5
#define MAX_AUTH_FAILS       10

// ── Hardware pins ────────────────────────────────────────────────────────────
#define PIN_BTN1  2
#define PIN_BTN2  3

// ── Timing ───────────────────────────────────────────────────────────────────
#define SIGN_TIMEOUT_MS     30000UL
#define SIGN_HOLD_CANCEL_MS 5000UL   // both buttons held (pins LOW) → cancel TX

// ── State machine ────────────────────────────────────────────────────────────
enum Mode {
  MODE_INIT,         // 0
  MODE_SET_PIN,      // 1
  MODE_CONFIRM_PIN,  // 2
  MODE_READY,        // 3
  MODE_SIGNING,      // 4
  MODE_WIPED,        // 5
  MODE_SEED_BACKUP   // 6 — seed generated, waiting for host SEED_ACK before allowing PIN setup
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

// Seed phrase (12 BIP39 word indices 0–2047, stored plaintext in EEPROM)
bool          recoverSeedOk  = false;
bool          sviActive      = false;
uint8_t       sviCount       = 0;

// Derived keys (rebuilt from sig + salt + peppers at runtime)
uint8_t       gStorageKey[16];
uint8_t       gAuthKey[16];
uint8_t       gChipSig[3];

// Forward declaration
void enterMode(Mode m);

// ═══════════════════════════════════════════════════════════════════════════════
// SipHash-2-4 (64-bit) — must match src/lib/ledgerSipAuth.ts
// ═══════════════════════════════════════════════════════════════════════════════

static uint64_t rotl64(uint64_t x, uint8_t b) {
  return (x << b) | (x >> (64 - b));
}

static void sipround(uint64_t* v0, uint64_t* v1, uint64_t* v2, uint64_t* v3) {
  uint64_t a = *v0, b = *v1, c = *v2, d = *v3;
  a += b; b = rotl64(b, 13); b ^= a; a = rotl64(a, 32);
  c += d; d = rotl64(d, 16); d ^= c;
  a += d; d = rotl64(d, 21); d ^= a;
  c += b; b = rotl64(b, 17); b ^= c; c = rotl64(c, 32);
  *v0 = a; *v1 = b; *v2 = c; *v3 = d;
}

static uint64_t u8to64_le(const uint8_t* p) {
  uint64_t v = 0;
  for (uint8_t i = 0; i < 8; i++) v |= (uint64_t)p[i] << (8 * i);
  return v;
}

static void u64_to_le(uint64_t x, uint8_t* p) {
  for (uint8_t i = 0; i < 8; i++) {
    p[i] = (uint8_t)(x & 0xFF);
    x >>= 8;
  }
}

static uint64_t cx_siphash24(const uint8_t* key16, const uint8_t* msg, uint8_t len) {
  uint64_t k0 = u8to64_le(key16);
  uint64_t k1 = u8to64_le(key16 + 8);
  uint64_t v0 = k0 ^ 0x736f6d6570736575ULL;
  uint64_t v1 = k1 ^ 0x646f72616e646f6dULL;
  uint64_t v2 = k0 ^ 0x6c7967656e657261ULL;
  uint64_t v3 = k1 ^ 0x7465646279746573ULL;

  uint8_t off  = 0;
  uint8_t left = len & 7;
  uint8_t end  = len - left;

  while (off < end) {
    uint64_t mi = u8to64_le(msg + off);
    v3 ^= mi;
    sipround(&v0, &v1, &v2, &v3);
    sipround(&v0, &v1, &v2, &v3);
    v0 ^= mi;
    off += 8;
  }

  uint64_t b = (uint64_t)len << 56;
  for (uint8_t i = 0; i < left; i++) {
    b |= (uint64_t)msg[off + i] << (8 * i);
  }
  v3 ^= b;
  sipround(&v0, &v1, &v2, &v3);
  sipround(&v0, &v1, &v2, &v3);
  v0 ^= b;
  v2 ^= 0xFF;
  sipround(&v0, &v1, &v2, &v3);
  sipround(&v0, &v1, &v2, &v3);
  sipround(&v0, &v1, &v2, &v3);
  sipround(&v0, &v1, &v2, &v3);
  return v0 ^ v1 ^ v2 ^ v3;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Peppers — keep in sync with src/lib/ledgerSipAuth.ts
// ═══════════════════════════════════════════════════════════════════════════════

void loadPepperK0(uint8_t k[16]) {
  const uint8_t s[] = { 0x4B, 0x72, 0x79, 0x70, 0x74, 0x58, 0x21, 0x01 };
  for (uint8_t i = 0; i < 16; i++) k[i] = s[i % 8] ^ (i * 17 + 3);
}

void loadPepperK1(uint8_t k[16]) {
  const uint8_t s[] = { 0x58, 0x21, 0x4B, 0x01, 0x72, 0x79, 0x70, 0x74 };
  for (uint8_t i = 0; i < 16; i++) k[i] = s[i % 8] ^ (i * 31 + 5);
}

void loadPepperStorage0(uint8_t k[16]) {
  const uint8_t s[] = { 0x70, 0x74, 0x58, 0x21, 0x4B, 0x72, 0x79, 0x01 };
  for (uint8_t i = 0; i < 16; i++) k[i] = s[i % 8] ^ (i * 13 + 7);
}

void loadPepperStorage1(uint8_t k[16]) {
  const uint8_t s[] = { 0x79, 0x01, 0x58, 0x74, 0x70, 0x4B, 0x72, 0x21 };
  for (uint8_t i = 0; i < 16; i++) k[i] = s[i % 8] ^ (i * 11 + 2);
}

// ── Chip signature + salt ─────────────────────────────────────────────────────

void readDeviceSignature(uint8_t sig[3]) {
  sig[0] = boot_signature_byte_get(0);
  sig[1] = boot_signature_byte_get(1);
  sig[2] = boot_signature_byte_get(2);
}

void readSaltPlain(uint8_t salt[8]) {
  for (uint8_t i = 0; i < 8; i++) salt[i] = EEPROM.read(ADDR_SALT_START + i);
}

// ── Key derivation ────────────────────────────────────────────────────────────

void buildMaterialStorage(uint8_t buf[16], const uint8_t sig[3], const uint8_t salt[8]) {
  buf[0] = sig[0]; buf[1] = sig[1]; buf[2] = sig[2];
  for (uint8_t i = 0; i < 8; i++) buf[3 + i] = salt[i];
  buf[11] = 0;
  buf[12] = 'S'; buf[13] = 'T'; buf[14] = 'R'; buf[15] = 'G';
}

void buildMaterialAuth(uint8_t buf[16], const uint8_t sig[3], const uint8_t salt[8], char dev) {
  buf[0] = sig[0]; buf[1] = sig[1]; buf[2] = sig[2];
  for (uint8_t i = 0; i < 8; i++) buf[3 + i] = salt[i];
  buf[11] = (uint8_t)dev;
  buf[12] = 'c'; buf[13] = 'r'; buf[14] = 'y'; buf[15] = 'p';
}

void deriveStorageKeysFromSigSalt(const uint8_t sig[3], const uint8_t salt[8]) {
  uint8_t mat[16];
  buildMaterialStorage(mat, sig, salt);
  uint8_t pk0[16], pk1[16];
  loadPepperStorage0(pk0);
  loadPepperStorage1(pk1);
  uint64_t ha = cx_siphash24(pk0, mat, 16);
  uint64_t hb = cx_siphash24(pk1, mat, 16);
  u64_to_le(ha, gStorageKey);
  u64_to_le(hb, gStorageKey + 8);
}

void rebuildAuthKey(const uint8_t sig[3], const uint8_t salt[8], char dev) {
  uint8_t mat[16];
  buildMaterialAuth(mat, sig, salt, dev);
  uint8_t pk0[16], pk1[16];
  loadPepperK0(pk0);
  loadPepperK1(pk1);
  uint64_t ha = cx_siphash24(pk0, mat, 16);
  uint64_t hb = cx_siphash24(pk1, mat, 16);
  u64_to_le(ha, gAuthKey);
  u64_to_le(hb, gAuthKey + 8);
}

// ── META line ─────────────────────────────────────────────────────────────────

void printHex(const uint8_t* p, uint8_t n) {
  for (uint8_t i = 0; i < n; i++) {
    if (p[i] < 0x10) Serial.print("0");
    Serial.print(p[i], HEX);
  }
}

void printMetaLine(const uint8_t sig[3], const uint8_t salt[8]) {
  Serial.print("META:SIG=");
  printHex(sig, 3);
  Serial.print(";SALT=");
  printHex(salt, 8);
  Serial.println();
}

// ═══════════════════════════════════════════════════════════════════════════════
// EEPROM helpers — masking via derived storage key
// ═══════════════════════════════════════════════════════════════════════════════

bool isPlainAddr(uint8_t addr) {
  if (addr == ADDR_MAGIC) return true;
  if (addr >= ADDR_SALT_START && addr <= ADDR_SALT_END) return true;
  if (addr == ADDR_SEED_FLAG) return true;
  if (addr >= ADDR_SEED_IDX0 && addr <= ADDR_SEED_IDX0 + 23) return true;
  return false;
}

uint8_t maskByte(uint8_t addr) {
  return gStorageKey[addr % 16] ^ (uint8_t)(addr * 23);
}

uint8_t eepromRead(uint8_t addr) {
  uint8_t raw = EEPROM.read(addr);
  if (isPlainAddr(addr)) return raw;
  return raw ^ maskByte(addr);
}

void eepromWrite(uint8_t addr, uint8_t value) {
  if (isPlainAddr(addr)) {
    EEPROM.write(addr, value);
    return;
  }
  EEPROM.write(addr, value ^ maskByte(addr));
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
// Salt management
// ═══════════════════════════════════════════════════════════════════════════════

void fillRandomSalt(uint8_t salt[8]) {
  for (uint8_t i = 0; i < 8; i++) {
    salt[i] = (uint8_t)(analogRead(A0) ^ ((uint8_t)micros()) ^ ((uint8_t)millis()) ^ (i * 47));
    delay(3);
  }
}

void ensureSaltWritten() {
  uint8_t salt[8];
  readSaltPlain(salt);
  bool blank = true;
  for (uint8_t i = 0; i < 8; i++) {
    if (salt[i] != 0xFF) { blank = false; break; }
  }
  if (!blank) return;
  fillRandomSalt(salt);
  for (uint8_t i = 0; i < 8; i++) EEPROM.write(ADDR_SALT_START + i, salt[i]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EEPROM init & wipe
// ═══════════════════════════════════════════════════════════════════════════════

static void clearSeedPlain();

void wipeEEPROM() {
  uint8_t salt[8];
  fillRandomSalt(salt);
  for (uint8_t i = 0; i < 8; i++) EEPROM.write(ADDR_SALT_START + i, salt[i]);
  EEPROM.write(ADDR_MAGIC, MAGIC_BYTE);

  uint8_t sig[3];
  readDeviceSignature(sig);
  deriveStorageKeysFromSigSalt(sig, salt);

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
  eepromWrite(ADDR_AUTH_FAILS, 0);
  clearSeedPlain();
}

static bool isSeedSetPlain() {
  return EEPROM.read(ADDR_SEED_FLAG) == SEED_SET_FLAG;
}

static void clearSeedPlain() {
  EEPROM.write(ADDR_SEED_FLAG, 0);
  for (uint8_t i = 0; i < 24; i++) {
    EEPROM.write(ADDR_SEED_IDX0 + i, 0);
  }
}

static uint16_t readSeedIndex(uint8_t slot) {
  uint8_t lo = EEPROM.read(ADDR_SEED_IDX0 + slot * 2);
  uint8_t hi = EEPROM.read(ADDR_SEED_IDX0 + slot * 2 + 1);
  return (uint16_t)lo | ((uint16_t)hi << 8);
}

static void writeSeedIndex(uint8_t slot, uint16_t idx) {
  EEPROM.write(ADDR_SEED_IDX0 + slot * 2,     (uint8_t)(idx & 0xFF));
  EEPROM.write(ADDR_SEED_IDX0 + slot * 2 + 1, (uint8_t)(idx >> 8));
}

static void generateAndStoreSeed() {
  randomSeed(micros() ^ (uint32_t)analogRead(A0) ^ (uint32_t)millis() ^
             (uint32_t)deviceId * 131U);
  EEPROM.write(ADDR_SEED_FLAG, SEED_SET_FLAG);
  for (uint8_t i = 0; i < 12; i++) {
    writeSeedIndex(i, (uint16_t)(random() % 2048));
  }
}

static void printSeedToSerial() {
  Serial.println("SEED_BEGIN");
  for (uint8_t i = 0; i < 12; i++) {
    Serial.print("SEED_IDX:");
    Serial.println(readSeedIndex(i));
  }
  Serial.println("SEED_END");
}

/** Full security wipe but keep seed indices so recovery stays possible after PIN wipe */
static void pinFailWipePreserveSeed() {
  uint8_t backup[25];
  backup[0] = EEPROM.read(ADDR_SEED_FLAG);
  for (uint8_t i = 0; i < 24; i++) {
    backup[1 + i] = EEPROM.read(ADDR_SEED_IDX0 + i);
  }
  wipeEEPROM();
  if (backup[0] == SEED_SET_FLAG) {
    EEPROM.write(ADDR_SEED_FLAG, backup[0]);
    for (uint8_t i = 0; i < 24; i++) {
      EEPROM.write(ADDR_SEED_IDX0 + i, backup[1 + i]);
    }
  }
}

void initEEPROM() {
  if (EEPROM.read(ADDR_MAGIC) != MAGIC_BYTE) {
    wipeEEPROM();
  } else {
    ensureSaltWritten();
  }
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
  eepromWrite(ADDR_AUTH_FAILS, 0);
}

// ── AUTH fail tracking ────────────────────────────────────────────────────────

uint8_t getAuthFails() {
  return eepromRead(ADDR_AUTH_FAILS);
}

void clearAuthFails() {
  eepromWrite(ADDR_AUTH_FAILS, 0);
}

void recordAuthFail() {
  uint8_t f = (uint8_t)(getAuthFails() + 1);
  eepromWrite(ADDR_AUTH_FAILS, f);
  if (f >= MAX_AUTH_FAILS) {
    wipeEEPROM();
    deviceId = DEFAULT_ID;
    readDeviceSignature(gChipSig);
    uint8_t s[8];
    readSaltPlain(s);
    deriveStorageKeysFromSigSalt(gChipSig, s);
    rebuildAuthKey(gChipSig, s, deviceId);
    Serial.println("AUTH_LOCKOUT");
    enterMode(MODE_INIT);
  }
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
    case MODE_SEED_BACKUP: return "SEED_BACKUP";
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
      lcd.setRGB(255, 255, 255);
      lcdShow("cryptX Ledger", "Awaiting Setup..");
      break;

    case MODE_SET_PIN:
      lcd.setRGB(255, 255, 255);
      lcdShowPinProgress("Create PIN:", 0);
      Serial.println("PIN_PROGRESS:0");
      break;

    case MODE_CONFIRM_PIN:
      lcd.setRGB(255, 255, 255);
      lcdShowPinProgress("Confirm PIN:", 0);
      Serial.println("PIN_PROGRESS:0");
      break;

    case MODE_READY:
      lcd.setRGB(255, 255, 255);
      {
        char line1[17];
        snprintf(line1, sizeof(line1), "Ledger %c Ready", deviceId);
        lcdShow(line1, "Awaiting TX...");
      }
      break;

    case MODE_SIGNING:
      lcd.setRGB(255, 255, 255);
      lcdShowPinProgress("Sign: Enter PIN", 0);
      signStartTime = millis();
      Serial.println("PIN_PROGRESS:0");
      break;

    case MODE_WIPED:
      lcd.setRGB(255, 255, 255);
      lcdShow("!! WIPED !!", "Recover via app");
      break;

    case MODE_SEED_BACKUP:
      lcd.setRGB(255, 255, 255);
      lcdShow("Backup phrase", "Check the UI!");
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Challenge-response (SipHash-2-4 based)
// ═══════════════════════════════════════════════════════════════════════════════

void generateNonce(uint8_t* nonce) {
  for (uint8_t i = 0; i < 8; i++) {
    uint16_t a = analogRead(A0);
    unsigned long u = micros();
    unsigned long t = millis();
    nonce[i] = (uint8_t)(a ^ (u >> (i % 4)) ^ (t >> ((i + 1) % 4)) ^ (i * 31) ^ (i << 3));
    delayMicroseconds(37 + i * 3);
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
  uint8_t expect[8];
  uint64_t tag = cx_siphash24(gAuthKey, currentNonce, 8);
  u64_to_le(tag, expect);
  for (uint8_t i = 0; i < 8; i++) {
    char hi = hexResponse.charAt(i * 2);
    char lo = hexResponse.charAt(i * 2 + 1);
    uint8_t val = (uint8_t)((hexCharToInt(hi) << 4) | hexCharToInt(lo));
    if (val != expect[i]) return false;
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
      lcd.setRGB(255, 255, 255);
      lcdShow("PIN Saved!", "");
      delay(1500);
      uint8_t saltAfter[8];
      readSaltPlain(saltAfter);
      rebuildAuthKey(gChipSig, saltAfter, deviceId);
      enterMode(MODE_READY);
    } else {
      Serial.println("PIN_MISMATCH");
      lcd.setRGB(255, 255, 255);
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
      lcd.setRGB(255, 255, 255);
      lcdShow("TX Approved!", "");
      delay(2000);
      enterMode(MODE_READY);
    } else {
      uint8_t fails = getPinFails() + 1;
      setPinFails(fails);
      logReject();

      if (fails >= MAX_PIN_FAILS) {
        pinFailWipePreserveSeed();
        Serial.println("WIPED");
        deviceId = DEFAULT_ID;
        readDeviceSignature(gChipSig);
        uint8_t salt[8];
        readSaltPlain(salt);
        deriveStorageKeysFromSigSalt(gChipSig, salt);
        rebuildAuthKey(gChipSig, salt, deviceId);
        enterMode(MODE_WIPED);
      } else {
        uint8_t left = MAX_PIN_FAILS - fails;
        Serial.print("PIN_FAIL:");
        Serial.println(left);

        lcd.setRGB(255, 255, 255);
        char msg[17];
        snprintf(msg, sizeof(msg), "Wrong! %d left", left);
        lcdShow("Bad PIN", msg);
        delay(2000);

        pinPos = 0;
        lcd.setRGB(255, 255, 255);
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
  uint8_t salt[8];
  readSaltPlain(salt);

  if (cmd == "PING") {
    Serial.println("PONG");

  } else if (cmd == "META") {
    printMetaLine(gChipSig, salt);

  } else if (cmd == "STATE") {
    printState();

  } else if (cmd.startsWith("SETID ")) {
    if (cmd.length() != 7) {
      Serial.println("ERR:BAD_ID");
      return;
    }
    char newId = cmd.charAt(6);
    if (newId < 'A' || newId > 'Z') {
      Serial.println("ERR:BAD_ID");
      return;
    }
    char stored = (char)eepromRead(ADDR_DEVICE_ID);
    if (isPinSet() && stored != newId) {
      Serial.println("ERR:ID_LOCKED");
      return;
    }
    if (isPinSet() && stored == newId) {
      deviceId = newId;
      Serial.println("ID_SAVED");
      Serial.print("DEVICE:");
      Serial.println(deviceId);
      rebuildAuthKey(gChipSig, salt, deviceId);
      return;
    }

    deviceId = newId;
    eepromWrite(ADDR_DEVICE_ID, (uint8_t)newId);
    eepromWrite(ADDR_DEV_STATE, 1);  // REGISTERED
    Serial.println("ID_SAVED");
    Serial.print("DEVICE:");
    Serial.println(deviceId);
    rebuildAuthKey(gChipSig, salt, deviceId);

    if (!isSeedSetPlain()) {
      generateAndStoreSeed();
    }
    printSeedToSerial();

    if (currentMode == MODE_INIT || currentMode == MODE_SEED_BACKUP) {
      char msg[17];
      snprintf(msg, sizeof(msg), "Ledger %c", deviceId);
      lcd.setRGB(255, 255, 255);
      lcdShow(msg, "Registered!");
      delay(1500);
      enterMode(MODE_SEED_BACKUP);
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

  } else if (cmd == "SEED_ACK") {
    if (currentMode != MODE_SEED_BACKUP) {
      Serial.println("ERR:NOT_BACKUP");
      return;
    }
    Serial.println("SEED_ACKED");
    enterMode(MODE_SET_PIN);

  } else if (cmd == "SEED_VERIFY") {
    if (currentMode != MODE_WIPED) {
      Serial.println("ERR:NOT_WIPED");
      return;
    }
    if (!isSeedSetPlain()) {
      Serial.println("ERR:NO_SEED");
      return;
    }
    sviActive = true;
    sviCount    = 0;
    recoverSeedOk = false;
    Serial.println("SVI_READY");

  } else if (cmd.startsWith("SVI ")) {
    if (!sviActive) {
      Serial.println("ERR:SVI");
      return;
    }
    long idx = cmd.substring(4).toInt();
    if (idx < 0 || idx > 2047) {
      Serial.println("SEED_BAD");
      sviActive = false;
      sviCount  = 0;
      return;
    }
    if ((uint16_t)idx != readSeedIndex(sviCount)) {
      Serial.println("SEED_BAD");
      sviActive = false;
      sviCount  = 0;
      return;
    }
    sviCount++;
    if (sviCount >= 12) {
      recoverSeedOk = true;
      sviActive     = false;
      sviCount      = 0;
      Serial.println("SEED_OK");
    } else {
      Serial.println("SVI_NEXT");
    }

  } else if (cmd == "RECOVER") {
    if (!recoverSeedOk) {
      Serial.println("ERR:SEED");
      return;
    }
    recoverSeedOk = false;
    sviActive     = false;
    sviCount      = 0;
    wipeEEPROM();
    deviceId = DEFAULT_ID;
    readDeviceSignature(gChipSig);
    readSaltPlain(salt);
    deriveStorageKeysFromSigSalt(gChipSig, salt);
    rebuildAuthKey(gChipSig, salt, deviceId);
    Serial.println("RECOVERED");
    enterMode(MODE_INIT);

  } else if (cmd == "CHALLENGE") {
    generateNonce(currentNonce);
    nonceIssued = true;
    printNonce(currentNonce);

  } else if (cmd.startsWith("AUTH ")) {
    if (!nonceIssued) {
      Serial.println("AUTH_FAIL");
      recordAuthFail();
      return;
    }
    nonceIssued = false;
    String response = cmd.substring(5);
    response.trim();
    rebuildAuthKey(gChipSig, salt, deviceId);
    if (verifyAuth(response)) {
      clearAuthFails();
      printStats();
    } else {
      Serial.println("AUTH_FAIL");
      recordAuthFail();
    }

  } else if (cmd == "RESET_STATS") {
    resetStats();
    Serial.println("STATS_RESET");

  } else if (cmd == "UNLOCK") {
    if (currentMode == MODE_WIPED) {
      if (!recoverSeedOk) {
        Serial.println("ERR:SEED");
        return;
      }
      recoverSeedOk = false;
      sviActive     = false;
      sviCount      = 0;
      wipeEEPROM();
      deviceId = DEFAULT_ID;
      readDeviceSignature(gChipSig);
      readSaltPlain(salt);
      deriveStorageKeysFromSigSalt(gChipSig, salt);
      rebuildAuthKey(gChipSig, salt, deviceId);
      Serial.println("UNLOCKED");
      enterMode(MODE_INIT);
    } else {
      eepromWrite(ADDR_CONSEC_REJECTS, 0);
      clearAuthFails();
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

  randomSeed(analogRead(A0) ^ (uint32_t)micros() ^ (uint32_t)millis());

  initEEPROM();

  readDeviceSignature(gChipSig);
  uint8_t salt[8];
  readSaltPlain(salt);
  deriveStorageKeysFromSigSalt(gChipSig, salt);

  uint8_t storedId = eepromRead(ADDR_DEVICE_ID);
  if (storedId >= 'A' && storedId <= 'Z') {
    deviceId = (char)storedId;
  }

  rebuildAuthKey(gChipSig, salt, deviceId);
  printMetaLine(gChipSig, salt);

  Serial.print("DEVICE:");
  Serial.println(deviceId);

  uint8_t devState = eepromRead(ADDR_DEV_STATE);

  if (devState >= 2 && isPinSet()) {
    enterMode(MODE_READY);
  } else if (devState >= 1) {
    // Registered but PIN not yet set — seed must be re-acked via UI before PIN setup
    enterMode(MODE_SEED_BACKUP);
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

  static unsigned long signBothHoldStart = 0;
  static uint8_t       signHoldLastSec   = 255;

  bool signingBothHeld =
      currentMode == MODE_SIGNING &&
      (digitalRead(PIN_BTN1) == HIGH) &&
      (digitalRead(PIN_BTN2) == HIGH);

  if (currentMode == MODE_SIGNING) {
    unsigned long now = millis();
    if (signingBothHeld) {
      if (signBothHoldStart == 0) {
        signBothHoldStart = now;
        signHoldLastSec   = 255;
      }
      unsigned long held = now - signBothHoldStart;
      if (held >= SIGN_HOLD_CANCEL_MS) {
        signBothHoldStart = 0;
        signHoldLastSec   = 255;
        Serial.println("REJECTED");
        lcd.setRGB(255, 255, 255);
        lcdShow("Cancelled", "TX not signed");
        delay(1200);
        enterMode(MODE_READY);
      } else {
        uint8_t remain = (uint8_t)((SIGN_HOLD_CANCEL_MS - held + 999UL) / 1000UL);
        if (remain != signHoldLastSec) {
          signHoldLastSec = remain;
          Serial.print("SIGN_CANCEL:");
          Serial.println(remain);
          lcd.setRGB(255, 255, 255);
          char line2[17];
          snprintf(line2, sizeof(line2), "hold %us...", remain);
          lcdShow("Cancel signing?", line2);
        }
      }
    } else {
      if (signBothHoldStart != 0) {
        signBothHoldStart = 0;
        signHoldLastSec   = 255;
        Serial.println("SIGN_CANCEL_ABORT");
        lcd.setRGB(255, 255, 255);
        lcdShowPinProgress("Sign: Enter PIN", pinPos);
      }
    }
  } else {
    signBothHoldStart = 0;
    signHoldLastSec   = 255;
  }

  if (currentMode == MODE_SET_PIN ||
      currentMode == MODE_CONFIRM_PIN ||
      (currentMode == MODE_SIGNING && !signingBothHeld)) {
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
