// =============================================================
// Radar - bridge invites (1.18.0)
//
// WHY THIS FILE EXISTS (2026-11-18). Radar can only read the network of a bridge that is a
// 1st-degree connection of the LinkedIn account on the collecting computer (CONNECTION_OF).
// On client accounts almost every discovered bridge is 2nd/3rd degree (Altavia 174 of 175,
// Valos 16 of 18), so the extension skipped them all and collected nothing. Olivier's own
// account had Botdog to invite them; client accounts had nothing. This is that missing piece:
// a few connection invites a day to 2nd-degree bridges, sent from the client's own Sales Nav,
// and an acceptance check that switches an accepted bridge to 1st degree so its network is read.
//
// OFF by default. Per account config (hub getConfig):
//   bridge_invites        'on' to enable (anything else = off)
//   bridge_invite_note    optional note; {first_name} {company} {source} are filled in. Empty = no note.
//   limit_invites_per_day / limit_invites_per_week   (defaults 5 / 20, halved for new installs)
// =============================================================

const INVITE_LEDGER_KEY = 'radar_bridge_invites';
const INVITE_HOLD_KEY = 'radar_invite_hold';          // LinkedIn weekly-invite limit reached -> pause invites
const INVITE_CHECK_AFTER_DAYS = 2;                    // first acceptance check this long after sending
const INVITE_RECHECK_DAYS = 3;                        // then every N days
const INVITE_EXPIRE_DAYS = 30;                        // stop checking after this (left pending on LinkedIn)
const INVITE_RETRY_FAILED_DAYS = 7;                   // a failed attempt may be retried once after this
const INVITE_MAX_TRIES = 2;
const INVITE_NOTE_MAX = 280;
const INVITE_PRIO_RANK = { high: 0, medium: 1, low: 2 };
const DAY_MS_INV = 86400000;

function invitesEnabled(cfg) { return String((cfg && cfg.bridge_invites) || '').trim().toLowerCase() === 'on'; }

function _invNorm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function isSecondDegree(conn) { return /^2(nd)?\b/i.test(String(conn || '').trim()); }
function isFirstDegreeConn(conn) { return /^1(st)?\b/i.test(String(conn || '').trim()); }
function isSalesUrn(urn) { return /^ACwA[\w-]+$/.test(String(urn || '')); }
function _invHash(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

// Which bridges to invite now. Only active (callers pass the active list; active:false is excluded), real Sales Nav urns, 2nd degree (3rd degree usually
// needs an email to connect), never invited before (or one failed try, a week ago).
// High-priority sources first; inside a tier a stable daily shuffle so the order varies.
function pickInviteCandidates(bridges, ledger, prioMap, n, nowMs) {
  const now = nowMs || Date.now();
  ledger = ledger || {}; prioMap = prioMap || {};
  const day = Math.floor(now / DAY_MS_INV);
  const out = (bridges || []).filter(b => {
    if (!b || b.active === false || !isSalesUrn(b.urn) || !isSecondDegree(b.connection)) return false;
    const e = ledger[b.urn];
    if (!e) return true;
    if (e.status === 'failed' && (e.tries || 0) < INVITE_MAX_TRIES && now - new Date(e.at).getTime() >= INVITE_RETRY_FAILED_DAYS * DAY_MS_INV) return true;
    return false;
  });
  out.sort((a, b) => {
    const pa = INVITE_PRIO_RANK[prioMap[_invNorm(a.source)] || 'medium'];
    const pb = INVITE_PRIO_RANK[prioMap[_invNorm(b.source)] || 'medium'];
    if (pa !== pb) return pa - pb;
    return _invHash(a.urn + day) - _invHash(b.urn + day);
  });
  return out.slice(0, Math.max(0, n || 0));
}

// Sent invites that are due an acceptance check. Expired ones are marked so they stop costing lookups.
function dueAcceptanceChecks(ledger, bridgesByUrn, n, nowMs) {
  const now = nowMs || Date.now();
  const due = [], expired = [];
  for (const urn in (ledger || {})) {
    const e = ledger[urn];
    if (!e || (e.status !== 'sent' && e.status !== 'pending')) continue;
    const b = bridgesByUrn && bridgesByUrn[urn];
    if (b && isFirstDegreeConn(b.connection)) { e.status = 'accepted'; e.acceptedAt = e.acceptedAt || new Date(now).toISOString(); continue; }
    const sent = new Date(e.at).getTime();
    if (now - sent >= INVITE_EXPIRE_DAYS * DAY_MS_INV) { e.status = 'expired'; expired.push(urn); continue; }
    const last = e.checkedAt ? new Date(e.checkedAt).getTime() : 0;
    if (now - sent >= INVITE_CHECK_AFTER_DAYS * DAY_MS_INV && (!last || now - last >= INVITE_RECHECK_DAYS * DAY_MS_INV)) due.push(urn);
  }
  due.sort((a, b) => new Date(ledger[a].at) - new Date(ledger[b].at));
  return { due: due.slice(0, Math.max(0, n || 0)), expired: expired };
}

function renderInviteNote(template, bridge) {
  const t = String(template || '').trim();
  if (!t) return '';
  const name = String((bridge && (bridge.bridge || bridge.name)) || '').trim();
  const first = name.split(/\s+/)[0] || '';
  const company = String((bridge && (bridge.company || bridge.source)) || '').trim();
  let out = t.replace(/\{first_name\}/gi, first).replace(/\{company\}/gi, company).replace(/\{source\}/gi, String((bridge && bridge.source) || '').trim());
  out = out.replace(/[ \t]+/g, ' ').trim();
  if (out.length > INVITE_NOTE_MAX) out = out.slice(0, INVITE_NOTE_MAX - 1).replace(/\s+\S*$/, '') + '…';
  return out;
}

function inviteStats(ledger) {
  const s = { sent: 0, accepted: 0, expired: 0, failed: 0, already: 0 };
  for (const k in (ledger || {})) { const st = ledger[k] && ledger[k].status; if (st === 'sent' || st === 'pending') s.sent++; else if (s[st] != null) s[st]++; }
  s.total = s.sent + s.accepted + s.expired;
  s.acceptRate = s.total ? Math.round(100 * s.accepted / s.total) : 0;
  return s;
}

// ---- Injected into a Sales Nav lead page (/sales/lead/<urn>,NAME_SEARCH,undefined) ----------
// Clicks Connect (directly or from the "…" menu), fills the optional note, clicks Send.
// dry=true stops before Send and closes the dialog (used to verify the page layout).
// Multi-language: EN FR DE ES IT NL PT PL. Never throws; returns { status, detail }.
async function sendInviteInPage(note, dry) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const lbl = el => (el && (el.getAttribute('aria-label') || '')) || '';
  const visible = el => !!(el && el.offsetParent !== null);
  const CONNECT_RE = /^(connect|se connecter|vernetzen|conectar|collegati|connetti|verbinden|ligar|połącz|conectar-se)$/i;
  const CONNECT_ARIA_RE = /^(connect|invite|se connecter|inviter|vernetzen|einladen|conectar|invitar|collegati|invita|verbinden|uitnodigen|połącz)\b/i;
  // Verified live 2026-11-18: Sales Nav shows a disabled "Connect — Pending" item in the "…" menu
  // and "Connection sent: <date>" in the touch-point line once an invite is out.
  const PENDING_RE = /\b(pending|en attente|ausstehend|pendiente|in sospeso|in afwachting|pendente|oczekuje)\b/i;
  const SENT_LINE_RE = /^(connection sent|invitation envoyée|demande de connexion envoyée|kontaktanfrage gesendet|solicitud enviada)\b/i;
  const MORE_RE = /overflow|more actions|plus d.actions|weitere aktionen|más acciones|altre azioni|meer acties|mais ações|więcej działań/i;
  const SEND_RE = /^(send( invitation| invite)?|envoyer( l.invitation)?|einladung senden|senden|enviar( invitación)?|invia( invito)?|verzenden|uitnodiging verzenden|wyślij)$/i;
  const LIMIT_RE = /weekly invitation limit|limite hebdomadaire|wöchentliche[s]? einladungslimit|límite semanal de invitaciones|limite settimanale/i;
  const EMAIL_RE = /email address|adresse e-mail|e-mail-adresse|correo electrónico|indirizzo email/i;
  const buttons = root => Array.from((root || document).querySelectorAll('button, [role="menuitem"], [role="button"], a[role="button"], li > div[tabindex]'));
  const findBtn = (root, re, aria) => buttons(root).find(b => visible(b) && txt(b).length < 60 && (re.test(txt(b)) || (aria && aria.test(lbl(b)))));
  // Verified live 2026-11-18: the page also carries several role="dialog" TOOLTIPS; the invite form
  // is the .artdeco-modal ("Send invitation": optional textarea, Cancel, Send Invitation).
  const isTooltip = el => /tooltip/i.test(String(el.className || ''));
  const dialog = () => {
    const all = Array.from(document.querySelectorAll('.artdeco-modal, [role="dialog"], [role="alertdialog"]')).filter(el => visible(el) && !isTooltip(el));
    return all.find(el => el.classList.contains('artdeco-modal')) || all.find(el => el.querySelectorAll('button').length >= 2) || null;
  };
  const CANCEL_RE = /^(cancel|annuler|abbrechen|cancelar|annulla|annuleren|anuluj)$/i;
  const closeDialog = () => { const d = dialog(); if (!d) return; const x = buttons(d).find(b => CANCEL_RE.test(txt(b))) || d.querySelector('button[aria-label*="ismiss" i], button[aria-label*="ermer" i], button[aria-label*="lose" i], button[aria-label*="chließen" i]'); if (x) x.click(); };

  for (let i = 0; i < 30 && !document.querySelector('[data-anonymize="person-name"]'); i++) await wait(500);
  if (!document.querySelector('[data-anonymize="person-name"]')) {
    if (/checkpoint|authwall|login/i.test(location.href)) return { status: 'challenge', detail: location.href.slice(0, 80) };
    return { status: 'no-page', detail: 'lead page did not load' };
  }
  await wait(800 + Math.floor(Math.random() * 1200));
  if (findBtn(document, PENDING_RE)) return { status: 'already', detail: 'invitation already pending' };
  if (Array.from(document.querySelectorAll('span, p, div')).some(e => e.children.length === 0 && SENT_LINE_RE.test(txt(e)))) return { status: 'already', detail: 'connection already sent' };

  let connect = findBtn(document, CONNECT_RE, CONNECT_ARIA_RE);
  if (!connect) {
    const more = buttons(document).find(b => visible(b) && MORE_RE.test(lbl(b) + ' ' + txt(b)));
    if (!more) return { status: 'ui-not-found', detail: 'no Connect button and no actions menu' };
    more.click();
    // The menu items are plain <button>s in <li>s (no role="menu"): search the whole page again.
    for (let i = 0; i < 10 && !connect; i++) {
      await wait(300);
      if (findBtn(document, PENDING_RE)) { document.body.click(); return { status: 'already', detail: 'invitation already pending (menu)' }; }
      connect = findBtn(document, CONNECT_RE, CONNECT_ARIA_RE);
    }
    if (!connect) { document.body.click(); return { status: 'no-connect', detail: 'Connect not offered (already connected, 3rd degree or restricted)' }; }
  }
  if (connect.disabled || connect.getAttribute('aria-disabled') === 'true') { document.body.click(); return { status: 'already', detail: 'Connect is disabled' }; }
  connect.click();
  let d = null;
  for (let i = 0; i < 25; i++) {
    await wait(300); d = dialog();
    if (d && (LIMIT_RE.test(txt(d)) || buttons(d).some(b => SEND_RE.test(txt(b)) || SEND_RE.test(lbl(b))))) break;
  }
  if (!d) return { status: 'ui-not-found', detail: 'invite dialog did not open' };
  if (LIMIT_RE.test(txt(d))) { closeDialog(); return { status: 'li-limit', detail: 'LinkedIn weekly invitation limit' }; }
  if (EMAIL_RE.test(txt(d)) && d.querySelector('input[type="email"], input[name*="email" i]')) { closeDialog(); return { status: 'needs-email', detail: 'LinkedIn asks for their email' }; }

  const ta = d.querySelector('textarea');
  if (note && ta) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    ta.focus(); setter.call(ta, note);
    ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500 + Math.floor(Math.random() * 700));
  }
  const send = buttons(d).find(b => visible(b) && !b.disabled && (SEND_RE.test(txt(b)) || SEND_RE.test(lbl(b))));
  if (!send) { closeDialog(); return { status: 'ui-not-found', detail: 'no Send button in dialog', noteBox: !!ta }; }
  if (dry) { closeDialog(); return { status: 'dry-ok', detail: 'Connect + dialog + Send found', noteBox: !!ta, noteUsed: !!(note && ta), sendLabel: txt(send) || lbl(send) }; }
  send.click();
  for (let i = 0; i < 16; i++) {
    await wait(400);
    const dd = dialog();
    if (dd && LIMIT_RE.test(txt(dd))) { closeDialog(); return { status: 'li-limit', detail: 'LinkedIn weekly invitation limit' }; }
    if (!dd || dd !== d) return { status: 'sent', detail: 'dialog closed after Send', noteUsed: !!(note && ta) };
  }
  closeDialog();
  return { status: 'unknown', detail: 'dialog still open after Send' };
}

// ---- Injected into any authenticated Sales Nav tab: degree of each invited bridge ----------
async function checkDegreesInPage(urns) {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1];
  if (!csrf) return { error: 'no JSESSIONID cookie', out: [] };
  const H = { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' };
  const out = [];
  for (const urn of urns) {
    const row = { urn: urn, degree: null, status: 0 };
    try {
      const u = '/sales-api/salesApiProfiles/(profileId:' + urn + ',authType:NAME_SEARCH,authToken:undefined)?decoration=%28entityUrn%2Cdegree%29';
      const r = await fetch(u, { credentials: 'include', headers: H });
      row.status = r.status;
      if (r.status === 401 || r.status === 403 || r.status === 429) { row.stop = true; out.push(row); break; }
      if (r.ok) { try { const j = await r.json(); row.degree = (typeof j.degree !== 'undefined') ? j.degree : null; } catch (e) {} }
    } catch (e) { row.error = String(e).slice(0, 80); }
    out.push(row);
    await new Promise(r => setTimeout(r, 700 + Math.floor(Math.random() * 900)));
  }
  return { out: out };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { invitesEnabled, pickInviteCandidates, dueAcceptanceChecks, renderInviteNote, inviteStats, isSecondDegree, isFirstDegreeConn, INVITE_EXPIRE_DAYS, sendInviteInPage, checkDegreesInPage };
}
