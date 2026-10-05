import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createZenMuxPlugin } from '../src/core.mjs';
import { managementKeyPrompt, readSubscription, subscriptionUsage } from '../src/usage.mjs';

// subscription/detail as ZenMux answered it for an Ultra plan
const detail = {
  success: true,
  data: {
    plan: { tier: 'ultra', amount_usd: 200, interval: 'month', expires_at: '2026-10-06T15:38:50.000Z' },
    currency: 'usd',
    base_usd_per_flow: 0.03283,
    effective_usd_per_flow: 0.0516,
    account_status: 'healthy',
    quota_5_hour: { usage_percentage: 0, resets_at: null, max_flows: 800, used_flows: 0, remaining_flows: 800, used_value_usd: 0, max_value_usd: 41.28 },
    quota_7_day: { usage_percentage: 0.3813, resets_at: '2026-10-05T08:51:02.000Z', max_flows: 6182, used_flows: 2357.2, remaining_flows: 3824.8, used_value_usd: 121.64, max_value_usd: 319 },
    quota_monthly: { max_flows: 26496, max_value_usd: 1367.24 },
  },
};

test('the 5-hour and 7-day windows, not the monthly cap', () => {
  assert.deepEqual(readSubscription(detail), {
    plan: 'Ultra',
    until: '2026-10-06T15:38:50.000Z',
    windows: [
      { name: '5 hours', used: 0, amount: 0, limit: 800, unit: 'flows', span: 5 * 3600 },
      { name: '7 days', used: 38.13, resetsAt: '2026-10-05T08:51:02.000Z', amount: 2357.2, limit: 6182, unit: 'flows', span: 7 * 86400 },
    ],
  });
});

test('an account status past healthy is on the plan', () => {
  const d = structuredClone(detail);
  d.data.account_status = 'monitored';
  assert.equal(readSubscription(d).plan, 'Ultra · monitored');
});

test('a refusal is the error', () => {
  assert.deepEqual(readSubscription({ success: false, message: 'Invalid API key', data: null }), { error: 'Invalid API key' });
});

function fakeFetch(calls, reply) {
  return async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization });
    return reply();
  };
}

test('asked with the Management API key, not the API key', async () => {
  const calls = [];
  const fetchImpl = fakeFetch(calls, () => Response.json(detail));
  const u = await subscriptionUsage(async () => ({ type: 'api', key: 'sk-ss-v1-x', metadata: { managementKey: ' sk-mg-v1-k ' } }), { fetchImpl, managementUrl: 'https://zenmux.test/api/v1/management' });
  assert.equal(u.plan, 'Ultra');
  assert.deepEqual(calls, [{ url: 'https://zenmux.test/api/v1/management/subscription/detail', auth: 'Bearer sk-mg-v1-k' }]);
});

test('no Management API key: nothing asked, a hint', async () => {
  const calls = [];
  const u = await subscriptionUsage(async () => ({ type: 'api', key: 'sk-ss-v1-x' }), { fetchImpl: fakeFetch(calls, () => Response.json(detail)), managementUrl: 'https://zenmux.test' });
  assert.match(u.error, /Management API key/);
  assert.equal(calls.length, 0);
});

test('a refused key says ZenMux status and message', async () => {
  const fetchImpl = fakeFetch([], () => Response.json({ success: false, message: 'Invalid API key', data: null }, { status: 403 }));
  const u = await subscriptionUsage(async () => ({ type: 'api', key: 'sk-ss-v1-x', metadata: { managementKey: 'sk-mg-v1-bad' } }), { fetchImpl, managementUrl: 'https://zenmux.test' });
  assert.equal(u.error, 'ZenMux 403: Invalid API key');
});

test('one sign-in: an API key with the Management API key, no OAuth', async () => {
  const hooks = await createZenMuxPlugin({ env: {}, homeDir: '/nonexistent' })({ client: {} });
  assert.equal(typeof hooks.auth.usage, 'function');
  assert.equal(hooks.auth.loader, undefined);
  assert.deepEqual(hooks.auth.methods.map((m) => m.type), ['api']);
  assert.deepEqual(hooks.auth.methods[0].prompts.map((p) => p.key), ['managementKey']);
});

test('the Management API key may be left empty, but what is given is one', () => {
  assert.equal(managementKeyPrompt.validate(''), undefined);
  assert.equal(managementKeyPrompt.validate('   '), undefined);
  assert.match(managementKeyPrompt.validate('sk-ss-v1-abc'), /sk-mg-/);
  assert.equal(managementKeyPrompt.validate(' sk-mg-v1-abc '), undefined);
});
