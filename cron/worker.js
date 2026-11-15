/**
 * Radar EOD report — Cloudflare Worker "gershon-radar-eod-cron".
 * Replaces Claude scheduled task #22 "Radar EOD report".
 *
 * Every day at 22:05 UTC (6:05pm New York during EDT, 5:05pm during EST):
 *   1. POST the Radar hub {"secret":RADAR_HUB_SECRET,"action":"runDaily"} (text/plain)
 *      so the day's Botdog push / daily housekeeping runs first. A failure here is
 *      reported in the email but does not stop the report.
 *   2. GET the hub ?callback=cb (JSONP) -> {success,count,rows}.
 *   3. Keep rows whose collected_date falls on TODAY in America/New_York.
 *   4. Email report@gershonconsulting.com via Resend from "GC Radar <reports@gershon.ai>":
 *      new prospects total, by bridge (radar_person) desc, with linkedin_url vs unresolved,
 *      pushed to Botdog, grand total; flag when none of today's prospects has a linkedin_url
 *      (enricherPro not populating).
 *
 * Secrets (Worker secrets, never in git): RADAR_HUB_SECRET, RESEND_API_KEY.
 * Resend Idempotency-Key "radar-eod-<date>" means a retry on the same day never double-sends.
 */
export const HUB =
  "https://script.google.com/macros/s/AKfycbzFX-DPwGDGFPoIxdYwNq5mMztXHNs33PHUNQox-vgrvQbgA2KLccMN9DI-YURCIWxbPw/exec";
export const APP_URL = "https://radar.gershoncrm.com";
const FROM = "GC Radar <reports@gershon.ai>";
const TO = "report@gershonconsulting.com";
const TZ = "America/New_York";

/** YYYY-MM-DD of a Date in New York time. */
export function nyDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** New York date of a hub collected_date value (ISO string, date-only string, or Date). */
export function rowNyDate(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? "" : nyDate(d);
}

/** Parse the hub's JSONP ("cb({...})" or "cb({...});") into an object. */
export function parseJsonp(text) {
  const t = String(text).trim();
  const start = t.indexOf("(");
  const end = t.lastIndexOf(")");
  if (!t.startsWith("cb(") || start < 0 || end <= start) throw new Error("Hub GET did not return cb(...) JSONP: " + t.slice(0, 200));
  return JSON.parse(t.slice(start + 1, end));
}

const has = (v) => v != null && String(v).trim() !== "";

/** Build the day's stats from all hub rows. */
export function summarize(rows, date) {
  const today = rows.filter((r) => rowNyDate(r.collected_date) === date);
  const bridges = new Map();
  let withUrl = 0, pushed = 0;
  for (const r of today) {
    const name = has(r.radar_person) ? String(r.radar_person).trim() : "(no bridge)";
    const b = bridges.get(name) || { bridge: name, total: 0, withUrl: 0, unresolved: 0, pushed: 0 };
    b.total++;
    if (has(r.linkedin_url)) { b.withUrl++; withUrl++; } else b.unresolved++;
    if (has(r.botdog_pushed)) { b.pushed++; pushed++; }
    bridges.set(name, b);
  }
  const byBridge = [...bridges.values()].sort((a, b) => b.total - a.total || a.bridge.localeCompare(b.bridge));
  return {
    date,
    total: today.length,
    withUrl,
    unresolved: today.length - withUrl,
    pushed,
    grandTotal: rows.length,
    byBridge,
    noUrlFlag: today.length > 0 && withUrl === 0,
    latest: rows.reduce((m, r) => { const d = rowNyDate(r.collected_date); return d > m ? d : m; }, ""),
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function subject(s) {
  return `[22] Radar EOD — ${s.total} new prospects — ${s.date}`;
}

export function renderText(s, runDaily) {
  const L = [];
  L.push(`Radar EOD report — ${s.date} (New York)`, "");
  if (s.noUrlFlag) L.push("WARNING: 0 of today's prospects have a LinkedIn URL — enricherPro is not populating linkedin_url.", "");
  L.push(`New prospects today: ${s.total}`);
  L.push(`  with LinkedIn URL: ${s.withUrl}`);
  L.push(`  unresolved (no URL): ${s.unresolved}`);
  L.push(`  pushed to Botdog: ${s.pushed}`);
  L.push(`Grand total in Radar: ${s.grandTotal}`, "");
  if (s.byBridge.length) {
    L.push("By bridge (most new prospects first):");
    for (const b of s.byBridge) L.push(`  ${b.bridge}: ${b.total} new — ${b.withUrl} with URL, ${b.unresolved} unresolved, ${b.pushed} pushed to Botdog`);
  } else {
    L.push(`No new prospects were collected today. Latest collected date in the hub: ${s.latest || "n/a"}.`);
  }
  L.push("", `Daily hub run (runDaily): ${runDaily.ok ? "OK" : "FAILED — " + runDaily.detail}`);
  L.push("", `Open Radar: ${APP_URL}`, "", "— GC Radar (automated report #22)");
  return L.join("\n");
}

export function renderHtml(s, runDaily) {
  const td = "padding:8px 10px;border-bottom:1px solid #eee;font-size:14px;color:#222;";
  const th = "padding:8px 10px;border-bottom:2px solid #CC3333;font-size:12px;color:#666;text-align:left;text-transform:uppercase;letter-spacing:.04em;";
  const num = "text-align:right;";
  const kpi = (label, value) =>
    `<td style="padding:12px;border:1px solid #eee;border-radius:8px;text-align:center;width:25%;"><div style="font-size:24px;font-weight:700;color:#CC3333;">${value}</div><div style="font-size:12px;color:#666;">${esc(label)}</div></td>`;
  const rows = s.byBridge.map((b) =>
    `<tr><td style="${td}">${esc(b.bridge)}</td><td style="${td}${num}"><b>${b.total}</b></td><td style="${td}${num}">${b.withUrl}</td><td style="${td}${num}">${b.unresolved}</td><td style="${td}${num}">${b.pushed}</td></tr>`
  ).join("");
  const table = s.byBridge.length
    ? `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:16px;"><tr><th style="${th}">Bridge</th><th style="${th}${num}">New</th><th style="${th}${num}">With URL</th><th style="${th}${num}">Unresolved</th><th style="${th}${num}">Pushed to Botdog</th></tr>${rows}</table>`
    : `<p style="font-size:14px;color:#444;margin-top:16px;">No new prospects were collected today. Latest collected date in the hub: <b>${esc(s.latest || "n/a")}</b>.</p>`;
  const flag = s.noUrlFlag
    ? `<div style="background:#fdecec;border:1px solid #CC3333;color:#a12020;padding:12px;border-radius:8px;font-size:14px;margin-bottom:16px;"><b>Warning:</b> 0 of today's ${s.total} prospects have a LinkedIn URL — enricherPro is not populating <code>linkedin_url</code>.</div>`
    : "";
  const hub = runDaily.ok
    ? `<span style="color:#1a7f37;">OK</span>`
    : `<span style="color:#CC3333;">FAILED — ${esc(runDaily.detail)}</span>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:24px;background:#ffffff;">
<div style="font-size:12px;color:#CC3333;font-weight:700;letter-spacing:.08em;">GC RADAR · REPORT #22</div>
<h1 style="font-size:22px;color:#111;margin:6px 0 16px;">Radar EOD — ${esc(s.date)}</h1>
${flag}
<table cellpadding="0" cellspacing="8" style="width:100%;border-collapse:separate;"><tr>
${kpi("New prospects today", s.total)}${kpi("With LinkedIn URL", s.withUrl)}${kpi("Unresolved", s.unresolved)}${kpi("Pushed to Botdog", s.pushed)}
</tr></table>
${table}
<p style="font-size:14px;color:#444;margin-top:16px;">Grand total in Radar: <b>${s.grandTotal}</b></p>
<p style="font-size:12px;color:#888;">Daily hub run (runDaily): ${hub}</p>
<p style="margin-top:24px;"><a href="${APP_URL}" style="background:#CC3333;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:700;">Open Radar</a></p>
<p style="font-size:11px;color:#aaa;margin-top:24px;">Automated daily at 22:05 UTC by the gershon-radar-eod-cron Worker (radar repo, cron/). New York date.</p>
</div></body></html>`;
}

async function runDaily(env) {
  try {
    const r = await fetch(HUB, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ secret: env.RADAR_HUB_SECRET, action: "runDaily" }),
      redirect: "follow",
    });
    const body = await r.text();
    console.log("runDaily", r.status, body.slice(0, 500));
    let ok = r.ok;
    try { const j = JSON.parse(body); if (j && j.success === false) ok = false; } catch (_) { /* non-JSON body */ }
    return { ok, detail: ok ? "" : `HTTP ${r.status} ${body.slice(0, 160)}` };
  } catch (e) {
    console.log("runDaily error", String(e));
    return { ok: false, detail: String(e).slice(0, 160) };
  }
}

async function readHub() {
  const r = await fetch(HUB + "?callback=cb", { redirect: "follow" });
  const text = await r.text();
  if (!r.ok) throw new Error(`Hub GET HTTP ${r.status}: ${text.slice(0, 200)}`);
  const j = parseJsonp(text);
  if (!j.success || !Array.isArray(j.rows)) throw new Error("Hub GET unsuccessful: " + text.slice(0, 200));
  return j.rows;
}

async function sendEmail(env, s, rd) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `radar-eod-${s.date}`,
    },
    body: JSON.stringify({ from: FROM, to: [TO], subject: subject(s), html: renderHtml(s, rd), text: renderText(s, rd) }),
  });
  const body = await r.text();
  console.log("resend", r.status, body.slice(0, 300));
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}: ${body.slice(0, 200)}`);
  return body;
}

export async function run(env, now = new Date()) {
  const date = nyDate(now);
  const rd = await runDaily(env);
  const rows = await readHub();
  const s = summarize(rows, date);
  console.log("summary", JSON.stringify({ ...s, byBridge: s.byBridge.length }));
  await sendEmail(env, s, rd);
  return s;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch() {
    return new Response("Radar EOD report (#22): daily 22:05 UTC -> report@gershonconsulting.com", { status: 200 });
  },
};
