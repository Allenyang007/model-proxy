import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { reloadConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.yaml');

export function readRawConfig() {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return yaml.load(raw);
}

export function writeRawConfig(data) {
  const yamlStr = yaml.dump(data, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });
  writeFileSync(CONFIG_PATH, yamlStr, 'utf-8');
}

function getAllModelKeys(config) {
  const keys = new Set();
  for (const p of (config.providers || [])) {
    for (const m of (p.models || [])) {
      keys.add(`${p.name}/${m.id}`);
    }
  }
  return keys;
}

function normalizeActiveModelValue(config) {
  const validKeys = getAllModelKeys(config);
  if (config.activeModel && validKeys.has(config.activeModel)) return config.activeModel;
  const firstModel = findFirstModel(config.providers);
  return firstModel ? `${firstModel.providerName}/${firstModel.id}` : '';
}

function normalizeFallbackModelsValue(config, models = config.fallbackModels, activeModel = normalizeActiveModelValue(config)) {
  const validKeys = getAllModelKeys(config);
  const normalized = [];
  const seen = new Set();

  for (const key of Array.isArray(models) ? models : []) {
    if (!validKeys.has(key) || key === activeModel || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

function normalizeModelSelection(config) {
  config.activeModel = normalizeActiveModelValue(config);
  config.fallbackModels = normalizeFallbackModelsValue(config, config.fallbackModels, config.activeModel);
  return config;
}

// --- Provider CRUD ---

export function getProviders() {
  const config = normalizeModelSelection(readRawConfig());
  return config.providers || [];
}

export function getProvidersSafe() {
  const config = normalizeModelSelection(readRawConfig());
  return (config.providers || []).map(p => ({
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: maskApiKey(p.apiKey),
    apiKeyFull: p.apiKey || '',
    apiType: p.apiType,
    models: (p.models || []).map(m => ({ id: m.id, label: m.label || m.id })),
  }));
}

export function addProvider(provider) {
  const config = normalizeModelSelection(readRawConfig());
  if (!config.providers) config.providers = [];

  if (config.providers.some(p => p.name === provider.name)) {
    throw new Error(`Provider "${provider.name}" already exists`);
  }

  config.providers.push({
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiType: provider.apiType || 'openai-completions',
    models: (provider.models || []).map(m => ({
      id: m.id,
      label: m.label || m.id,
    })),
  });

  normalizeModelSelection(config);
  writeRawConfig(config);
  reloadConfig();
  return config.providers;
}

export function updateProvider(name, updates) {
  const config = normalizeModelSelection(readRawConfig());
  if (!config.providers) throw new Error('No providers configured');

  const provider = config.providers.find(p => p.name === name);
  if (!provider) throw new Error(`Provider "${name}" not found`);

  if (updates.baseUrl !== undefined) provider.baseUrl = updates.baseUrl;
  if (updates.apiKey !== undefined) provider.apiKey = updates.apiKey;
  if (updates.apiType !== undefined) provider.apiType = updates.apiType;
  if (updates.models !== undefined) {
    provider.models = updates.models.map(m => ({ id: m.id, label: m.label || m.id }));
  }
  if (updates.name !== undefined && updates.name !== name) {
    if (config.providers.some(p => p.name === updates.name)) {
      throw new Error(`Provider "${updates.name}" already exists`);
    }
    // Update activeModel reference if needed
    if (config.activeModel?.startsWith(name + '/')) {
      config.activeModel = updates.name + '/' + config.activeModel.slice(name.length + 1);
    }
    config.fallbackModels = (config.fallbackModels || []).map(key => (
      key.startsWith(name + '/') ? updates.name + '/' + key.slice(name.length + 1) : key
    ));
    provider.name = updates.name;
  }

  normalizeModelSelection(config);
  writeRawConfig(config);
  reloadConfig();
  return config.providers;
}

export function deleteProvider(name) {
  const config = normalizeModelSelection(readRawConfig());
  if (!config.providers) throw new Error('No providers configured');

  const idx = config.providers.findIndex(p => p.name === name);
  if (idx === -1) throw new Error(`Provider "${name}" not found`);

  config.providers.splice(idx, 1);

  // Fix activeModel if it pointed to deleted provider
  if (config.activeModel?.startsWith(name + '/')) {
    const firstProvider = config.providers[0];
    config.activeModel = firstProvider && firstProvider.models?.length > 0
      ? `${firstProvider.name}/${firstProvider.models[0].id}`
      : '';
  }
  config.fallbackModels = (config.fallbackModels || []).filter(key => !key.startsWith(name + '/'));

  normalizeModelSelection(config);
  writeRawConfig(config);
  reloadConfig();
  return config.providers;
}

export function reorderProviders(order) {
  const config = normalizeModelSelection(readRawConfig());
  if (!config.providers) throw new Error('No providers configured');

  const byName = new Map(config.providers.map(p => [p.name, p]));
  const reordered = [];
  for (const name of order) {
    const p = byName.get(name);
    if (!p) throw new Error(`Provider "${name}" not found`);
    reordered.push(p);
  }
  for (const p of config.providers) {
    if (!order.includes(p.name)) reordered.push(p);
  }

  config.providers = reordered;
  normalizeModelSelection(config);
  writeRawConfig(config);
  reloadConfig();
  return config.providers;
}

// --- Model CRUD within Provider ---

export function addModel(providerName, model) {
  const config = normalizeModelSelection(readRawConfig());
  const provider = (config.providers || []).find(p => p.name === providerName);
  if (!provider) throw new Error(`Provider "${providerName}" not found`);

  if (!provider.models) provider.models = [];
  if (provider.models.some(m => m.id === model.id)) {
    throw new Error(`Model "${model.id}" already exists in provider "${providerName}"`);
  }

  provider.models.push({ id: model.id, label: model.label || model.id });
  normalizeModelSelection(config);
  writeRawConfig(config);
  reloadConfig();
  return provider.models;
}

export function deleteModel(providerName, modelId) {
  const config = normalizeModelSelection(readRawConfig());
  const provider = (config.providers || []).find(p => p.name === providerName);
  if (!provider) throw new Error(`Provider "${providerName}" not found`);

  const idx = (provider.models || []).findIndex(m => m.id === modelId);
  if (idx === -1) throw new Error(`Model "${modelId}" not found in provider "${providerName}"`);

  provider.models.splice(idx, 1);

  // Fix activeModel if it pointed to deleted model
  const deletedKey = `${providerName}/${modelId}`;
  if (config.activeModel === deletedKey) {
    const firstModel = provider.models[0] || findFirstModel(config.providers);
    config.activeModel = firstModel ? `${firstModel.providerName}/${firstModel.id}` : '';
  }
  config.fallbackModels = (config.fallbackModels || []).filter(key => key !== deletedKey);

  normalizeModelSelection(config);
  writeRawConfig(config);
  reloadConfig();
  return provider.models;
}

export function updateModel(providerName, modelId, updates) {
  const config = normalizeModelSelection(readRawConfig());
  const provider = (config.providers || []).find(p => p.name === providerName);
  if (!provider) throw new Error(`Provider "${providerName}" not found`);

  const model = (provider.models || []).find(m => m.id === modelId);
  if (!model) throw new Error(`Model "${modelId}" not found in provider "${providerName}"`);

  if (updates.label !== undefined) model.label = updates.label;
  if (updates.id !== undefined && updates.id !== modelId) {
    if (provider.models.some(m => m.id === updates.id)) {
      throw new Error(`Model "${updates.id}" already exists in provider "${providerName}"`);
    }
    // Update activeModel reference
    const oldKey = `${providerName}/${modelId}`;
    if (config.activeModel === oldKey) {
      config.activeModel = `${providerName}/${updates.id}`;
    }
    config.fallbackModels = (config.fallbackModels || []).map(key => (
      key === oldKey ? `${providerName}/${updates.id}` : key
    ));
    model.id = updates.id;
  }

  normalizeModelSelection(config);
  writeRawConfig(config);
  reloadConfig();
  return provider.models;
}

// --- Active Model ---

export function getActiveModel() {
  const config = normalizeModelSelection(readRawConfig());
  return config.activeModel || '';
}

export function setActiveModel(modelKey) {
  const config = normalizeModelSelection(readRawConfig());
  // Validate modelKey exists
  const allModels = getAllModelKeys(config);
  if (!allModels.has(modelKey)) throw new Error(`Model "${modelKey}" not found`);

  config.activeModel = modelKey;
  config.fallbackModels = normalizeFallbackModelsValue(config, config.fallbackModels, modelKey);
  writeRawConfig(config);
  reloadConfig();
  return modelKey;
}

// --- Fallback Models ---

export function getFallbackModels() {
  const config = normalizeModelSelection(readRawConfig());
  return config.fallbackModels || [];
}

export function setFallbackModels(models) {
  const config = normalizeModelSelection(readRawConfig());
  const allModels = getAllModelKeys(config);

  for (const key of Array.isArray(models) ? models : []) {
    if (!allModels.has(key)) throw new Error(`Model "${key}" not found in any provider`);
  }

  config.fallbackModels = normalizeFallbackModelsValue(config, models, config.activeModel);
  writeRawConfig(config);
  reloadConfig();
  return config.fallbackModels;
}

// --- Helpers ---

function findFirstModel(providers) {
  for (const p of (providers || [])) {
    if (p.models?.length > 0) return { providerName: p.name, ...p.models[0] };
  }
  return null;
}

function maskApiKey(key) {
  if (!key || key.length < 12) return key;
  return key.slice(0, 8) + '...' + key.slice(-4);
}
