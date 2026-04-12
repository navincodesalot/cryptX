/**
 * Stable Mongo/API device id for hardware ledgers.
 *
 * Must NOT include the UI column (which “Connect” card was used) — that caused
 * duplicate `ledger_devices` docs for the same board (e.g. `ledger-A-B` vs `ledger-B-B`).
 *
 * Firmware identity letter (A/B) is not enough: several physical boards can be
 * registered as “B” over time. The EEPROM **META salt** (16 hex) scopes each unit:
 *
 * - Registered: `ledger-A-<salt>` / `ledger-B-<salt>`
 * - Unregistered (`?`): `ledger-pending-<salt>`
 * - Letter known but salt missing (legacy / META failure): `ledger-<A|B>-unscoped`
 */
export function parseMetaSaltHex(metaLine: string): string | null {
  const m = /SALT=([0-9A-Fa-f]{16})/i.exec(metaLine);
  return m?.[1]?.toLowerCase() ?? null;
}

export function canonicalLedgerDeviceId(
  firmwareDeviceLetter: string,
  metaSaltHex: string | null,
): string {
  const L = firmwareDeviceLetter.trim();
  const saltOk =
    metaSaltHex && /^[0-9a-f]{16}$/i.test(metaSaltHex)
      ? metaSaltHex.toLowerCase()
      : null;

  if (saltOk) {
    if (L === "A" || L === "B") {
      return `ledger-${L}-${saltOk}`;
    }
    if (L === "?" || L === "") {
      return `ledger-pending-${saltOk}`;
    }
  }

  if (L === "A" || L === "B") {
    return `ledger-${L}-unscoped`;
  }
  return "ledger-unknown";
}
