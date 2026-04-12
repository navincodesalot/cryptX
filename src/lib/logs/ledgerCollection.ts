/** USB hardware ledgers only — one parent doc per `ledger-{A|B}-{firmwareId}`. */
export const LEDGER_DEVICES_COLLECTION = "ledger_devices";

/** Browser session / API audit (`user:…`, `anon:…`) — never mixed with hardware docs. */
export const SESSION_AUDIT_DEVICES_COLLECTION = "session_audit_devices";

export function storageCollectionForDeviceId(deviceId: string): string {
  return deviceId.startsWith("ledger-")
    ? LEDGER_DEVICES_COLLECTION
    : SESSION_AUDIT_DEVICES_COLLECTION;
}
