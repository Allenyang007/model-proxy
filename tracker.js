/**
 * In-memory request tracker with token usage stats
 * Retains data for 7 days
 */

const MAX_LOGS = 5000; // generous limit, time-based cleanup handles retention
const RETENTION_MS = 7 * 24 * 3600 * 1000; // 7 days

const logs = [];
const stats = {
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  totalLatency: 0,
  startTime: Date.now(),
  providerStats: {},
  totalTokensIn: 0,
  totalTokensOut: 0,
  tokenByProvider: {},
  hourlyRequests: {},
  hourlyTokens: {},
};

function cleanup() {
  const cutoff = Date.now() - RETENTION_MS;

  // Clean old logs
  while (logs.length > 0 && logs[logs.length - 1].timestamp < cutoff) {
    logs.pop();
  }

  // Clean old hourly buckets
  const cutoffHour = new Date(cutoff).toISOString().slice(0, 13);
  for (const key of Object.keys(stats.hourlyRequests)) {
    if (key < cutoffHour) {
      delete stats.hourlyRequests[key];
      delete stats.hourlyTokens[key];
    }
  }
}

// Cleanup every 10 minutes
setInterval(cleanup, 10 * 60 * 1000);

export function recordRequest({ provider, phase, success, statusCode, elapsed, error, tokensIn, tokensOut, model }) {
  stats.totalRequests++;
  if (success) {
    stats.successCount++;
  } else {
    stats.errorCount++;
  }
  stats.totalLatency += elapsed;

  if (!stats.providerStats[provider]) {
    stats.providerStats[provider] = { total: 0, success: 0, error: 0, totalLatency: 0, tokensIn: 0, tokensOut: 0, lastUsed: 0 };
  }
  const ps = stats.providerStats[provider];
  ps.total++;
  if (success) ps.success++; else ps.error++;
  ps.totalLatency += elapsed;
  ps.tokensIn += tokensIn || 0;
  ps.tokensOut += tokensOut || 0;
  ps.lastUsed = Date.now();

  stats.totalTokensIn += tokensIn || 0;
  stats.totalTokensOut += tokensOut || 0;

  if (!stats.tokenByProvider[provider]) {
    stats.tokenByProvider[provider] = { in: 0, out: 0 };
  }
  stats.tokenByProvider[provider].in += tokensIn || 0;
  stats.tokenByProvider[provider].out += tokensOut || 0;

  const hourKey = new Date().toISOString().slice(0, 13);
  stats.hourlyRequests[hourKey] = (stats.hourlyRequests[hourKey] || 0) + 1;
  if (!stats.hourlyTokens[hourKey]) stats.hourlyTokens[hourKey] = { in: 0, out: 0 };
  stats.hourlyTokens[hourKey].in += tokensIn || 0;
  stats.hourlyTokens[hourKey].out += tokensOut || 0;

  logs.unshift({
    id: logs.length,
    timestamp: Date.now(),
    provider,
    phase,
    success,
    statusCode,
    elapsed,
    error: error ? String(error).slice(0, 200) : null,
    tokensIn: tokensIn || 0,
    tokensOut: tokensOut || 0,
    model: model || '',
  });

  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
}

export function getStats() {
  const uptime = Date.now() - stats.startTime;
  return {
    uptime,
    totalRequests: stats.totalRequests,
    successCount: stats.successCount,
    errorCount: stats.errorCount,
    successRate: stats.totalRequests > 0
      ? ((stats.successCount / stats.totalRequests) * 100).toFixed(1) + '%'
      : 'N/A',
    avgLatency: stats.totalRequests > 0
      ? Math.round(stats.totalLatency / stats.totalRequests) + 'ms'
      : 'N/A',
    totalTokensIn: stats.totalTokensIn,
    totalTokensOut: stats.totalTokensOut,
    totalTokens: stats.totalTokensIn + stats.totalTokensOut,
    providerStats: Object.fromEntries(
      Object.entries(stats.providerStats).map(([name, s]) => [
        name,
        {
          ...s,
          successRate: s.total > 0 ? ((s.success / s.total) * 100).toFixed(1) + '%' : 'N/A',
          avgLatency: s.total > 0 ? Math.round(s.totalLatency / s.total) + 'ms' : 'N/A',
        },
      ])
    ),
  };
}

export function getTokenStats() {
  return {
    totalIn: stats.totalTokensIn,
    totalOut: stats.totalTokensOut,
    total: stats.totalTokensIn + stats.totalTokensOut,
    byProvider: stats.tokenByProvider,
  };
}

export function getHourlyStats(hours = 168) {
  const now = new Date();
  const buckets = [];
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000);
    const key = d.toISOString().slice(0, 13);
    buckets.push({
      hour: key.slice(11) + ':00',
      date: key.slice(0, 10),
      requests: stats.hourlyRequests[key] || 0,
      tokensIn: stats.hourlyTokens[key]?.in || 0,
      tokensOut: stats.hourlyTokens[key]?.out || 0,
    });
  }
  return buckets;
}

export function getProviderStatus() {
  return Object.entries(stats.providerStats).map(([name, s]) => ({
    name,
    total: s.total,
    success: s.success,
    error: s.error,
    successRate: s.total > 0 ? ((s.success / s.total) * 100).toFixed(1) + '%' : 'N/A',
    avgLatency: s.total > 0 ? Math.round(s.totalLatency / s.total) + 'ms' : '-',
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    lastUsed: s.lastUsed,
  }));
}

export function getLogs(limit = 50) {
  return logs.slice(0, limit);
}
