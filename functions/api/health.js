// functions/api/health.js
// GET /api/health — public status contract for the FlexiDesk Health checker.
//
// Deliberately reports the PARTS, not just "the app is serving". Radar's URL
// answers 200 on every path (SPA fallback), so a plain ping proves nothing.
// The check that matters is last_sync: whether collection actually happened.
//
// No auth: a signed-out desk must still be able to tell "down" from
// "not signed in". Nothing here is user data — only counts and timestamps.

import { APP_VERSION } from '../_lib/version.js';

// Same project the rest of the app uses (me.js, auth/linkedin/callback.js hard-code it). health.js used to
// require env.SUPABASE_URL, which is not a binding on this Pages project -> fetch('undefined/rest/v1/...')
// threw -> 'unreachable'. The env var is now only an optional override.
const DEFAULT_SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';

const OK_HOURS = 24;    // collection is expected daily
const WARN_HOURS = 48;

function grade(hours) {
  if (hours === null) return 'red';
  if (hours <= OK_HOURS) return 'green';
  if (hours <= WARN_HOURS) return 'orange';
  return 'red';
}

const worst = (a, b) => {
  const rank = { green: 0, orange: 1, red: 2 };
  return rank[a] >= rank[b] ? a : b;
};

async function latest(base, headers, path, col) {
  const r = await fetch(`${base}/rest/v1/${path}`, { headers });
  if (!r.ok) return { ok: false, at: null };
  const rows = await r.json();
  return { ok: true, at: rows && rows[0] ? rows[0][col] : null };
}

export async function onRequestGet({ env }) {
  const checks = [];
  let lastSyncAt = null;
  let dbUp = false;
  let dbDetail = 'unreachable';

  const base = String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_KEY;
  if (!key) {
    // Never echo the value; only say which binding is absent.
    dbDetail = 'SUPABASE_SERVICE_KEY binding missing';
  } else {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    try {
      // Read-only. Latest collection = newest of the extension's sync_log (activity_log, written by the hub
      // on every run) and the newest prospect row (targets.collected_date).
      const [log, tgt] = await Promise.all([
        latest(base, headers, 'activity_log?action=eq.sync_log&select=at&order=at.desc&limit=1', 'at'),
        latest(base, headers, 'targets?select=collected_date&order=collected_date.desc.nullslast&limit=1', 'collected_date')
          .catch(() => ({ ok: false, at: null })),
      ]);
      dbUp = log.ok || tgt.ok;
      if (dbUp) dbDetail = 'connected';
      const times = [log.at, tgt.at].filter(Boolean).map(t => new Date(t).getTime()).filter(Number.isFinite);
      lastSyncAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
    } catch (_) {
      dbUp = false;
    }
  }

  checks.push({
    key: 'database',
    status: dbUp ? 'green' : 'red',
    detail: dbUp ? 'connected' : dbDetail,
  });

  const hours = lastSyncAt
    ? Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 3600000)
    : null;

  checks.push({
    key: 'last_sync',
    status: dbUp ? grade(hours) : 'red',
    detail: hours === null ? 'no collection on record' : `${hours}h ago`,
    at: lastSyncAt,
    window_hours: OK_HOURS,
  });

  const status = checks.map(c => c.status).reduce(worst, 'green');

  return new Response(JSON.stringify({
    platform: 'radar',
    version: APP_VERSION,
    status,
    checked_at: new Date().toISOString(),
    checks,
  }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
