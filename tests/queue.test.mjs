import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../shared/csv.mjs';
import { importQueue, readQueueImage, parseMonitorConfig } from '../server/queue.mjs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('CSV handles UTF-8 BOM, semicolon, escaped quotes and multiline fields', () => {
  const csv = '\uFEFFname;symbol;country;description\r\n"A; B";AB;us;"Line 1\nLine ""2"""\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1); assert.equal(rows[0].name, 'A; B'); assert.equal(rows[0].description, 'Line 1\nLine "2"');
  assert.throws(() => parseCsv('name,name,country\na,b,us'), /Kopfzeile/);
  assert.throws(() => parseCsv('name,symbol,country\n"Bad,A,us'), /nicht geschlossen/);
  assert.throws(() => parseCsv('name,symbol,country\na,b,us,x'), /Spaltenanzahl/);
});
test('template imports, paths stay within assets and files are size/type checked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'standard-assets-')), assets = join(root, 'assets');
  await mkdir(assets);
  try {
    const rows = importQueue(await readFile('examples/launch-queue.csv', 'utf8'), assets);
    assert.equal(rows.length, 3); assert.equal(rows[0].metadataURI, '');
    assert.equal(rows[1].imagePath, join(assets, 'dein-token.png'));
    assert.throws(() => importQueue('name,symbol,country,image_path\nBad,BAD,us,../secret.png', assets), /assets/);
    assert.throws(() => importQueue('name,symbol,country,image_path\nBad,BAD,us,assets/a.svg', assets), /PNG/);
    await writeFile(join(assets, 'dein-token.png'), Buffer.from('not an image'));
    await assert.rejects(readQueueImage(rows[1], assets), /Bildformat/);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(assets, 'dein-token.png'), png);
    const image = await readQueueImage(rows[1], assets); assert.equal(image.type, 'image/png'); assert.deepEqual(image.data, png);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parseMonitorConfig correctly extracts monitor rules and options from CSV rows', () => {
  // 1. Explicit rules string with operator >=
  const cfg1 = parseMonitorConfig({
    monitor_rules: 'marketCapUsd>=200000;gain>=50;drawdown>=25',
    monitor_mode: 'all',
    monitor_hold_seconds: '5',
    monitor_cooldown_seconds: '120',
    monitor_once: 'true',
  });
  assert.equal(cfg1.enabled, true);
  assert.equal(cfg1.mode, 'all');
  assert.equal(cfg1.holdSeconds, 5);
  assert.equal(cfg1.cooldownSeconds, 120);
  assert.equal(cfg1.once, true);
  assert.equal(cfg1.rules.length, 3);
  assert.deepEqual(cfg1.rules[0], { metric: 'marketCapUsd', operator: 'gte', threshold: 200000 });
  assert.deepEqual(cfg1.rules[1], { metric: 'priceChangePct', operator: 'gte', threshold: 50 });
  assert.deepEqual(cfg1.rules[2], { metric: 'drawdownPct', operator: 'gte', threshold: 25 });

  // 2. Shortcut columns
  const cfg2 = parseMonitorConfig({
    monitor_mcap_gte: '350000',
    monitor_price_change_gte: '100',
  });
  assert.equal(cfg2.enabled, true);
  assert.equal(cfg2.rules.length, 2);
  assert.deepEqual(cfg2.rules[0], { metric: 'marketCapUsd', operator: 'gte', threshold: 350000 });
  assert.deepEqual(cfg2.rules[1], { metric: 'priceChangePct', operator: 'gte', threshold: 100 });

  // 3. Disabled monitor
  const cfg3 = parseMonitorConfig({ monitor_enabled: 'false' });
  assert.equal(cfg3.enabled, false);

  // 4. Default empty row -> returns null (fallback to auto-launcher default)
  const cfg4 = parseMonitorConfig({});
  assert.equal(cfg4, null);
});

test('draft and queue import correctly set new V3 launch settings and defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'standard-vhooks-')), assets = join(root, 'assets');
  await mkdir(assets);
  try {
    // 1. Default row without explicit settings
    const defaultCsv = 'name,symbol,country\nAlpha,ALP,us\n';
    const rows = importQueue(defaultCsv, assets);
    assert.equal(rows.length, 1);
    const row = rows[0];

    // Must match the user's requested defaults:
    // - after graduates: only in its own pool (enforced: true)
    // - hook module: off (module: zeroAddress)
    // - charter drop: 10% (charterDropBps: 1000)
    // - payout: at exit (dropMode: 1)
    // - dev buy: off
    // - snipe tax: off (snipeTaxOn: false)
    assert.equal(row.enforced, true);
    assert.equal(row.module, '0x0000000000000000000000000000000000000000');
    assert.equal(row.charterDropBps, 1000);
    assert.equal(row.dropMode, 1);
    assert.equal(row.devBuy, 'off');
    assert.equal(row.snipeTaxOn, false);

    // 2. Custom row with explicit overrides
    const customCsv = 'name,symbol,country,after_graduates,charter_drop,charter_payout,snipe_tax\nBeta,BET,eth,trades anywhere,5%,per branch,on\n';
    const customRows = importQueue(customCsv, assets);
    const customRow = customRows[0];
    assert.equal(customRow.country, 'eth');
    assert.equal(customRow.enforced, false);
    assert.equal(customRow.charterDropBps, 500);
    assert.equal(customRow.dropMode, 0);
    assert.equal(customRow.snipeTaxOn, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

