/**
 * Minimal Web Serial API type declarations.
 * Covers only the subset used by cryptX.
 * Supported in Chrome 89+ and Edge 89+ (requires HTTPS or localhost).
 */

export {};

declare global {
  interface SerialPort {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
  }

  interface Serial {
    requestPort(): Promise<SerialPort>;
  }

  interface Navigator {
    readonly serial?: Serial;
  }
}
