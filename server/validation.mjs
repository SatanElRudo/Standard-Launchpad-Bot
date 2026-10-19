import { isAddress, getAddress } from 'viem';
import { metricLabels } from '../shared/rules.mjs';
export function assert(condition, message) { if (!condition) { const e = new Error(message); e.status = 400; throw e; } }
export function address(value) { assert(typeof value === 'string' && isAddress(value), 'Ungültige Wallet- oder Token-Adresse.'); return getAddress(value); }
export function text(value, max, name, required = true) {
  assert(typeof value === 'string', `${name} fehlt.`);
  const result = value.trim();
  assert((!required || result.length > 0) && result.length <= max && !/[\u0000-\u0008\u000b-\u001f]/.test(result), `${name}: ungültig oder zu lang (max. ${max}).`);
  return result;
}
export function url(value, name, required = false) {
  const result = text(value ?? '', 2048, name, required);
  if (!result) return '';
  let parsed; try { parsed = new URL(result); } catch { assert(false, `${name}: ungültige URL.`); }
  assert(['https:', 'ipfs:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.hostname, `${name}: HTTPS- oder IPFS-URL erforderlich.`);
  return result;
}
export function draft(input) {
  assert(['us', 'cn', 'kr'].includes(input.country), 'Ungültiges Handelspaar.');
  let wallet = '';
  if (input.wallet) {
    const raw = String(input.wallet).trim();
    if (raw.startsWith('0x') || raw.startsWith('0X')) {
      wallet = address(raw);
    } else {
      wallet = text(raw, 60, 'Wallet', false);
    }
  }
  return { name: text(input.name, 80, 'Tokenname'), symbol: text(input.symbol, 20, 'Symbol'), country: input.country,
    wallet, description: text(input.description ?? '', 500, 'Beschreibung', false),
    image: url(input.image, 'Bild'), website: url(input.website, 'Website'), metadataURI: url(input.metadataURI, 'Metadata-URL') };
}
export function monitor(input) {
  assert(Array.isArray(input.rules) && input.rules.length > 0 && input.rules.length <= 10, '1 bis 10 Regeln erforderlich.');
  const rules = input.rules.map(rule => {
    assert(Object.hasOwn(metricLabels, rule.metric) && ['gte', 'lte'].includes(rule.operator), 'Ungültige Trigger-Regel.');
    assert(typeof rule.threshold === 'number' && Number.isFinite(rule.threshold), 'Schwelle muss eine endliche Zahl sein.');
    assert(rule.metric === 'priceChangePct' || rule.threshold >= 0, 'Schwelle darf nicht negativ sein.');
    return { metric: rule.metric, operator: rule.operator, threshold: rule.threshold };
  });
  assert(['any', 'all'].includes(input.mode), 'Ungültige Regelverknüpfung.');
  for (const [key, max] of [['holdSeconds', 3600], ['cooldownSeconds', 86400]]) {
    assert(Number.isInteger(input[key]) && input[key] >= 0 && input[key] <= max, `${key}: Wert außerhalb des erlaubten Bereichs.`);
  }
  assert(typeof input.once === 'boolean', 'Einmal-Option fehlt.');
  let creatorWallet = null;
  if (input.creatorWallet) {
    try { creatorWallet = address(input.creatorWallet); } catch {}
  }
  return {
    token: address(input.token),
    name: text(input.name, 80, 'Monitorname'),
    rules,
    mode: input.mode,
    holdSeconds: input.holdSeconds,
    cooldownSeconds: input.cooldownSeconds,
    once: input.once,
    enabled: true,
    creatorWallet,
    creatorLabel: input.creatorLabel ? text(input.creatorLabel, 80, 'Creator-Label', false) : null,
    purchases: Array.isArray(input.purchases) ? input.purchases : [],
  };
}
