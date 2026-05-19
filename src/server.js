import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './utils.js';
import { handleRequest } from './orchestrator.js';
import { buildHeaders, convertRequest } from './provider.js';
import { getStats, getLogs, getTokenStats, getHourlyStats, getProviderStatus } from './tracker.js';
import {
  readRawConfig, writeRawConfig,
  getProviders, getProvidersSafe,
  addProvider, updateProvider, deleteProvider, reorderProviders,
  addModel, deleteModel, updateModel,
  getActiveModel, setActiveModel,
  getFallbackModels, setFallbackModels,
} from './configManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let config = loadConfig();
setLogLevel(config.logLevel);

const SESSION_TOKEN = randomBytes(32).toString('hex');
const AUTH_ENABLED = config.auth.enabled;
const AUTH_USERNAME = config.auth.username;
const AUTH_PASSWORD = config.auth.password;

logger.info(`Model Proxy starting on port ${config.port}`);
logger.info(`Active model: ${config.activeModel}`);
logger.info(`Providers: ${config.providers.map(p => `${p.name}(${p.models?.length||0} models)`).join(', ')}`);
logger.info(`Auth: ${AUTH_ENABLED ? 'enabled' : 'disabled'}`);

function reload() {
  try {
    config = loadConfig();
    setLogLevel(config.logLevel);
    logger.info(`[config] Reloaded: activeModel=${config.activeModel}, providers=${config.providers.length}`);
  } catch (err) {
    logger.error('[config] Reload failed:', err.message);
  }
}

function normalizeProviderPayload(body = {}) {
  const payload = { ...body };

  if (!payload.models && payload.model) {
    payload.models = [{ id: payload.model, label: payload.modelLabel || payload.model }];
  }

  if (Array.isArray(payload.models)) {
    payload.models = payload.models
      .map((model) => (typeof model === 'string'
        ? { id: model, label: model }
        : { id: model.id, label: model.label || model.id }))
      .filter((model) => model.id);
  }

  return payload;
}

function getProvidersFull() {
  return getProviders().map((provider) => ({
    ...provider,
    apiKeyFull: provider.apiKey || '',
    model: provider.models?.[0]?.id || '',
  }));
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url?.split('?')[0] || '';
  const isPublic = (req.method === 'GET' && url === '/health') ||
    (req.method === 'GET' && url === '/api/auth/check') ||
    (req.method === 'POST' && url === '/api/auth/login') ||
    (req.method === 'GET' && (url === '/' || url === '/index.html')) ||
    url.startsWith('/v1/');

  if (AUTH_ENABLED && !isPublic) {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (token !== SESSION_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }));
      return;
    }
  }

  try {
    await handleRoute(req, res, url);
  } catch (err) {
    logger.error('Unhandled error:', err);
    if (!res.writableEnded) {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  }
});

async function handleRoute(req, res, url) {
  // --- Auth ---
  if (req.method === 'POST' && url === '/api/auth/login') {
    const body = JSON.parse(await readBody(req));
    if (body.username === AUTH_USERNAME && body.password === AUTH_PASSWORD) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: SESSION_TOKEN }));
      logger.info(`[auth] Login: ${body.username}`);
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '用户名或密码错误' } }));
    }
    return;
  }

  if (req.method === 'GET' && url === '/api/auth/check') {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    const authenticated = AUTH_ENABLED ? (token === SESSION_TOKEN) : true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: AUTH_ENABLED, authenticated }));
    return;
  }

  // --- Health ---
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeModel: config.activeModel, models: config.flatModels.length }));
    return;
  }

  // --- Stats ---
  if (req.method === 'GET' && url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStats()));
    return;
  }

  if (req.method === 'GET' && url === '/api/tokens') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getTokenStats()));
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/hourly')) {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const hours = Math.min(parseInt(params.get('hours') || '24'), 48);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getHourlyStats(hours)));
    return;
  }

  if (req.method === 'GET' && url === '/api/provider-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getProviderStatus()));
    return;
  }

  // --- Logs ---
  if (req.method === 'GET' && url.startsWith('/api/logs')) {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const limit = Math.min(parseInt(params.get('limit') || '50'), 200);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getLogs(limit)));
    return;
  }

  // --- Health check (live) ---
  if (req.method === 'GET' && url === '/api/health-check') {
    const results = await Promise.allSettled(
      config.flatModels.map(async (entry) => {
        const start = Date.now();
        // Skip providers with placeholder API keys (e.g., OAuth-based providers)
        if (!entry.apiKey || entry.apiKey === 'placeholder') {
          return { key: entry.key, provider: entry.providerName, model: entry.modelId, ok: true, status: 0, elapsed: 0, skipped: true };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const probe = convertRequest(entry, {
            model: entry.model,
            messages: [{ role: 'user', content: 'ok' }],
            max_tokens: 4,
            temperature: 0,
            stream: false,
          });
          const r = await fetch(probe.url, {
            method: 'POST',
            headers: buildHeaders(entry),
            body: JSON.stringify(probe.body),
            signal: ctrl.signal,
          });
          const payload = await r.text();
          return {
            key: entry.key,
            provider: entry.providerName,
            model: entry.modelId,
            ok: r.ok,
            status: r.status,
            elapsed: Date.now() - start,
            mode: 'inference',
            endpoint: probe.url,
            ...(r.ok ? {} : { error: payload.slice(0, 300) }),
          };
        } catch (err) {
          return {
            key: entry.key,
            provider: entry.providerName,
            model: entry.modelId,
            ok: false,
            elapsed: Date.now() - start,
            mode: 'inference',
            error: err.message,
          };
        } finally {
          clearTimeout(timer);
        }
      })
    );
    const data = results.map((r) => r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // --- Active Model ---
  if (req.method === 'GET' && url === '/api/active-model') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ activeModel: config.activeModel }));
    return;
  }

  if (req.method === 'PUT' && url === '/api/active-model') {
    const body = JSON.parse(await readBody(req));
    if (!body.modelKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'modelKey is required' }));
      return;
    }
    try {
      const key = setActiveModel(body.modelKey);
      reload();
      logger.info(`[config] Active model changed to: ${key}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, activeModel: key }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Providers ---
  if (req.method === 'GET' && url === '/api/providers-full') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getProvidersFull()));
    return;
  }

  if (req.method === 'GET' && url === '/api/providers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getProvidersSafe()));
    return;
  }

  if (req.method === 'POST' && url === '/api/providers') {
    const body = normalizeProviderPayload(JSON.parse(await readBody(req)));
    if (!body.name || !body.baseUrl || !body.apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name, baseUrl, apiKey are required' }));
      return;
    }
    try {
      const providers = addProvider(body);
      reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, providers: providers.length }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Fallback Models ---
  if (req.method === 'GET' && url === '/api/fallback-models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFallbackModels()));
    return;
  }

  if (req.method === 'PUT' && url === '/api/fallback-models') {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.models)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'models (string[]) is required' }));
      return;
    }
    try {
      setFallbackModels(body.models);
      reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Provider reorder
  if (req.method === 'POST' && url === '/api/providers/reorder') {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.order)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'order (string[]) is required' }));
      return;
    }
    try {
      reorderProviders(body.order);
      reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Update / Delete provider
  if (req.method === 'PUT' && url.startsWith('/api/providers/') && !url.includes('/models')) {
    const name = decodeURIComponent(url.replace('/api/providers/', ''));
    const body = normalizeProviderPayload(JSON.parse(await readBody(req)));
    try {
      updateProvider(name, body);
      reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'DELETE' && url.startsWith('/api/providers/') && !url.includes('/models')) {
    const name = decodeURIComponent(url.replace('/api/providers/', ''));
    try {
      deleteProvider(name);
      reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Models within Provider ---
  // POST /api/providers/:name/models
  const addModelMatch = url.match(/^\/api\/providers\/([^/]+)\/models$/);
  if (req.method === 'POST' && addModelMatch) {
    const providerName = decodeURIComponent(addModelMatch[1]);
    const body = JSON.parse(await readBody(req));
    if (!body.id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'model id is required' }));
      return;
    }
    try {
      const models = addModel(providerName, body);
      reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, models }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // DELETE /api/providers/:name/models/:id
  const deleteModelMatch = url.match(/^\/api\/providers\/([^/]+)\/models\/(.+)$/);
  if (req.method === 'DELETE' && deleteModelMatch) {
    const providerName = decodeURIComponent(deleteModelMatch[1]);
    const modelId = decodeURIComponent(deleteModelMatch[2]);
    try {
      const models = deleteModel(providerName, modelId);
      reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, models }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // PUT /api/providers/:name/models/:id
  const updateModelMatch = url.match(/^\/api\/providers\/([^/]+)\/models\/(.+)$/);
  if (req.method === 'PUT' && updateModelMatch) {
    const providerName = decodeURIComponent(updateModelMatch[1]);
    const modelId = decodeURIComponent(updateModelMatch[2]);
    const body = JSON.parse(await readBody(req));
    try {
      const models = updateModel(providerName, modelId, body);
      reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, models }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Config ---
  if (req.method === 'GET' && url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      port: config.port,
      timeout: config.timeout,
      maxRetries: config.maxRetries,
      parallelTimeout: config.parallelTimeout,
      activeModel: config.activeModel,
      providerCount: config.providers.length,
      modelCount: config.flatModels.length,
    }));
    return;
  }

  // --- Restart ---
  if (req.method === 'POST' && url === '/api/restart') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Restarting...' }));
    logger.info('[config] Restart requested');
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  // --- Codex OAuth ---
  if (req.method === 'GET' && url === '/api/codex/status') {
    try {
      const homeDir = process.env.HOME || '/root';
      const authPath = join(homeDir, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
      let status = { configured: false };
      if (existsSync(authPath)) {
        const authData = JSON.parse(readFileSync(authPath, 'utf-8'));
        const codexProfile = authData?.profiles?.['openai-codex:default'] || authData?.['openai-codex:default'];
        if (codexProfile) {
          const now = Date.now();
          const expires = codexProfile.expires || 0;
          status = {
            configured: true,
            type: codexProfile.type || 'unknown',
            hasToken: !!(codexProfile.access || codexProfile.refresh),
            expires: expires,
            expired: expires > 0 && expires < now,
            expiresIn: expires > 0 ? Math.max(0, Math.floor((expires - now) / 86400000)) : 0,
          };
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: false, error: err.message }));
    }
    return;
  }

  // --- Chat completions ---
  if (req.method === 'POST' && url === '/v1/chat/completions') {
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const streaming = parsed.stream === true;

    await handleRequest({ body: parsed, streaming }, res, config);

    if (!res.writableEnded) res.end();
    return;
  }

  // --- Static ---
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const htmlPath = join(__dirname, '..', 'public', 'index.html');
    if (existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(htmlPath, 'utf-8'));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close(() => { logger.info('Server closed'); process.exit(0); });
  setTimeout(() => { logger.warn('Forced exit'); process.exit(1); }, 30000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(config.port, config.host || '0.0.0.0', () => {
  logger.info(`Model Proxy listening on http://127.0.0.1:${config.port}`);
  logger.info(`Dashboard: http://127.0.0.1:${config.port}/`);
});
