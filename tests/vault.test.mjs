import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault } from '../server/vault.mjs';

function createMockStore() {
  const state = {};
  return { state, save: () => {} };
}

test('vault initialization and unlock validation', () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 1000 });

  assert.equal(vault.isInitialized(), false);
  assert.equal(vault.isUnlocked(), false);

  assert.throws(() => vault.init('short'), /mindestens 8 Zeichen/);
  vault.init('masterpassword123');
  assert.equal(vault.isInitialized(), true);
  assert.equal(vault.isUnlocked(), true);

  // Cannot re-init
  assert.throws(() => vault.init('anotherpassword'), /bereits initialisiert/);

  // Lock
  vault.lock();
  assert.equal(vault.isUnlocked(), false);

  // Wrong password
  assert.throws(() => vault.unlock('wrongpassword'), /Falsches Master-Passwort/);
  assert.equal(vault.isUnlocked(), false);

  // Correct password
  vault.unlock('masterpassword123');
  assert.equal(vault.isUnlocked(), true);
});

test('generate and import wallet with encrypted keys', () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('secure-pass-phrase');

  // Generate wallet
  const w1 = vault.createWallet('Main Deployer');
  assert.equal(w1.label, 'Main Deployer');
  assert.match(w1.address, /^0x[0-9a-fA-F]{40}$/);

  // Plain private key is NEVER in state
  const rawRecord = store.state.vault.wallets[0];
  assert.ok(rawRecord.ciphertext);
  assert.ok(rawRecord.iv);
  assert.ok(rawRecord.tag);
  assert.equal(rawRecord.privateKey, undefined);

  // Decrypt works when unlocked
  const pk1 = vault.getPrivateKey(w1.id);
  assert.match(pk1, /^0x[0-9a-fA-F]{64}$/);

  // Import wallet
  const knownPk = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const w2 = vault.importWallet('Imported Key', knownPk);
  assert.equal(w2.label, 'Imported Key');
  const pk2 = vault.getPrivateKey(w2.address);
  assert.equal(pk2.toLowerCase(), knownPk.toLowerCase());

  // Export with password verification
  assert.throws(() => vault.exportWallet(w2.id, 'wrong-pass'), /Falsches Master-Passwort/);
  const exported = vault.exportWallet(w2.id, 'secure-pass-phrase');
  assert.equal(exported.privateKey.toLowerCase(), knownPk.toLowerCase());

  // Lock prevents getting keys
  vault.lock();
  assert.throws(() => vault.getPrivateKey(w1.id), /Tresor ist gesperrt/);
  assert.throws(() => vault.createWallet('New'), /Tresor ist gesperrt/);
});

test('auto lock timer locks vault after timeout', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 50 });
  vault.init('auto-lock-password');
  assert.equal(vault.isUnlocked(), true);

  await new Promise(r => setTimeout(r, 80));
  assert.equal(vault.isUnlocked(), false);
});
