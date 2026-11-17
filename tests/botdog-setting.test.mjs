import assert from 'node:assert/strict';
import { resolveEnabled } from '../functions/api/botdog-setting.js';
assert.equal(resolveEnabled('on', false), true);
assert.equal(resolveEnabled('off', true), false);
assert.equal(resolveEnabled(undefined, true), true);
assert.equal(resolveEnabled(undefined, false), false);
console.log('botdog-setting: 4 passed');
