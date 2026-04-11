/*
 * cryptX — EEPROM reset (utility sketch)
 *
 * Flash this once, open Serial Monitor @ 115200, press the board reset button.
 * It clears all EEPROM bytes. Then flash ledger.ino again — the ledger will
 * boot fresh (INIT → register + PIN) as if it were new.
 *
 * Arduino Uno R3: EEPROM is 1024 bytes.
 */

#include <EEPROM.h>

void setup() {
  Serial.begin(115200);
  delay(300);  // time to open Serial Monitor if you want logs

  Serial.println(F("cryptX EEPROM reset — erasing..."));

  for (unsigned i = 0; i < EEPROM.length(); i++) {
    EEPROM.update(i, 0xFF);
  }

  Serial.println(F("Done. Reflash firmware/ledger/ledger.ino"));
}

void loop() {
  // nothing
}
