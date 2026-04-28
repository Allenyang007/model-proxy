import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let _config = null;

function buildFlatModels(providers = []) {
  const flatModels = [];
  for (const p of providers) {
    for (const m of (p.models || [])) {
      flatModels.push({
        key: `${p.name}/${m.id}`,
        providerName: p.name,
        modelId: m.id,
        label: m.label || m.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        apiType: p.apiType || 'openai-completions',
        model: m.id,
      });
    }
  }
  return flatModels;
}

function normalizeModelSelection(file, flatModels) {
  const validKeys = new Set(flatModels.map((model) => model.key));
  const firstKey = flatModels[0]?.key || '';

  let activeModel = file.activeModel || firstKey;
  if (activeModel && !validKeys.has(activeModel)) {
    console.warn(`[config] activeModel "${activeModel}" not found, falling back to "${firstKey}"`);
    activeModel = firstKey;
  }

  const fallbackModels = [];
  const seen = new Set();
  for (const key of Array.isArray(file.fallbackModels) ? file.fallbackModels : []) {
    if (!validKeys.has(key) || key === activeModel || seen.has(key)) continue;
    seen.add(key);
    fallbackModels.push(key);
  }

  return { activeModel, fallbackModels };
}

/**
 * Migrate old flat format to new nested format
 * Old: providers: [{ name, baseUrl, apiKey, model, apiType }]
 * New: providers: [{ name, baseUrl, apiKey, apiType, models: [{ id, label }] }]
 */
function migrateOldFormat(file) {
  if (!file.providers) return file;
  const needsMigration = file.providers.some(p => p.model && !p.models);
  if (!needsMigration) return file;

  const migrated = { ...file };
  migrated.providers = file.providers.map(p => {
    if (p.models) return p; // already new format
    // Convert: single model field → models array
    const { model, ...rest } = p;
    return {
      ...rest,
      models: [{ id: model, label: model }],
    };
  });

  // Set activeModel to first model of first provider if not set
  if (!migrated.activeModel && migrated.providers.length > 0 && migrated.providers[0].models?.length > 0) {
    migrated.activeModel = `${migrated.providers[0].name}/${migrated.providers[0].models[0].id}`;
  }

  return migrated;
}

export function loadConfig() {
  if (_config) return _config;

  const configPath = join(ROOT, 'config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const file = migrateOldFormat(yaml.load(raw));
  const flatModels = buildFlatModels(file.providers || []);
  const { activeModel, fallbackModels } = normalizeModelSelection(file, flatModels);

  _config = {
    host: file.host || '0.0.0.0',
    port: parseInt(process.env.MODEL_PROXY_PORT || file.port || '3000'),
    logLevel: process.env.MODEL_PROXY_LOG_LEVEL || file.logLevel || 'info',
    timeout: file.timeout || 100000,
    maxRetries: file.maxRetries || 5,
    parallelTimeout: file.parallelTimeout || 100000,
    auth: {
      enabled: file.auth?.enabled ?? false,
      username: file.auth?.username || 'admin',
      password: file.auth?.password || '',
    },
    activeModel,
    fallbackModels,
    providers: file.providers || [],
    flatModels,
  };

  if (_config.flatModels.length === 0) {
    throw new Error('No models configured in config.yaml');
  }

  return _config;
}

/**
 * Reload config from disk (for after config changes)
 */
export function reloadConfig() {
  _config = null;
  return loadConfig();
}
