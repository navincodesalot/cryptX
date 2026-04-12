/** Keep in sync with buffer accounting in `@/lib/logging/logBuffer`. */
export const RATE_WINDOW_MS = 60_000;
export const MAX_LOGS_PER_IP_PER_WINDOW = 120;

export const AUTH_FAIL_WINDOW_MS = 15 * 60_000;
export const MAX_AUTH_FAILS = 10;

export const TX_WINDOW_MS = 60_000;
export const MAX_TX_PER_WINDOW = 60;
