import { HTTP } from "../config.js";

/* =========================================================================
 * httpClient.js - resilient fetch for the flaky gateway.
 *
 * Treats every request as expected-to-sometimes-fail: bounded retries with
 * exponential backoff + full jitter, an AbortController timeout, and a clear
 * split between retryable (transient) and fatal (caller-error) failures.
 *
 * All non-determinism (fetch, sleep, randomness) is injectable, so the retry
 * logic is unit-tested offline with zero real network or wall-clock waits.
 * ========================================================================= */

// Transient transport failures worth retrying. Node's fetch (undici) usually
// surfaces the code on err.code or err.cause.code.
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// A single typed error for every failure mode, carrying enough provenance for
// the caller to degrade gracefully (e.g. a fixture to COULD_NOT_ASSESS).
export class HttpError extends Error {
  constructor(
    message,
    { status = null, retryable = false, attempts = 0, cause = null } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
    if (cause) this.cause = cause;
  }
}

export function isRetryableStatus(status) {
  return HTTP.RETRYABLE_STATUS.includes(status);
}

export function isFatalStatus(status) {
  return HTTP.FATAL_STATUS.includes(status);
}

export function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true; // our own timeout, or a transient abort
  const code = err.code ?? err.cause?.code;
  return code ? RETRYABLE_NETWORK_CODES.has(code) : false;
}

// Full jitter: a uniform pick in [0, min(cap, base * 2^(attempt-1))]. Jitter
// stops many fixtures retrying in lockstep against a recovering gateway.
export function backoffDelay(attempt, base, cap, random = Math.random) {
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
  return random() * ceiling;
}

// Retry-After may be seconds or an HTTP date; honor it, capped, never negative.
export function parseRetryAfterMs(headers, capMs, now = Date.now) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  let ms;
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return null;
    ms = when - now();
  }
  return Math.max(0, Math.min(ms, capMs));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a URL with timeout + bounded retries. Resolves to the Response on a 2xx;
 * throws HttpError on a fatal status, an exhausted retryable status, or a
 * non-retryable transport error. JSON parsing is left to the caller.
 */
export async function requestWithRetry(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    timeoutMs = HTTP.TIMEOUT_MS,
    maxAttempts = HTTP.MAX_ATTEMPTS,
    backoffBaseMs = HTTP.BACKOFF_BASE_MS,
    backoffCapMs = HTTP.BACKOFF_CAP_MS,
    signal: _callerSignal, // dropped: our AbortController owns the per-attempt signal
    ...fetchOptions
  } = options;

  let attempt = 0;
  while (true) {
    attempt += 1;
    const hasMoreAttempts = attempt < maxAttempts;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res = null;
    let networkErr = null;
    try {
      res = await fetchImpl(url, { ...fetchOptions, signal: controller.signal });
    } catch (err) {
      networkErr = err;
    } finally {
      clearTimeout(timer);
    }

    // 1) Transport-level failure (timeout/abort/connection reset).
    if (networkErr) {
      const retryable = isRetryableNetworkError(networkErr);
      if (retryable && hasMoreAttempts) {
        await sleep(backoffDelay(attempt, backoffBaseMs, backoffCapMs, random));
        continue;
      }
      throw new HttpError(`request to ${url} failed: ${networkErr.message}`, {
        retryable,
        attempts: attempt,
        cause: networkErr,
      });
    }

    // 2) Success.
    if (res.ok) return res;

    // 3) Non-2xx. Retry only the transient classes; fatal codes fail at once.
    const { status } = res;
    if (isRetryableStatus(status) && hasMoreAttempts) {
      const retryAfter = parseRetryAfterMs(res.headers, backoffCapMs);
      const delay =
        retryAfter ?? backoffDelay(attempt, backoffBaseMs, backoffCapMs, random);
      await sleep(delay);
      continue;
    }
    throw new HttpError(`HTTP ${status} from ${url}`, {
      status,
      retryable: isRetryableStatus(status),
      attempts: attempt,
    });
  }
}
