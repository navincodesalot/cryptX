/*
 * cryptX Ledger — Arduino Uno R3
 * ───────────────────────────────────────────────────────────────────────
 * Physical authorization device for Solana transactions.
 *
 * SETUP BEFORE FLASHING
 * ──────────────────────
 *   Board #1:  set  DEVICE_ID 'A'     (default, no change needed)
 *   Board #2:  set  DEVICE_ID 'B'     (change the line below)
 *
 * BUTTON (optional — for later)
 * ──────────────────────────────
 *   AUTO_CONFIRM 1  → no button needed; auto-confirms after a short delay
 *   AUTO_CONFIRM 0  → physical button required
 *     Wiring: Pin 2 → GND  (built-in pull-up, no extra resistor)
 *     Single click  = CONFIRM
 *     Double click  (< 500 ms apart) = REJECT
 *
 * SERIAL PROTOCOL  (115200 baud, newline-terminated)
 * ────────────────────────────────────────────────────
 *   Host → Device:    PING  |  SIGN  |  CANCEL
 *   Device → Host:    PONG  |  DEVICE:<id>  |  READY  |
 *                     PENDING  |  CONFIRMED  |  REJECTED
 */

// ── Configuration ─────────────────────────────────────────────────────────────
#define DEVICE_ID    'A'   // ← Change to 'B' on the second board
#define AUTO_CONFIRM  1    // 1 = no button needed  |  0 = require button press

// ── Auto-confirm delay (only used when AUTO_CONFIRM 1) ────────────────────────
const unsigned long AUTO_DELAY_MS   = 600UL;

// ── Button settings (only used when AUTO_CONFIRM 0) ───────────────────────────
const int           PIN_BUTTON       = 2;
const unsigned long SIGN_TIMEOUT_MS  = 30000UL;
const unsigned long DOUBLE_CLICK_MS  = 500UL;

// ── State ─────────────────────────────────────────────────────────────────────
enum DeviceState { IDLE, PENDING_SIGN };
DeviceState        deviceState  = IDLE;
unsigned long      pendingTs    = 0;
String             inputBuf     = "";

#if !AUTO_CONFIRM
  unsigned long firstClickTs       = 0;
  bool          waitingSecondClick = false;
#endif

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

#if !AUTO_CONFIRM
  pinMode(PIN_BUTTON, INPUT_PULLUP);
#endif

  // Announce identity so the browser can auto-identify this board
  Serial.print("DEVICE:");
  Serial.println((char)DEVICE_ID);
  Serial.println("READY");
}

// ── Main loop ─────────────────────────────────────────────────────────────────
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
          // Second click within window → REJECT
          waitingSecondClick = false;
          doReject();
        } else {
          // First click → start double-click window
          firstClickTs       = now;
          waitingSecondClick = true;
        }

        while (digitalRead(PIN_BUTTON) == LOW) {}  // wait for release
      }
    }

    // Single-click window expired → CONFIRM
    if (waitingSecondClick && (millis() - firstClickTs >= DOUBLE_CLICK_MS)) {
      waitingSecondClick = false;
      doConfirm();
    }

    // Overall timeout → REJECT
    if (millis() - pendingTs >= SIGN_TIMEOUT_MS) {
      waitingSecondClick = false;
      doReject();
    }
#endif

  }
}

// ── Serial reader ─────────────────────────────────────────────────────────────
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

// ── Command handler ───────────────────────────────────────────────────────────
void handleCmd(const String& cmd) {
  if (cmd == "PING") {
    Serial.println("PONG");

  } else if (cmd == "SIGN") {
    deviceState  = PENDING_SIGN;
    pendingTs    = millis();
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
  }
}

// ── Confirm ───────────────────────────────────────────────────────────────────
void doConfirm() {
  deviceState = IDLE;
  Serial.println("CONFIRMED");
}

// ── Reject ────────────────────────────────────────────────────────────────────
void doReject() {
  deviceState = IDLE;
  Serial.println("REJECTED");
}
