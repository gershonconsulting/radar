# Health-Check Email Alerts — Reusable Runbook

**A server-side "dead man's switch" that emails you when an app silently stops working.**

This document describes the alerting pattern first built for **Radar** (the LinkedIn Sales Navigator collector) and explains how to replicate it on any other Gershon platform (social.gershonCRM.com, Pulse, cookieverify, etc.). Radar is the **reference implementation**; the real, deployed code is included below so it can be copied and adapted.

- **Reference project:** Supabase `radar` (`pkzeeqehwmtnqxdpdesl`)
- **Reference function:** edge function `health-check` (ACTIVE, `verify_jwt=false`)
- **Reference schedule:** pg_cron job `radar-health-check`, daily at `06:00 UTC`
- **Email transport:** Resend (`from: Radar <radar@gershon.ai>`, `reply_to: support@gershonconsulting.com`)

---

## 1. The idea in one paragraph

Most apps only tell you they're broken *if they're healthy enough to send the message* — which is exactly the case that fails. A daily-collection tool that stops collecting also stops doing everything else, including any "I'm broken" notice built into it. The fix is an **external watchdog**: a small, independent job that runs on its own schedule, on infrastructure that does **not** depend on the thing being watched, checks a freshness signal ("when did this app last do its job?"), and emails a human **only when that signal is stale**. On healthy days it sends nothing. This is the classic *dead man's switch* / *heartbeat monitor* pattern.

Three properties make it trustworthy:

1. **Independence** — it runs server-side (Supabase cron + edge function), so it keeps working even when the app's own component (a Chrome extension, a scraper, a browser) is dead. A broken component can't be relied on to report itself.
2. **Silence on success** — it emails only on failure. No daily "all good" noise, so a message in your inbox always means *act now*.
3. **Throttled** — once it has alerted, it won't re-nag more often than a set interval, so an outage produces one clear email, not a flood.

---

## 2. How it works (data flow)

```
                 ┌───────────────────────┐
   pg_cron  ───► │  edge function        │ ──► reads freshness signal (last activity timestamp)
  (daily,        │  health-check         │ ──► per user/tenant:
   06:00 UTC)    │  (independent of app) │        • is it "set up"? (skip empty accounts)
                 └───────────────────────┘        • is last activity older than STALE_HOURS?
                              │                    • already alerted in the last REALERT_HOURS?
                              ▼
                    if stale & not recently alerted
                              │
                              ▼
                    Resend  ──►  ⚠️ email to the owner
                              │
                              ▼
                 write health_alert_at = now  (throttle memory)
```

The freshness signal for Radar is **the most recent `targets.collected_date`** (the timestamp of the last prospect collected). For another app, the signal is whatever timestamp proves the app did its job recently — see §6.

---

## 3. Design decisions (and why they matter)

| Parameter | Radar value | Meaning / how to choose |
|---|---|---|
| **Freshness signal** | `max(targets.collected_date)` | The single timestamp that proves the app is working. Pick the one closest to the app's core job. |
| **STALE_HOURS** | `36` | How long with no activity before it's "broken." Set to a bit more than the normal gap between runs (Radar runs ~daily → 36h tolerates one missed day + slack, avoids false alarms). |
| **REALERT_HOURS** | `20` | Minimum gap between two alerts to the same recipient. Prevents nagging; one outage = ~one email/day. |
| **"Set-up" guard** | `≥1 bridge OR ≥1 source` | Don't alert accounts that never configured the app — an empty account has no "activity" by design, not because it broke. Replace with the equivalent "this tenant is actually using the app" check. |
| **Silent on healthy** | — | No email when the signal is fresh. |
| **Auth** | shared `CRON_SECRET` | The endpoint is public (`verify_jwt=false`) but requires a secret in the body/query, so only the cron (and you) can trigger it. |
| **Throttle memory** | `config.health_alert_at` per owner | Persisted timestamp of the last alert, so the throttle survives cold starts. |
| **From / reply-to** | `radar@gershon.ai` / `support@gershonconsulting.com` | Send from a verified Resend domain; route replies to a monitored inbox. |

---

## 4. Prerequisites

To stand this up for an app you need:

1. **A database with a freshness timestamp.** Some column, somewhere, that updates every time the app does its job (a `collected_date`, `last_run_at`, `created_at`, `updated_at`, etc.).
2. **A Postgres that can call out on a schedule.** On Supabase: extensions **`pg_cron`** (to schedule) and **`pg_net`** (to make the HTTP call). Enable once per project:
   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   ```
3. **A place to run the check logic.** A Supabase **edge function** is ideal — it auto-injects `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, so it reads past RLS with zero secret-passing.
4. **An email transport.** A **Resend** API key and a **verified sending domain** (Radar uses `gershon.ai`). Store the key in the DB `config` table (or as an edge-function env var `RESEND_API_KEY`).
5. **A recipient list.** For Radar it's the `users` table (email + status). For a single-tenant app it can be a hard-coded address.

---

## 5. Reference implementation (Radar) — copy this

### 5a. The edge function (`health-check/index.ts`)

Deployed verbatim in project `pkzeeqehwmtnqxdpdesl`. It: authenticates the secret, loads the Resend key, loops eligible users, computes staleness, throttles, sends, and records the alert time.

```ts
// Radar — health-check edge function.
// Server-side collection monitor: emails a user when Radar has stopped collecting (the Chrome
// extension is disconnected / broken / browser closed). Runs on a daily cron, independent of
// the extension — because a broken extension can't alert about itself. Sends ONLY when something
// is wrong (no noise on healthy days). Triggered by POST { secret } or GET ?secret=.
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = 'radar_7Kq3mZ9pX2vL8nT';   // <-- change per project
const GLOBAL_OWNER_KEY = 'xTVW0K1qKi';
const STALE_HOURS = 36;      // no capture in this many hours (with bridges present) => alert
const REALERT_HOURS = 20;    // don't re-alert the same owner more often than this
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type' };
const enc = encodeURIComponent;
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{...CORS,'Content-Type':'application/json'}});}
async function sb(path,opts={}){const r=await fetch(`${SB_URL}/rest/v1/${path}`,{...opts,headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json',Prefer:opts.prefer||'return=representation',...(opts.headers||{})}});const t=await r.text();let b=null;try{b=t?JSON.parse(t):null;}catch{b=t;}if(!r.ok)throw new Error(`sb ${r.status}: ${String(t).slice(0,150)}`);return b;}
// count(*) via PostgREST Range header
async function count(table,filters){const r=await fetch(`${SB_URL}/rest/v1/${table}?${filters.join('&')}`,{method:'GET',headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,Prefer:'count=exact',Range:'0-0','Range-Unit':'items'}});const cr=r.headers.get('content-range')||'';const n=parseInt((cr.split('/')[1]||'0'),10);return isNaN(n)?0:n;}
async function loadResendKey(){const env=Deno.env.get('RESEND_API_KEY');if(env)return env;try{const a=await sb(`config?key=eq.resend_api_key&owner_key=eq.${enc(GLOBAL_OWNER_KEY)}&select=value&limit=1`);if(a&&a.length&&a[0].value)return a[0].value;}catch(_){}try{const a=await sb(`config?key=eq.resend_api_key&select=value&limit=1`);if(a&&a.length&&a[0].value)return a[0].value;}catch(_){}return null;}
async function lastAlertAt(o){try{const r=await sb(`config?key=eq.health_alert_at&owner_key=eq.${enc(o)}&select=value&limit=1`);return r&&r.length?r[0].value:null;}catch(_){return null;}}
async function setAlertAt(o,iso){try{await sb('config?on_conflict=owner_key,key',{method:'POST',body:JSON.stringify([{owner_key:o,key:'health_alert_at',value:iso,updated_at:iso}]),prefer:'resolution=merge-duplicates,return=minimal'});}catch(_){}}
function alertHtml(name,daysTxt,lastTxt){return `<!doctype html>...⚠️ Radar has stopped collecting ... ${name} ... ${daysTxt} ... ${lastTxt} ...`;}  // full HTML in the repo copy
async function send(key,to,subject,html){const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from:'Radar <radar@gershon.ai>',to:[to],reply_to:'support@gershonconsulting.com',subject,html})});if(!r.ok)throw new Error('resend '+r.status+': '+(await r.text()).slice(0,120));}
Deno.serve(async (req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:CORS});
  // --- auth: secret in POST body or ?secret= ---
  let provided=null;
  if(req.method==='GET')provided=new URL(req.url).searchParams.get('secret');
  else if(req.method==='POST'){try{const b=await req.json();provided=b?.secret??null;}catch(_){provided=null;}if(!provided)provided=new URL(req.url).searchParams.get('secret');}
  if(provided!==CRON_SECRET)return json({ok:false,error:'unauthorized'},401);
  const resendKey=await loadResendKey();if(!resendKey)return json({ok:false,error:'no resend key'},200);
  // --- recipients: active users (or admins) with an email ---
  let users;try{users=await sb(`users?select=owner_key,email,display_name,is_admin,status&email=not.is.null&or=(status.eq.active,is_admin.eq.true)`);}catch(e){return json({ok:false,error:'load users: '+String(e)},200);}
  const now=Date.now();const sent=[];const skipped=[];const errors=[];
  for(const u of users){const own=u.owner_key;if(!own||!u.email)continue;
    // (a) skip accounts that never set collection up
    const bridges=await count('bridges',[`owner_key=eq.${enc(own)}`]);
    const sources=await count('sources',[`owner_key=eq.${enc(own)}`]);
    if(bridges===0&&sources===0){skipped.push(u.email+':not-setup');continue;}
    // (b) freshness signal = most recent capture
    let last=null;try{const rows=await sb(`targets?owner_key=eq.${enc(own)}&select=collected_date&order=collected_date.desc.nullslast&limit=1`);last=rows&&rows.length?rows[0].collected_date:null;}catch(_){}
    const lastMs=last?new Date(last).getTime():0;
    const hrs=lastMs?(now-lastMs)/3600000:Infinity;
    if(hrs<STALE_HOURS){skipped.push(u.email+':healthy');continue;}      // healthy → silent
    // (c) throttle: don't re-alert within REALERT_HOURS
    const la=await lastAlertAt(own);if(la&&(now-new Date(la).getTime())/3600000<REALERT_HOURS){skipped.push(u.email+':recently-alerted');continue;}
    // (d) send + record
    const days=hrs===Infinity?null:Math.floor(hrs/24);
    const daysTxt=days===null?'yet':(days>=1?`in ${days} day${days>1?'s':''}`:`in over ${Math.round(hrs)} hours`);
    const lastTxt=last?new Date(last).toISOString().slice(0,10):'never';
    try{await send(resendKey,u.email,'⚠️ Radar has stopped collecting — check your Chrome extension',alertHtml(u.display_name||'',daysTxt,lastTxt));await setAlertAt(own,new Date().toISOString());sent.push(u.email);}catch(e){errors.push({email:u.email,error:String(e)});}
  }
  return json({ok:true,checked:users.length,sent:sent.length,recipients:sent,skipped,errors});
});
```

> The full, unabridged `alertHtml(...)` (the branded red-banner email body with the "fix in 1 minute" steps and an "Open Radar" button) lives in the deployed function; copy it from Supabase → Edge Functions → `health-check` if you want the exact template.

### 5b. The schedule (pg_cron)

```sql
select cron.schedule(
  'radar-health-check',        -- job name (unique per project)
  '0 6 * * *',                 -- daily at 06:00 UTC
  $$
  select net.http_post(
    url    := 'https://pkzeeqehwmtnqxdpdesl.supabase.co/functions/v1/health-check',
    headers:= '{"Content-Type":"application/json"}'::jsonb,
    body   := '{"secret":"radar_7Kq3mZ9pX2vL8nT"}'::jsonb
  );
  $$
);
```

(Radar also runs a sibling `radar-daily-report` job at `05:00 UTC` — same mechanism, different function.)

### 5c. Manual test

Trigger it on demand (bypassing the cron) to verify wiring end-to-end:

```sql
select net.http_post(
  url    := 'https://pkzeeqehwmtnqxdpdesl.supabase.co/functions/v1/health-check',
  headers:= '{"Content-Type":"application/json"}'::jsonb,
  body   := '{"secret":"radar_7Kq3mZ9pX2vL8nT"}'::jsonb
);
-- then inspect the response:
select id, status_code, content from net._http_response order by id desc limit 1;
```

A response like `{"ok":true,"checked":1,"sent":0,"skipped":["you@x:healthy"]}` means it ran and (correctly) stayed silent. To force a real send while testing, temporarily lower `STALE_HOURS` or point it at an account with a deliberately old signal.

---

## 6. Replicating on another platform — step by step

Everything above is generic except four things you must decide per app. Fill in this table first:

| What | Radar | Your app: __________ |
|---|---|---|
| **Freshness signal** (timestamp that proves it works) | `max(targets.collected_date)` | e.g. `max(posts.scraped_at)` / `max(runs.finished_at)` |
| **"Is it set up?" guard** | ≥1 bridge or source | e.g. ≥1 tracked account / ≥1 enabled job |
| **STALE_HOURS** | 36 | a bit longer than the normal gap between successful runs |
| **Recipients** | `users` table | a table, or a single hard-coded address |
| **Email copy** (what broke + how to fix) | extension steps | the 1-minute fix specific to that app |

Then:

1. **Enable `pg_cron` + `pg_net`** on that app's Postgres/Supabase project (once).
2. **Add a `config` table** (if the project doesn't have one) with at least `(owner_key text, key text, value text, updated_at timestamptz, unique(owner_key,key))` — it stores the Resend key and the `health_alert_at` throttle timestamp. Single-tenant apps can use a fixed `owner_key`.
3. **Store the Resend key** in `config` (`key='resend_api_key'`) or as the function env var `RESEND_API_KEY`. Reuse the existing verified `gershon.ai` sending domain so no new DNS setup is needed.
4. **Deploy a `health-check` edge function** — copy §5a, then change: the `CRON_SECRET` (use a new random string per project), the **freshness query** (swap the `targets…collected_date` read for your app's signal), the **set-up guard**, the `STALE_HOURS`, and the **email subject/body** (`from` can stay `<name>@gershon.ai`).
5. **Schedule it** with `cron.schedule('<app>-health-check', '0 6 * * *', $$ … net.http_post(<your function url>, body:={"secret":"<new secret>"}) … $$)` (§5b). Stagger the minute/hour so all apps don't fire at once.
6. **Test** with §5c, then lower the threshold once to confirm a real email lands, and set it back.

That's the whole port: one edge function + one cron row + one Resend key per app. The pattern, throttle, and "silent on success" behavior carry over unchanged.

---

## 7. Gotchas & notes

- **The watchdog must not live inside the thing it watches.** Keep it server-side (cron + edge function). A monitor that runs in the same browser/extension/process as the app dies with it.
- **Choose STALE_HOURS above the real cadence.** If the app legitimately runs once a day, 24h is too tight (one slightly-late run = false alarm); 36h is the Radar sweet spot. Faster apps can use hours.
- **Throttle is per recipient and persisted** (`config.health_alert_at`), not in memory — edge functions are stateless and cold-start between invocations.
- **`sent:0` is the normal, healthy result.** Absence of email is the success signal.
- **Verify the Resend domain** before relying on it, or alerts silently fail to deliver. Reusing `gershon.ai` across apps avoids per-app DNS work.
- **Keep the secret out of the repo** for production hardening (this doc shows Radar's real secret for reference because it's already public in the deployed function; rotate it and store per-project secrets as env vars if you tighten security later).
- **Related Radar jobs:** `daily-report` (05:00 UTC) is the positive-signal counterpart — a daily summary that always sends — versus `health-check` (06:00 UTC), which sends only on failure. Both use the identical cron→edge-function→Resend spine, so this runbook covers building either kind.

---

*Reference implementation: Radar (`radar.gershoncrm.com`). Maintainer contact: support@gershonconsulting.com.*
