// A ZenMux subscription's 5-hour and 7-day windows, for magpie's auth.usage
// hook (OpenCode ignores it). ZenMux tells them only to a Management API key
// (sk-mg-v1-…), never to an API key, so sign-in may take one beside the API
// key and keep it in the account's metadata; left empty, the models still
// work and the usage card says what is missing.

export const managementKeyPrompt = {
  type: 'text',
  key: 'managementKey',
  message: 'ZenMux Management API key (optional, to see subscription usage)',
  placeholder: 'sk-mg-v1-…  ·  zenmux.ai/platform/management  ·  empty to skip',
  validate: (value) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v && !v.startsWith('sk-mg-')) return 'A Management API key starts with sk-mg- (zenmux.ai/platform/management)';
    return undefined;
  },
};

export function managementKeyOf(source) {
  const key = source?.metadata?.managementKey;
  return typeof key === 'string' ? key.trim() : '';
}

const tierNames = { free: 'Free', pro: 'Pro', max: 'Max', ultra: 'Ultra' };

const windowsOf = [
  ['quota_5_hour', '5 hours', 5 * 3600],
  ['quota_7_day', '7 days', 7 * 86400],
];

// readSubscription turns subscription/detail's reply into auth.usage's
// answer: the monthly cap is left out, ZenMux tells no use against it.
export function readSubscription(payload) {
  const data = payload?.data;
  if (!payload?.success || !data) {
    return { error: payload?.message || 'ZenMux returned no subscription' };
  }
  const tier = data.plan?.tier;
  let plan = tierNames[tier] ?? tier ?? '';
  // a status past healthy is why requests may be held back
  if (data.account_status && data.account_status !== 'healthy') {
    plan = `${plan} · ${data.account_status}`.replace(/^ · /, '');
  }
  const windows = [];
  for (const [field, name, span] of windowsOf) {
    const q = data[field];
    if (!q || typeof q.usage_percentage !== 'number') continue;
    windows.push({
      name,
      used: Math.round(q.usage_percentage * 10000) / 100,
      ...(q.resets_at ? { resetsAt: q.resets_at } : {}),
      ...(typeof q.max_flows === 'number' && q.max_flows > 0
        ? { amount: q.used_flows ?? 0, limit: q.max_flows, unit: 'flows' }
        : {}),
      span,
    });
  }
  if (!windows.length) return { error: 'ZenMux told no usage windows' };
  return {
    plan,
    ...(data.plan?.expires_at ? { until: data.plan.expires_at } : {}),
    windows,
  };
}

export async function subscriptionUsage(getAuth, { fetchImpl = globalThis.fetch, managementUrl }) {
  const key = managementKeyOf(await getAuth());
  if (!key) {
    return { error: 'No Management API key: add this account again with one (sk-mg-v1-…, zenmux.ai/platform/management) to see its subscription usage' };
  }
  const response = await fetchImpl(`${managementUrl}/subscription/detail`, {
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    // 403 Invalid API key, 422 past the rate limit: said as ZenMux says it
    return { error: `ZenMux ${response.status}: ${payload?.message || response.statusText}` };
  }
  return readSubscription(payload);
}
