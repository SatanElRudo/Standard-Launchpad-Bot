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
  assert(['us', 'eth', 'cn', 'kr'].includes(input.country), 'Ungültiges Handelspaar.');
  let wallet = '';
  if (input.wallet) {
    const raw = String(input.wallet).trim();
    if (raw.startsWith('0x') || raw.startsWith('0X')) {
      wallet = address(raw);
    } else {
      wallet = text(raw, 60, 'Wallet', false);
    }
  }

  // 1. After it graduates: Only in its own pool (default: true) vs Trades anywhere (false)
  let enforced = true;
  const rawEnforced = input.enforced ?? input.afterGraduates ?? input.after_graduates;
  if (rawEnforced != null && rawEnforced !== '') {
    if (typeof rawEnforced === 'boolean') enforced = rawEnforced;
    else {
      const s = String(rawEnforced).trim().toLowerCase();
      if (['false', '0', 'trades anywhere', 'anywhere', 'off', 'nein'].includes(s)) enforced = false;
    }
  }

  // 2. Hook module: Off (zeroAddress) vs custom address
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  let moduleAddress = zeroAddress;
  const rawModule = input.module ?? input.hookModule ?? input.hook_module;
  if (rawModule && !['off', 'none', 'false', '0', zeroAddress].includes(String(rawModule).trim().toLowerCase())) {
    try { moduleAddress = address(rawModule); } catch {}
  }

  // 3. Charter drop: default 10% (1000 bps)
  let charterDropBps = 1000;
  const rawDrop = input.charterDropBps ?? input.charterDrop ?? input.charter_drop;
  if (rawDrop != null && rawDrop !== '') {
    const s = String(rawDrop).trim().replace('%', '');
    if (/^(off|none|false|0)$/i.test(s)) {
      charterDropBps = 0;
    } else {
      const n = Number(s);
      if (Number.isFinite(n) && n >= 0) {
        charterDropBps = n <= 80 ? Math.round(n * 100) : Math.min(8000, Math.round(n));
      }
    }
  }

  // 4. Charter payout: default 1 (At exit) vs 0 (Per branch)
  let dropMode = 1;
  const rawMode = input.dropMode ?? input.charterPayout ?? input.charter_payout;
  if (rawMode != null && rawMode !== '') {
    const s = String(rawMode).trim().toLowerCase();
    if (['0', 'branch', 'per branch', 'per_branch'].includes(s)) dropMode = 0;
  }

  // 5. Dev buy: default off (0)
  let devBuy = 'off';
  let devBuyAmount = '0';
  const rawDevBuy = input.devBuy ?? input.dev_buy ?? input.devBuyAmount;
  if (rawDevBuy != null && rawDevBuy !== '' && !['off', 'none', '0', 'false'].includes(String(rawDevBuy).trim().toLowerCase())) {
    devBuy = String(rawDevBuy).trim();
    devBuyAmount = String(input.devBuyAmount ?? rawDevBuy).trim().replace(',', '.');
  }

  // 6. Snipe tax: default false (Off)
  let snipeTaxOn = false;
  const rawTax = input.snipeTaxOn ?? input.snipeTax ?? input.snipe_tax;
  if (rawTax != null && rawTax !== '') {
    if (typeof rawTax === 'boolean') snipeTaxOn = rawTax;
    else {
      const s = String(rawTax).trim().toLowerCase();
      if (['true', '1', 'on', 'ja', 'yes'].includes(s)) snipeTaxOn = true;
    }
  }

  // 7. Referrer (Fees / Points go to): default zeroAddress (or fee recipient)
  let referrer = zeroAddress;
  const rawRef = input.referrer ?? input.feeRecipient ?? input.fees_go_to ?? input.ref;
  if (rawRef && rawRef !== zeroAddress) {
    try { referrer = address(rawRef); } catch {}
  }

  return {
    name: text(input.name, 80, 'Tokenname'),
    symbol: text(input.symbol, 20, 'Symbol'),
    country: input.country,
    wallet,
    description: text(input.description ?? '', 500, 'Beschreibung', false),
    image: url(input.image, 'Bild'),
    website: url(input.website, 'Website'),
    metadataURI: url(input.metadataURI, 'Metadata-URL'),
    enforced,
    module: moduleAddress,
    charterDropBps,
    dropMode,
    devBuy,
    devBuyAmount,
    snipeTaxOn,
    referrer,
  };
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
  let curve = null;
  if (input.curve) {
    try { curve = address(input.curve); } catch {}
  }
  return {
    token: address(input.token),
    curve,
    country: ['us', 'eth', 'cn', 'kr'].includes(input.country) ? input.country : 'us',
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
    autoSell: Boolean(input.autoSell),
    autoSellMode: ['all', 'n_minus_1'].includes(input.autoSellMode) ? input.autoSellMode : 'all',
    autoSellExecuted: Boolean(input.autoSellExecuted),
    sellResults: Array.isArray(input.sellResults) ? input.sellResults : null,
  };
}
