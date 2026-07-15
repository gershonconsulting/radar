// functions/api/leads/index.js
// Stage 4 of the pipeline: Sources -> Bridges -> Targets -> LEADS.
// A "lead" is a target who actually REPLIED on Botdog.
//
// GET /api/leads          -> list this owner's leads (joined to their target row)
//
// The sync that creates these rows lives in ./sync.js. Reading is deliberately
// Supabase-only: the Leads view must render instantly and must not depend on
// Botdog being up.

import { verify } from '../../_lib/session.js';
import { json, parseCookies, sb } from './_shared.js';

export async function onRequestGet({ request, env }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);
  if (!session) return json({ ok: false, error: 'unauthenticated' }, 401);
  const owner = session.owner_key || session.sub;

  try {
    // Embed the target row so the table can show company/grade without a second query.
    // PostgREST resolves `targets(...)` through the leads.target_id foreign key.
    const select = 'id,linkedin_url,name,first_reply_at,last_message_at,status,notes,created_at,target_id,targets(company,grade,first_name,last_name)';
    const rows = await sb(
      env,
      `leads?owner_key=eq.${encodeURIComponent(owner)}&select=${encodeURIComponent(select)}&order=first_reply_at.desc.nullslast&limit=1000`
    );

    const leads = (rows || []).map(r => {
      const t = r.targets || {};
      const fullName = [t.first_name, t.last_name].filter(Boolean).join(' ').trim();
      return {
        id: r.id,
        name: r.name || fullName || '',
        company: t.company || '',
        grade: t.grade || '',
        linkedin_url: r.linkedin_url || '',
        first_reply_at: r.first_reply_at || null,
        last_message_at: r.last_message_at || null,
        status: r.status || 'new',
        notes: r.notes || '',
        created_at: r.created_at || null,
        matched: !!r.target_id
      };
    });

    return json({ ok: true, count: leads.length, leads });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
