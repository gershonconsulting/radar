// Bridge grade from the account's ICP + title (app v1.24.0).
// Pulls the real functions out of app/app.html so the test runs the shipped code.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../app/app.html', import.meta.url), 'utf8');
const grab = (name) => {
  const i = html.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' not found');
  let depth = 0, j = html.indexOf('{', i);
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}' && --depth === 0) return html.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
};
const src = ['icpGrade', 'parseIcpRules', 'bridgeGradeInfo', 'bridgeGrade', 'gradeRank'].map(grab).join('\n');
const api = new Function('let ACCOUNT_ICP = null;\n' + src +
  '\nreturn { parseIcpRules, bridgeGradeInfo, gradeRank, setIcp: r => { ACCOUNT_ICP = r; } };')();

// Meteor Biotech rules (copied from table icp_rules, Postgres \m \M word boundaries).
const meteor = api.parseIcpRules(JSON.stringify({
  role: '(spatial|bioinformat|omics|genomic|drug development|translational|computational|pathology|biomarker|single.?cell|discovery)',
  senior: '(head|director|directeur|\\mvp\\M|vice president|chief|founder|ceo|president|owner|leiter|lead\\M)',
  bad: '(student|intern\\M|consultant|recruit|investor|sales rep)',
}));
assert.ok(meteor, 'rules parse');
const g = t => api.bridgeGradeInfo(t, meteor).g;

assert.equal(g('Director, Spatial Biology'), 'A');
assert.equal(g('VP Translational Research'), 'A');
assert.equal(g('Senior Scientist, Genomics'), 'B');
assert.equal(g('Head of Finance'), 'C');
assert.equal(g('Account Manager'), 'D');
assert.equal(g('Genomics consultant'), 'D');          // excluded word wins
assert.equal(g('Graduate student, single-cell omics'), 'D');
assert.equal(g(''), '?');                             // no title: cannot judge, never D
assert.equal(g(null), '?');
assert.equal(g('Development lead'), 'C');             // "lead" senior, no ICP role
assert.equal(g('Leadership coach'), 'D');             // \M keeps "lead" from matching "leadership"

// Gershon-style rules: role list, no senior list → role alone = A.
const gershon = api.parseIcpRules({ role: '(founder|ceo|managing director)', senior: null, bad: '(consultant)' });
assert.equal(api.bridgeGradeInfo('Founder & CEO', gershon).g, 'A');
assert.equal(api.bridgeGradeInfo('Sales Manager', gershon).g, 'D');

// No rules for the account → previous generic grade, but still '?' for blank titles.
assert.equal(api.bridgeGradeInfo('Business Development Manager', null).g, 'B');
assert.equal(api.bridgeGradeInfo('', null).g, '?');
assert.equal(api.parseIcpRules(''), null);
assert.equal(api.parseIcpRules('not json'), null);

// Sorting: graded bridges before ungraded ones.
assert.ok(api.gradeRank('D') > api.gradeRank('?'));
assert.ok(api.gradeRank('A') > api.gradeRank('B'));

console.log('bridge-grade: all assertions passed');
