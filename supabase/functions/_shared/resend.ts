/**
 * One Resend sender for the Radar Supabase functions (daily-report v9.3, app v1.19.1).
 *
 * Why: on 2026-11-13 18:20-21:54 UTC Resend failed transiently and the Radar report
 * (with Task, Publish and Social ones) was dropped — every sender made exactly one attempt.
 *
 * - Transient failures (network error / 10 s timeout, HTTP 429, HTTP 5xx, and Resend's
 *   409 concurrent_idempotent_requests) are retried up to 3 times after 1 s, 4 s, 10 s
 *   (Retry-After honoured up to 10 s). Worst case stays under a minute.
 * - Every attempt of one logical email carries the SAME Idempotency-Key header (the
 *   caller's key, or a fresh UUID), so a retry can never
 *   deliver twice. Other 4xx are not retried.
 * - The final failure is logged once: "[resend] <label>: FINAL FAILURE ...".
 * Sender, recipients and API key are the caller's, unchanged.
 */

export const RESEND_URL = "https://api.resend.com/emails";
export const RESEND_RETRY_DELAYS_MS = [1000, 4000, 10000];
const ATTEMPT_TIMEOUT_MS = 10000;

export type ResendResult = {
  ok: boolean;
  /** 0 = network error / timeout */
  status: number;
  /** Raw response text (JSON from Resend), "" on network errors. */
  text: string;
  id?: string;
  attempts: number;
  idempotencyKey: string;
  error?: string;
};

export type ResendOptions = {
  /** Stable key for this logical email; a fresh UUID when omitted. */
  idempotencyKey?: string;
  /** Short name for logs, e.g. "daily-report". */
  label?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: number[];
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isTransientStatus(status: number, text = ""): boolean {
  if (status === 0 || status === 429 || status >= 500) return true;
  return status === 409 && text.includes("concurrent_idempotent_requests");
}

function retryAfterMs(res: Response | null): number | null {
  const v = res?.headers?.get?.("retry-after");
  if (!v) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, 10000) : null;
}

export async function sendResend(
  apiKey: string,
  payload: Record<string, unknown>,
  opts: ResendOptions = {},
): Promise<ResendResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const delays = opts.delaysMs ?? RESEND_RETRY_DELAYS_MS;
  const idempotencyKey = (opts.idempotencyKey || crypto.randomUUID()).slice(0, 256);
  const label = opts.label ?? "resend";
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
  };

  let last: ResendResult = { ok: false, status: 0, text: "", attempts: 0, idempotencyKey };
  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    let res: Response | null = null;
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
  console.error(
    `[resend] ${label}: FINAL FAILURE after ${last.attempts} attempt(s) - status ${last.status || "network"} - ${last.error} - subject "${String(payload.subject ?? "")}" - idempotency ${idempotencyKey}`,
  );
  return last;
}
