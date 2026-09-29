'use strict';

function normalizeWindow(window, fallbackLabel) {
  if (!window || typeof window !== 'object') return null;
  const used = window.usedPercent;
  if (!Number.isFinite(used)) return null;
  const duration = Number(window.windowDurationMins);
  const seconds = Number(window.resetsAt);
  return {
    label: Number.isFinite(duration) && duration > 0 ? durationLabel(duration) : fallbackLabel,
    shortLabel: Number.isFinite(duration) && duration > 0 ? compactDurationLabel(duration) : fallbackLabel,
    usedPercent: Math.max(0, Math.min(100, used)),
    remainingPercent: Math.max(0, Math.min(100, 100 - used)),
    resetsAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
  };
}

function durationLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}天`;
  if (minutes % 60 === 0) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

function compactDurationLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function progressBar(percent) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round(value * 5 / 100);
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
}

function normalizeSnapshot(rateResponse, accountResponse) {
  if (!rateResponse || typeof rateResponse !== 'object') throw new Error('额度响应为空');
  const byId = rateResponse.rateLimitsByLimitId;
  const entries = byId && typeof byId === 'object' && !Array.isArray(byId)
    ? Object.entries(byId).filter(([, value]) => value && typeof value === 'object')
    : [];
  const legacy = rateResponse.rateLimits;
  if (legacy && typeof legacy === 'object' && !entries.some(([id]) => id === (legacy.limitId || 'codex'))) {
    entries.push([legacy.limitId || 'codex', legacy]);
  }
  entries.sort(([a], [b]) => (a === 'codex' ? -1 : b === 'codex' ? 1 : a.localeCompare(b)));

  const buckets = entries.map(([id, value]) => ({
    id,
    name: typeof value.limitName === 'string' && value.limitName.trim()
      ? value.limitName.trim()
      : id === 'codex' ? 'Codex' : id,
    model: typeof value.normalModelSlug === 'string' ? value.normalModelSlug : null,
    primary: normalizeWindow(value.primary, '短周期'),
    secondary: normalizeWindow(value.secondary, '长周期'),
    reached: value.rateLimitReachedType || null
  }));

  const account = accountResponse && accountResponse.account;
  return {
    accountType: account && account.type || null,
    email: account && account.type === 'chatgpt' && typeof account.email === 'string' ? account.email : null,
    plan: account && account.type === 'chatgpt' ? account.planType : (legacy && legacy.planType) || null,
    ordinaryUsageAllowed: rateResponse.ordinaryUsageAllowed === false ? false : null,
    buckets
  };
}

module.exports = { normalizeSnapshot, durationLabel, compactDurationLabel, progressBar };
