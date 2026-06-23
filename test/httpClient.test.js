import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestWithRetry,
  HttpError,
  isRetryableStatus,
  isFatalStatus,
  isRetryableNetworkError,
  backoffDelay,
  parseRetryAfterMs,
} from "../src/api/httpClient.js";

/* Offline harness: inject a fake fetch + sleep so the retry logic is exercised
 * deterministically with no network and no real waits. */

// Returns/throws queued items in order and records every call.
function queuedFetch(items) {
  let i = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const next = items[i++];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

// Records requested delays and resolves immediately (no wall-clock wait).
function sleepSpy() {
  const delays = [];
  const fn = async (ms) => {
    delays.push(ms);
  };
  fn.delays = delays;
  return fn;
}

function resp(status, body = "", headers = {}) {
  return new Response(body, { status, headers });
}

function abortError() {
  return Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
  });
}

test("503 then 200: retries once then succeeds", async () => {
  const fetchImpl = queuedFetch([resp(503), resp(200, '{"ok":true}')]);
  const sleep = sleepSpy();
  const res = await requestWithRetry("http://x", {
    fetchImpl,
    sleep,
    random: () => 0.5,
  });
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(sleep.delays.length, 1);
});

test("404: fatal, no retry, throws HttpError with status", async () => {
  const fetchImpl = queuedFetch([resp(404)]);
  const sleep = sleepSpy();
  await assert.rejects(
    () => requestWithRetry("http://x", { fetchImpl, sleep }),
    (e) => e instanceof HttpError && e.status === 404 && e.retryable === false,
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(sleep.delays.length, 0);
});

test("timeout/abort: retried up to maxAttempts then throws retryable", async () => {
  const fetchImpl = queuedFetch([abortError(), abortError(), abortError()]);
  const sleep = sleepSpy();
  await assert.rejects(
    () => requestWithRetry("http://x", { fetchImpl, sleep, maxAttempts: 3 }),
    (e) => e instanceof HttpError && e.retryable === true && e.attempts === 3,
  );
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(sleep.delays.length, 2); // retried after attempts 1 and 2, not after 3
});

test("persistent 503: exhausts attempts then throws status 503", async () => {
  const fetchImpl = queuedFetch([resp(503), resp(503), resp(503)]);
  const sleep = sleepSpy();
  await assert.rejects(
    () => requestWithRetry("http://x", { fetchImpl, sleep, maxAttempts: 3 }),
    (e) => e instanceof HttpError && e.status === 503 && e.attempts === 3,
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test("429 with Retry-After: honored in ms, under the cap", async () => {
  const fetchImpl = queuedFetch([
    resp(429, "", { "retry-after": "2" }),
    resp(200, "{}"),
  ]);
  const sleep = sleepSpy();
  await requestWithRetry("http://x", { fetchImpl, sleep, random: () => 0 });
  assert.equal(sleep.delays[0], 2000);
});

test("Retry-After larger than the cap is clamped to the cap", () => {
  const headers = new Headers({ "retry-after": "100" });
  assert.equal(parseRetryAfterMs(headers, 4000), 4000);
});

test("backoffDelay stays within [0, cap] and saturates at the cap", () => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    assert.equal(backoffDelay(attempt, 300, 4000, () => 0), 0);
    const max = backoffDelay(attempt, 300, 4000, () => 1);
    assert.ok(max >= 0 && max <= 4000, `attempt ${attempt} -> ${max}`);
  }
  assert.equal(backoffDelay(1, 300, 4000, () => 1), 300);
  assert.equal(backoffDelay(2, 300, 4000, () => 1), 600);
  assert.equal(backoffDelay(5, 300, 4000, () => 1), 4000); // 300*16=4800 clamped
});

test("status classification helpers", () => {
  assert.ok(isRetryableStatus(503));
  assert.ok(isRetryableStatus(429));
  assert.ok(isFatalStatus(404));
  assert.ok(isFatalStatus(401));
  assert.ok(!isRetryableStatus(404));
});

test("network error classification", () => {
  assert.ok(isRetryableNetworkError(abortError()));
  assert.ok(isRetryableNetworkError({ code: "ECONNRESET" }));
  assert.ok(isRetryableNetworkError({ cause: { code: "ECONNREFUSED" } }));
  assert.ok(!isRetryableNetworkError({ code: "ERR_INVALID_URL" }));
  assert.ok(!isRetryableNetworkError(null));
});
