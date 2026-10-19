import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../shared/rules.mjs';
const now = 1_800_000_000_000;
const monitor = overrides => ({ id: 'm1', name: 'Test', token: '0x1', enabled: true, mode: 'any', holdSeconds: 0, cooldownSeconds: 60, once: true,
  rules: [{ metric: 'marketCapUsd', operator: 'gte', threshold: 100 }], ...overrides });
const sample = overrides => ({ asOfTime: now / 1000, stale: false, marketCapUsd: 100, priceUsd: 1, launchedAt: now / 1000 - 60, ...overrides });
test('inclusive threshold fires once, preserves baseline and disables monitor', () => {
  const result = evaluateRules(monitor(), sample(), now);
  assert.ok(result.alert); assert.equal(result.monitor.enabled, false); assert.equal(result.monitor.baselinePrice, 1);
  assert.equal(evaluateRules(result.monitor, sample(), now).alert, null);
});
test('AND requires every metric; missing/null cannot count as zero', () => {
  const m = monitor({ mode: 'all', rules: [{ metric: 'marketCapUsd', operator: 'gte', threshold: 100 }, { metric: 'liquidityUsd', operator: 'lte', threshold: 10 }] });
  assert.equal(evaluateRules(m, sample({ liquidityUsd: null }), now).alert, null);
  assert.ok(evaluateRules(m, sample({ liquidityUsd: 0 }), now).alert);
});
test('stale, missing, future and regressing timestamps never trigger', () => {
  for (const s of [sample({ stale: true }), sample({ asOfTime: now / 1000 - 61 }), sample({ asOfTime: null }), sample({ asOfTime: now / 1000 + 31 })]) {
    const result = evaluateRules(monitor(), s, now); assert.equal(result.alert, null); assert.ok(result.monitor.error);
  }
  assert.equal(evaluateRules(monitor({ lastAsOf: now / 1000 + 1 }), sample(), now).alert, null);
  const interrupted = evaluateRules(monitor({ conditionSince: now - 10000 }), sample({ stale: true }), now);
  assert.equal(interrupted.monitor.conditionSince, null);
});
test('hold time requires continuous truth; a false sample resets it', () => {
  let m = monitor({ holdSeconds: 10 });
  m = evaluateRules(m, sample(), now).monitor;
  assert.equal(evaluateRules(m, sample(), now + 9999).alert, null);
  assert.ok(evaluateRules(m, sample(), now + 10000).alert);
  m = evaluateRules(m, sample({ marketCapUsd: 99 }), now + 9000).monitor;
  assert.equal(m.conditionSince, null);
  assert.equal(evaluateRules(m, sample(), now + 10000).alert, null);
});
test('repeat mode latches, requires recrossing and respects cooldown', () => {
  let m = monitor({ once: false });
  m = evaluateRules(m, sample(), now).monitor;
  assert.equal(evaluateRules(m, sample({ asOfTime: (now + 61000) / 1000 }), now + 61000).alert, null);
  m = evaluateRules(m, sample({ marketCapUsd: 50 }), now + 1000).monitor;
  assert.equal(evaluateRules(m, sample(), now + 2000).alert, null);
  assert.ok(evaluateRules(m, sample({ asOfTime: (now + 61000) / 1000 }), now + 61000).alert);
});
test('price change and drawdown use observed prices; missing price never triggers', () => {
  let m = monitor({ rules: [{ metric: 'drawdownPct', operator: 'gte', threshold: 20 }] });
  m = evaluateRules(m, sample({ priceUsd: 10 }), now).monitor;
  m = evaluateRules(m, sample({ priceUsd: 20 }), now).monitor;
  assert.equal(evaluateRules(m, sample({ priceUsd: null }), now).alert, null);
  assert.ok(evaluateRules(m, sample({ priceUsd: 15 }), now).alert);
  m = monitor({ rules: [{ metric: 'priceChangePct', operator: 'gte', threshold: 50 }] });
  m = evaluateRules(m, sample({ priceUsd: 10 }), now).monitor;
  assert.ok(evaluateRules(m, sample({ priceUsd: 15 }), now).alert);
});
