// functions/api/leads/sync.js
// POST /api/leads/sync  -> ask Botdog who replied, match them back to our targets,
//                          and upsert the Leads table.
//
// Botdog read API (verified against the live OpenAPI spec inlined in
// https://api.botdog.co/docs/docs/swagger-ui-init.js on 2026-07-14):
//
//   GET https://api.botdog.co/v1/leads?replied=true&campaignId=<uuid>&limit=100&cursor=<c>
//   auth: header  x-api-key: <key>          <-- NOT "Authorization: Bearer"
//   200 -> PaginatedLeadsDto {
//            data: LeadSummaryDto[] {
//              id, name, linkedinProfile, company, job, campaignId, listId,
//              campaignStatus, hasReplied, hasUnreadReply, isSkipped,
//              skippedReason, createdAt
//            },
//            nextCursor: string|null
//          }
//
// IMPORTANT: LeadSummaryDto has NO reply timestamp — only createdAt (when the lead
// was created, i.e. imported). So we cannot know the true moment of the reply from
// this endpoint. We therefore set first_reply_at ONCE, on the sync that first sees
// hasReplied=true, and never overwrite it. That makes it "when Radar noticed the
// reply", which is honest and monotonic. See CHARLES-LEADS.md for the open question
// about sourcing a true reply timestamp.

import { verify } from '../../_lib/session.js';
import { json, parseCookies, sb, normalizeLinkedInUrl } from './_shared.js';

const BOTDOG_BASE = 'https://api.botdog.co';
const DEFAULT_CAMPAIGN_ID = '343b1a9b-be69-4a09-bc4c-ccedd0d73a8c'; // targets campaign

// Page through GET /v1/leads?replied=true. Defensive: tolerates the payload being
// {data:[...]} , a bare array, or {leads:[...]} so a shape change degrades rather
// than throws. Caps pages so a bad cursor can never spin forever.
async function fetchRepliers(env, { apiKey, campaignId, maxPages = 20 }) {
  const seen = [];
  const debug = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const u = new URL('/v1/leads', BOTDOG_BASE);
    u.searchParams.set('replied', 'true');
    u.searchParams.set('limit', '100');
    if (campaignId) u.searchParams.set('campaignId', campaignId);
    if (cursor) u.searchParams.set('cursor', cursor);

    const r = await fetch(u.toString(), {
      method: 'GET',
      headers: { 'x-api-key': apiKey, Accept: 'application/json' }
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`botdog ${r.status} on GET /v1/leads: ${String(text).slice(0, 200)}`);
    }

    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {
      throw new Error(`botdog returned non-JSON: ${String(text).slice(0, 120)}`);
    }

    // Documented shape is {data, nextCursor}; accept the obvious alternatives.
    const batch = Array.isArray(body) ? body
      : Array.isArray(body && body.data) ? body.data
      : Array.isArray(body && body.leads) ? body.leads
      : [];
    debug.push({ page, got: batch.length, keys: body && !Array.isArray(body) ? Object.keys(body) : ['<array>'] });
    seen.push(...batch);

    cursor = (body && (body.nextCursor || body.next_cursor)) || null;
    if (!cursor || !batch.length) break;
  }
  return { repliers: seen, debug };
}

export async function onRequestPost({ request, env }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);
  if (!session) return json({ ok: false, error: 'unauthenticated' }, 401);
  const owner = session.owner_key || session.sub;

  const apiKey = env.BOTDOG_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'BOTDOG_API_KEY not configured' }, 500);

  let body = {};
  try { body = JSON.parse(await request.text() || '{}'); } catch {}
  const campaignId = body.campaign_id || env.BOTDOG_CAMPAIGN_ID || DEFAULT_CAMPAIGN_ID;

  try {
    const { repliers, debug } = await fetchRepliers(env, { apiKey, campaignId });

    // Keep only genuine repliers. hasReplied should already be true given replied=true,
    // but re-check rather than trust the filter.
    const replied = repliers.filter(l => l && (l.hasReplied === true || l.has_replied === true));

    // Index this owner's targets by normalized URL.
    const targets = await sb(
      env,
      `targets?owner_key=eq.${encodeURIComponent(owner)}&linkedin_url=not.is.null&select=id,linkedin_url,first_name,last_name&limit=5000`
    );
    const byUrl = new Map();
    for (const t of (targets || [])) {
      const k = normalizeLinkedInUrl(t.linkedin_url);
      if (k && !byUrl.has(k)) byUrl.set(k, t);
    }

    // Existing leads: never clobber a first_reply_at we already recorded.
    const existing = await sb(
      env,
      `leads?owner_key=eq.${encodeURIComponent(owner)}&select=id,linkedin_url,first_reply_at`
    );
    const existingByUrl = new Map();
    for (const l of (existing || [])) {
      const k = normalizeLinkedInUrl(l.linkedin_url);
      if (k) existingByUrl.set(k, l);
    }

    const now = new Date().toISOString();
    let inserted = 0, updated = 0, unmatched = 0, skipped = 0;

    for (const l of replied) {
      const rawUrl = l.linkedinProfile || l.linkedin_url || l.linkedinUrl || '';
      const key = normalizeLinkedInUrl(rawUrl);
      if (!key) { skipped++; continue; } // no usable profile URL -> nothing to match on

      const target = byUrl.get(key) || null;
      if (!target) unmatched++;

      const prior = existingByUrl.get(key);
      if (prior) {
        // Already known: only refresh the moving parts.
        await sb(env, `leads?id=eq.${encodeURIComponent(prior.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            last_message_at: now,
            ...(target ? { target_id: target.id } : {}),
            ...(prior.first_reply_at ? {} : { first_reply_at: now })
          }),
          prefer: 'return=minimal'
        });
        updated++;
      } else {
        const name = l.name || [target && target.first_name, target && target.last_name].filter(Boolean).join(' ') || '';
        await sb(env, 'leads', {
          method: 'POST',
          body: JSON.stringify({
            owner_key: owner,
            target_id: target ? target.id : null,
            linkedin_url: `https://${key}`, // store the normalized form
            name,
            first_reply_at: now,
            last_message_at: now,
            status: 'new',
            created_at: now
          }),
          prefer: 'return=minimal'
        });
        inserted++;
      }
    }

    return json({
      ok: true,
      campaign_id: campaignId,
      botdog_returned: repliers.length,
      replied: replied.length,
      inserted,
      updated,
      unmatched,           // replied on Botdog but not one of our targets
      skipped_no_url: skipped,
      pages: debug
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
