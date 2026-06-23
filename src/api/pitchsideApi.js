import { requestWithRetry, HttpError } from "./httpClient.js";
import { requireBaseUrl } from "../config.js";

/* =========================================================================
 * pitchsideApi.js - typed access to the fixtures feed.
 *
 * getFixtures() and getEvidence(id) sit on the resilient httpClient, parse JSON
 * defensively (a non-JSON 200 becomes a fatal HttpError, not a thrown
 * SyntaxError), and return plain arrays for the pipeline to consume.
 *
 * All options pass straight through to requestWithRetry, so the injectable
 * fetch/sleep/random seams work here too (used by the capture script).
 * ========================================================================= */

// Low-level GET + JSON parse. Exported so the capture script can store the raw
// server payloads at full fidelity.
export async function fetchJson(path, options = {}) {
  const { baseUrl, ...requestOptions } = options;
  const base = baseUrl ?? requireBaseUrl();
  const url = `${base}${path}`;
  const res = await requestWithRetry(url, requestOptions);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(`non-JSON response from ${url}`, {
      status: res.status,
      retryable: false,
      cause: err,
    });
  }
}

export async function getFixtures(options = {}) {
  const body = await fetchJson("/fixtures", options);
  const fixtures = body?.fixtures;
  if (!Array.isArray(fixtures)) {
    throw new HttpError("malformed /fixtures payload: expected fixtures[]", {
      retryable: false,
    });
  }
  return fixtures;
}

export async function getEvidence(fixtureId, options = {}) {
  const path = `/fixtures/${encodeURIComponent(fixtureId)}/evidence`;
  const body = await fetchJson(path, options);
  const evidence = body?.evidence;
  if (!Array.isArray(evidence)) {
    throw new HttpError(`malformed evidence payload for ${fixtureId}`, {
      retryable: false,
    });
  }
  return evidence;
}
