const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = 1;

export function setLogLevel(level) {
  currentLevel = LOG_LEVELS[level] ?? 1;
}

function log(level, ...args) {
  if ((LOG_LEVELS[level] ?? 0) < currentLevel) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
};

/**
 * fetch with timeout support using AbortController
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 100000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Request timeout after ${timeoutMs}ms`);
      timeoutErr.code = 'ETIMEDOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if HTTP status should trigger fallback
 */
export function shouldFallback(status) {
  // 400 and 401: don't fallback
  if (status === 400 || status === 401) return false;
  // Everything else that's not 2xx: fallback
  if (status < 200 || status >= 300) return true;
  return false;
}

/**
 * Generate a random ID
 */
export function generateId(prefix = 'chatcmpl') {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}-${id}`;
}
