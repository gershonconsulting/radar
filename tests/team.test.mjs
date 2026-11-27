// tests/team.test.mjs - Radar team access (app v1.27.0). Run: node tests/team.test.mjs
import assert from 'node:assert/strict';
import { normLinkedin, isEmail, parseTeam, findMember, validateInvite, canHubWrite, canManageTeam, canEditSettings, pickWorkspace, findMemberships, publicMember, MAX_MEMBERS } from '../functions/_lib/team.js';
import { callerContext } from '../functions/api/team.js';
import { onRequest as middleware } from '../functions/_middleware.js';

let n = 0; const t = (name, fn) => { fn(); n++; };
const at = async (name, fn) => { await fn(); n++; };

t('linkedin url normalised', () => {
  assert.equal(normLinkedin('linkedin.com/in/jane-doe/'), 'https://www.linkedin.com/in/jane-doe');
  assert.equal(normLinkedin('https://fr.linkedin.com/in/jane?trk=x'), 'https://www.linkedin.com/in/jane');
  assert.equal(normLinkedin('https://www.linkedin.com/company/acme'), null);
  assert.equal(normLinkedin('https://evil.com/in/jane'), null);
});
t('email check', () => { assert.ok(isEmail('a.b@meteor.bio')); assert.ok(!isEmail('nope')); assert.ok(!isEmail('a@b')); });

t('invite validation', () => {
  const ok = validateInvite({ name: 'Jane', email: 'Jane@Meteor.bio ', linkedin_url: 'linkedin.com/in/jane', role: 'semi' }, []);
  assert.ok(ok.ok); assert.equal(ok.member.email, 'jane@meteor.bio'); assert.equal(ok.member.status, 'invited'); assert.equal(ok.member.sub, null);
  assert.match(validateInvite({ email: 'x@y.co', linkedin_url: 'linkedin.com/in/x', role: 'admin' }, []).error, /Full, Semi or Viewer/);
  assert.match(validateInvite({ email: 'x@y.co', role: 'full' }, []).error, /LinkedIn/);
  assert.match(validateInvite({ email: 'jane@meteor.bio', linkedin_url: 'linkedin.com/in/j', role: 'full' }, [ok.member]).error, /already/);
  const full = Array.from({ length: MAX_MEMBERS }, (_, i) => ({ email: i + '@a.co', role: 'viewer' }));
  assert.match(validateInvite({ email: 'z@a.co', linkedin_url: 'linkedin.com/in/z', role: 'full' }, full).error, /Limit/);
  assert.equal(publicMember({ ...ok.member, sub: 'secret' }).sub, undefined);
});

t('find member: sub first, email only while unbound', () => {
  const list = parseTeam(JSON.stringify([{ id: 'a', email: 'jane@x.co', role: 'full', sub: 'S1' }, { id: 'b', email: 'bob@x.co', role: 'viewer' }, { email: 'bad', role: 'god' }]));
  assert.equal(list.length, 2);
  assert.equal(findMember(list, { sub: 'S1' }).id, 'a');
  assert.equal(findMember(list, { email: 'BOB@x.co', sub: 'S9' }).id, 'b');
  assert.equal(findMember(list, { email: 'jane@x.co', sub: 'OTHER' }), null);   // email reused by another LinkedIn
  assert.deepEqual(parseTeam('not json'), []);
});

t('role rules', () => {
  assert.ok(canHubWrite('owner', { action: 'setConfig', botdog_api_key: 'k' }));
  assert.ok(canHubWrite('full', { action: 'deleteBridge' }));
  assert.ok(canHubWrite('semi', { action: 'addSource' }));
  assert.ok(canHubWrite('semi', { action: 'setBridgeActive' }));
  assert.ok(canHubWrite('semi', { action: 'setConfig', secret: 's', owner: 'o', excluded_leads: '[]' }));
  assert.ok(!canHubWrite('semi', { action: 'setConfig', excluded_leads: '[]', salesnav_search_template: 'x' }));
  assert.ok(!canHubWrite('semi', { action: 'deleteBridge' }));
  assert.ok(!canHubWrite('semi', { leads: [{}] }));
  assert.ok(!canHubWrite('viewer', { action: 'addSource' }));
  assert.ok(canHubWrite('viewer', { action: 'feedback' }));
  assert.ok(canManageTeam('full') && !canManageTeam('semi') && !canManageTeam('viewer'));
  assert.ok(canEditSettings('owner') && !canEditSettings('semi'));
});

t('which account at sign-in', () => {
  const m = [{ owner_key: 'AMOS', member: { role: 'semi' } }];
  assert.equal(pickWorkspace({ own: null, memberships: m }).kind, 'member');                         // invited, no account
  assert.equal(pickWorkspace({ own: { id: 1 }, ownHasData: false, memberships: m }).kind, 'member'); // empty own account
  assert.equal(pickWorkspace({ own: { id: 1 }, ownHasData: true, memberships: m }).kind, 'own');     // real own account
  assert.equal(pickWorkspace({ own: { id: 1 }, isAdmin: true, memberships: m }).kind, 'own');        // Olivier
  assert.equal(pickWorkspace({ own: null, memberships: [] }).kind, 'new');                           // self sign-up unchanged
});

await at('memberships lookup verifies exact match', async () => {
  const calls = [];
  const sb = async (p) => { calls.push(p); return [
    { owner_key: 'AMOS', value: JSON.stringify([{ id: 'a', email: 'jane@x.co', role: 'viewer' }]) },
    { owner_key: 'OTHER', value: JSON.stringify([{ id: 'b', email: 'xjane@x.com', role: 'full' }]) }   // ilike false positive
  ]; };
  const r = await findMemberships(sb, { email: 'jane@x.co', sub: 'S1' });
  assert.deepEqual(r.map(x => x.owner_key), ['AMOS']);
  assert.ok(calls[0].includes('key=eq.team_members'));
});

await at('caller context: removed member is refused, role is live', async () => {
  const team = [{ id: 'a', email: 'jane@x.co', role: 'semi', sub: 'S1' }];
  const sb = async (p) => p.startsWith('config') ? [{ value: JSON.stringify(team) }] : [{ status: 'active' }];
  assert.equal((await callerContext(sb, { sub: 'S1', owner_key: 'AMOS', role: 'full' })).role, 'semi');
  assert.equal(await callerContext(sb, { sub: 'S2', email: 'bob@x.co', owner_key: 'AMOS', role: 'viewer' }), null);
  assert.equal((await callerContext(sb, { sub: 'O', owner_key: 'AMOS' })).role, 'owner');
  assert.equal(await callerContext(sb, null), null);
});

await at('middleware injects team.js once into the app page', async () => {
  const html = '<html><head></head><body><section id="view-settings"></section><div id="appShell"></div></body></html>';
  const res = await middleware({ request: new Request('https://radar.gershon.ai/app'), next: async () => new Response(html, { headers: { 'content-type': 'text/html' } }), env: {} });
  const out = await res.text();
  assert.equal(out.split('/team.js?v=').length - 1, 1);
});

console.log('team: ' + n + ' passed');
