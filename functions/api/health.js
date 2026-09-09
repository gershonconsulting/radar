// functions/api/health.js
// GET /api/health — public status contract for the FlexiDesk Health checker.
//
// Deliberately reports the PARTS, not just "the app is serving". Radar's URL
// answers 200 on every path (SPA fallback), so a plain ping proves nothing.
// The check that matters is last_sync: whether collection actually happened.
//
// No auth: a signed-out desk must still be able to tell "down" from
// "not signed in". Nothing here is user data — only counts and timestamps.

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

export async function onRequestGet({ env }) {
  const checks = [];
  let lastSyncAt = null;
  let dbUp = false;

  try {
    const url = `${env.SUPABASE_URL}/rest/v1/activity_log`
      + `?action=eq.sync_log&select=at&order=at.desc&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    });
    dbUp = r.ok;
    if (r.ok) {
      const rows = await r.json();
      lastSyncAt = rows && rows[0] ? rows[0].at : null;
    }
  } catch (_) {
    dbUp = false;
  }

  checks.push({
    key: 'database',
    status: dbUp ? 'green' : 'red',
    detail: dbUp ? 'connected' : 'unreachable',
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
    version: '1.11.0',
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
