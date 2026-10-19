export const metricLabels = {
  marketCapUsd: 'Market Cap (USD)', volume24hUsd: 'Volumen · rollierende 24 h (USD)',
  liquidityUsd: 'Liquidität (USD)', priceUsd: 'Preis (USD)',
  priceChangePct: 'Kursänderung seit Monitoring (%)', drawdownPct: 'Rückgang vom beobachteten Hoch (%)',
  trades24h: 'Trades · rollierende 24 h', ageMinutes: 'Token-Alter (Minuten)',
};
export function evaluateRules(monitor, sample, now = Date.now()) {
  // No evaluation against missing, stale, regressing or future data.
  if (sample.stale || !Number.isFinite(sample.asOfTime) || now - sample.asOfTime * 1000 > 60_000 ||
      sample.asOfTime * 1000 > now + 30_000 || (monitor.lastAsOf && sample.asOfTime < monitor.lastAsOf)) {
    return { monitor: { ...monitor, conditionSince: null, error: 'Marktdaten veraltet oder ungültig. Trigger pausiert.' }, alert: null };
  }
  const next = { ...monitor, error: null, lastAsOf: sample.asOfTime, snapshot: sample, lastChecked: now };
  const validPrice = Number.isFinite(sample.priceUsd) && sample.priceUsd > 0;
  if (validPrice && !(next.baselinePrice > 0)) next.baselinePrice = sample.priceUsd;
  if (validPrice) next.highPrice = Math.max(next.highPrice || 0, sample.priceUsd);
  const metrics = {
    ...sample,
    priceChangePct: validPrice && next.baselinePrice > 0 ? (sample.priceUsd / next.baselinePrice - 1) * 100 : null,
    drawdownPct: validPrice && next.highPrice > 0 ? (1 - sample.priceUsd / next.highPrice) * 100 : null,
    ageMinutes: Number.isFinite(sample.launchedAt) && sample.launchedAt > 0 ? Math.max(0, (sample.asOfTime - sample.launchedAt) / 60) : null,
  };
  const checks = monitor.rules.map(rule => {
    const value = metrics[rule.metric];
    return Number.isFinite(value) && (rule.operator === 'gte' ? value >= rule.threshold : value <= rule.threshold);
  });
  const matched = checks.length > 0 && (monitor.mode === 'all' ? checks.every(Boolean) : checks.some(Boolean));
  if (!matched) { next.conditionSince = null; next.latched = false; }
  else if (next.conditionSince == null) next.conditionSince = now;
  const held = matched && now - next.conditionSince >= monitor.holdSeconds * 1000;
  const cooled = !monitor.lastAlertAt || now - monitor.lastAlertAt >= monitor.cooldownSeconds * 1000;
  let alert = null;
  if (monitor.enabled && held && cooled && !next.latched && (!monitor.once || !monitor.lastAlertAt)) {
    next.lastAlertAt = now; next.latched = true;
    if (monitor.once) next.enabled = false;
    alert = { token: monitor.token, monitorId: monitor.id, name: monitor.name, at: now,
      message: monitor.rules.filter((_, i) => checks[i]).map(r => `${metricLabels[r.metric]} ${r.operator === 'gte' ? '≥' : '≤'} ${r.threshold}`).join(' · '),
      metrics, read: false };
  }
  return { monitor: next, alert };
}
