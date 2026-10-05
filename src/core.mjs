// Derived from ZenMux's @zenmux/opencode-oauth 0.1.2 (MIT, see LICENSE): its
// model catalog. Sign-in is an API key, with an optional Management API key
// beside it for the subscription's usage (usage.mjs) in magpie.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { managementKeyPrompt, subscriptionUsage } from './usage.mjs';

export const providerId = 'zenmux';

const modelCacheSchemaVersion = 2;
const protocolPriority = ['anthropic-messages', 'openai-responses', 'openai-completions'];
const protocolAliases = new Map([
  ['anthropic', 'anthropic-messages'],
  ['anthropic-messages', 'anthropic-messages'],
  ['messages', 'anthropic-messages'],
  ['openai-responses', 'openai-responses'],
  ['responses', 'openai-responses'],
  ['chat.completions', 'openai-completions'],
  ['chat-completions', 'openai-completions'],
  ['openai-completions', 'openai-completions'],
]);

export function resolveRuntimeConfig(env = process.env, homeDir = homedir()) {
  const apiBaseUrl = (env.ZENMUX_API_BASE_URL || 'https://zenmux.ai/api/v1').replace(/\/$/, '');
  const origin = new URL(apiBaseUrl).origin;
  const anthropicBaseUrl = (env.ZENMUX_ANTHROPIC_BASE_URL || `${origin}/api/anthropic/v1`).replace(/\/$/, '');
  const managementUrl = (env.ZENMUX_MANAGEMENT_URL || `${origin}/api/v1/management`).replace(/\/$/, '');
  const modelCatalogUrl = env.ZENMUX_MODEL_CATALOG_URL || `${origin}/api/frontend/model/available/list`;
  const cacheRoot = env.XDG_CACHE_HOME || env.LOCALAPPDATA || join(homeDir, '.cache');

  return {
    apiBaseUrl,
    anthropicBaseUrl,
    modelCatalogUrl,
    managementUrl,
    modelCachePath: join(cacheRoot, 'opencode', 'zenmux', 'models.json'),
  };
}

function collectModelProtocols(model) {
  const protocols = [];
  const append = (value) => {
    if (Array.isArray(value)) {
      value.forEach(append);
    } else if (typeof value === 'string') {
      value.split(',').forEach((item) => protocols.push(item.trim().toLowerCase()));
    }
  };

  append(model.api);
  append(model.protocols);
  append(model.supported_endpoint_types);
  append(model.capabilities?.protocols);
  for (const endpoint of model.endpoints ?? []) {
    append(endpoint.api);
    append(endpoint.suitable_api);
    for (const adapter of endpoint.adapters ?? []) append(adapter.api);
  }
  return protocols;
}

export function resolveOpenCodeProtocol(model) {
  const supported = new Set(
    collectModelProtocols(model).map((protocol) => protocolAliases.get(protocol)).filter(Boolean),
  );
  return protocolPriority.find((protocol) => supported.has(protocol));
}

function protocolApi(protocol, config) {
  if (protocol === 'anthropic-messages') {
    return { npm: '@ai-sdk/anthropic', url: config.anthropicBaseUrl };
  }
  if (protocol === 'openai-responses') {
    return { npm: '@ai-sdk/openai', url: config.apiBaseUrl };
  }
  return { npm: '@ai-sdk/openai-compatible', url: config.apiBaseUrl };
}

function endpointValues(model, field) {
  return (model.endpoints ?? [])
    .map((endpoint) => Number(endpoint?.[field]))
    .filter(Number.isFinite);
}

function minimumEndpointValue(model, field, fallback = 0) {
  const values = endpointValues(model, field);
  return values.length ? Math.min(...values) : fallback;
}

function maximumEndpointValue(model, field, fallback = 0) {
  const values = endpointValues(model, field);
  return values.length ? Math.max(...values) : fallback;
}

function supportsParameter(model, parameter) {
  return (model.endpoints ?? []).some((endpoint) =>
    (endpoint.adapters ?? []).some((adapter) =>
      (adapter.supported_parameters ?? []).includes(parameter),
    ),
  );
}

export function toOpenCodeModel(model, config) {
  const id = model.slug || model.id;
  const protocol = resolveOpenCodeProtocol(model);
  if (!id || !protocol) return undefined;

  const input = Array.isArray(model.input_modalities) ? model.input_modalities : ['text'];
  const output = Array.isArray(model.output_modalities) ? model.output_modalities : ['text'];
  const reasoning = model.capabilities?.reasoning === true
    || (model.endpoints ?? []).some((endpoint) => Number(endpoint.supports_reasoning) > 0);
  const toolcall = (model.endpoints ?? []).some(
    (endpoint) => endpoint.supports_tool_parameters === true
      || Number(endpoint.supports_tool_parameters) > 0,
  ) || supportsParameter(model, 'tools');

  return {
    id,
    providerID: providerId,
    name: model.display_name || model.name || id,
    family: 'zenmux',
    api: {
      id,
      ...protocolApi(protocol, config),
    },
    status: 'active',
    headers: {},
    options: {},
    cost: {
      input: minimumEndpointValue(model, 'pricing_prompt'),
      output: minimumEndpointValue(model, 'pricing_completion'),
      cache: {
        read: minimumEndpointValue(model, 'pricing_input_cache_read'),
        write: minimumEndpointValue(model, 'pricing_input_cache_write'),
      },
    },
    limit: {
      context: Number(model.context_length)
        || maximumEndpointValue(model, 'context_length')
        || 128000,
      output: Number(model.max_completion_tokens)
        || maximumEndpointValue(model, 'max_completion_tokens')
        || 16384,
    },
    capabilities: {
      temperature: supportsParameter(model, 'temperature'),
      reasoning,
      attachment: input.includes('image') || input.includes('pdf'),
      toolcall,
      input: {
        text: input.includes('text'),
        audio: input.includes('audio'),
        image: input.includes('image'),
        video: input.includes('video'),
        pdf: input.includes('pdf'),
      },
      output: {
        text: output.includes('text'),
        audio: output.includes('audio'),
        image: output.includes('image'),
        video: output.includes('video'),
        pdf: output.includes('pdf'),
      },
      interleaved: false,
    },
    release_date: model.release_date || '',
  };
}

export function createModelCacheEntry(models, config, checkedAt = Date.now()) {
  return {
    schemaVersion: modelCacheSchemaVersion,
    apiBaseUrl: config.apiBaseUrl,
    anthropicBaseUrl: config.anthropicBaseUrl,
    modelCatalogUrl: config.modelCatalogUrl,
    models,
    checkedAt,
  };
}

export function restoreCachedModels(entry, config) {
  if (
    entry?.schemaVersion !== modelCacheSchemaVersion
    || entry.apiBaseUrl !== config.apiBaseUrl
    || entry.anthropicBaseUrl !== config.anthropicBaseUrl
    || entry.modelCatalogUrl !== config.modelCatalogUrl
    || typeof entry.models !== 'object'
    || entry.models === null
    || Array.isArray(entry.models)
  ) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(entry.models).filter(([id, model]) =>
      Boolean(id) && model?.id === id && model.providerID === providerId,
    ),
  );
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export function createZenMuxPlugin(options = {}) {
  const config = resolveRuntimeConfig(options.env, options.homeDir);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;

  async function discoverModels() {
    const response = await fetchImpl(config.modelCatalogUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload.data)) {
      throw new Error(`ZenMux model discovery failed (${response.status})`);
    }

    return Object.fromEntries(
      payload.data
        .map((model) => toOpenCodeModel(model, config))
        .filter(Boolean)
        .map((model) => [model.id, model]),
    );
  }

  async function cachedModels() {
    return restoreCachedModels(await readJson(config.modelCachePath, undefined), config);
  }

  return async function ZenMuxPlugin() {
    return {
      provider: {
        id: providerId,
        async models(provider) {
          const cached = await cachedModels();
          try {
            const discovered = await discoverModels();
            if (!Object.keys(discovered).length) {
              return { ...provider.models, ...cached };
            }
            await writeJsonAtomic(
              config.modelCachePath,
              createModelCacheEntry(discovered, config, now()),
            ).catch(() => {});
            return { ...provider.models, ...discovered };
          } catch {
            return { ...provider.models, ...cached };
          }
        },
      },
      auth: {
        provider: providerId,
        methods: [
          {
            type: 'api',
            label: 'ZenMux API key',
            placeholder: 'sk-ss-v1-…  ·  zenmux.ai/platform/subscription',
            prompts: [managementKeyPrompt],
          },
        ],
        usage: (getAuth) => subscriptionUsage(getAuth, { fetchImpl, managementUrl: config.managementUrl }),
      },
    };
  };
}
