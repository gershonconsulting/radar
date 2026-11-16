// Resend sender with retry for the Radar EOD Worker (2026-11-16, app v1.19.1).
// Why: on 2026-11-13 18:20-21:54 UTC Resend failed transiently and report emails were never retried.
// - network error / 10 s timeout, HTTP 429, HTTP 5xx (and Resend 409 concurrent_idempotent_requests) are
//   retried up to 3 times after 1 s, 4 s, 10 s (Retry-After honoured up to 10 s);
// - every attempt carries the SAME Idempotency-Key (the caller's, e.g. radar-eod-<date>, or one UUID),
//   so a retry can never deliver twice; other 4xx are not retried;
// - the final failure is logged once: "[resend] <label>: FINAL FAILURE ...".
// Same logic as supabase/functions/_shared/resend.ts (kept here because the Worker deploys cron/ alone).

export const RESEND_URL = "https://api.resend.com/emails";
export const RESEND_RETRY_DELAYS_MS = [1000, 4000, 10000];
const ATTEMPT_TIMEOUT_MS = 10000;

export function isTransientStatus(status, text = "") {
  if (status === 0 || status === 429 || status >= 500) return true;
  return status === 409 && text.includes("concurrent_idempotent_requests");
}

function retryAfterMs(res) {
  const v = res && res.headers && res.headers.get ? res.headers.get("retry-after") : null;
  if (!v) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, 10000) : null;
}

/** @returns {Promise<{ok:boolean,status:number,text:string,id?:string,attempts:number,idempotencyKey:string,error?:string}>} */
export async function sendResend(apiKey, payload, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const delays = opts.delaysMs || RESEND_RETRY_DELAYS_MS;
  const idempotencyKey = String(opts.idempotencyKey || crypto.randomUUID()).slice(0, 256);
  const label = opts.label || "resend";
  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
  };
  let last = { ok: false, status: 0, text: "", attempts: 0, idempotencyKey };
  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    let res = null;
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) : undefined;
      res = await doFetch(RESEND_URL, signal ? { ...init, signal } : init);
      const text = await res.text().catch(() => "");
      const id = (text.match(/"id"\s*:\s*"([^"]+)"/) || [])[1];
      last = { ok: res.ok, status: res.status, text, id, attempts: attempt, idempotencyKey, error: res.ok ? undefined : text.slice(0, 400) || String(res.status) };
    } catch (e) {
      last = { ok: false, status: 0, text: "", attempts: attempt, idempotencyKey, error: "network: " + (e instanceof Error ? e.message : String(e)) };
    }
    if (last.ok) {
      if (attempt > 1) console.warn(`[resend] ${label}: delivered on attempt ${attempt} (idempotency ${idempotencyKey})`);
      return last;
    }
    if (!isTransientStatus(last.status, last.text) || attempt > delays.length) break;
    const wait = Math.max(delays[attempt - 1], retryAfterMs(res) ?? 0);
    console.warn(`[resend] ${label}: attempt ${attempt} failed (${last.status || "network"}); retrying in ${wait} ms`);
    await sleep(wait);
  }
  console.error(`[resend] ${label}: FINAL FAILURE after ${last.attempts} attempt(s) - status ${last.status || "network"} - ${last.error} - subject "${String(payload.subject ?? "")}" - idempotency ${idempotencyKey}`);
  return last;
}
