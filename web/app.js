import { metricLabels } from '../shared/rules.mjs';
import { deployment } from '../shared/deployment.mjs';
import { createWalletSession } from './wallet-session.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const money = value => Number.isFinite(value) ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 8 : 2 }).format(value) : '—';
const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
const date = value => value ? new Date(value).toLocaleString('de-DE') : '—';

let state, account, activeProvider, prepared, pendingHash, editingMonitor;
let loadingState = false, receiptChecking = false, providers = [], localImage;
let vaultWallets = [];
let vaultStatus = { initialized: false, unlocked: false };
let exportingWalletId = null;
let stockBalances = {};
let pendingSnipe = null;
let pendingLaunchMonitor = null;
let claimableFeesMap = {};
let autoLauncherFormInitialized = false;
let lastWalletChoiceSig = '';
const alerted = new Set();
let booted = false;
let fastPoller = null;
function updateFastPoller() {
  if (pendingHash && !fastPoller) {
    fastPoller = setInterval(() => { void checkReceipt(); }, 350);
  } else if (!pendingHash && fastPoller) {
    clearInterval(fastPoller);
    fastPoller = null;
  }
}

try { pendingHash = localStorage.getItem('standard:pending-launch'); updateFastPoller(); } catch {}

function show(message, error = false) {
  for (const el of [$('#notice'), $('#launch-feedback')]) {
    if (!el) continue;
    el.textContent = message; el.classList.toggle('is-error', error); el.hidden = false;
  }
}

function render(selector, html) { const el = $(selector); if (el && el.innerHTML !== html) el.innerHTML = html; }

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
const post = (path, data = {}) => api(path, { method: 'POST', body: JSON.stringify(data) });

async function busy(button, action) {
  const previous = button.disabled;
  button.disabled = true;
  try { return await action(); } catch (error) { show(error.shortMessage || error.message, true); }
  finally { button.disabled = previous; }
}

function navigate(page) {
  document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `page-${page}`);
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('#page-label').textContent = { launch: 'Token launchen', queue: 'Entwurfs-Queue', monitor: 'Monitoring', wallets: 'Wallets & Tresor', alerts: 'Alerts' }[page];
  if (page === 'queue') {
    void updateSnipeWallets(state.queue?.[0]?.country || 'us');
  }
}
document.querySelectorAll('.nav').forEach(button => button.onclick = () => navigate(button.dataset.page));

function addProvider(info, provider) {
  if (providers.some(p => p.provider === provider)) return;
  providers.push({ info, provider });
  const option = document.createElement('option'); option.value = String(providers.length - 1); option.textContent = info.name;
  $('#provider').append(option);
  if (providers.length === 1) $('#provider').value = '0';
}
window.addEventListener('eip6963:announceProvider', e => { if (e.detail?.info?.name && e.detail.provider?.request) addProvider(e.detail.info, e.detail.provider); });
window.dispatchEvent(new Event('eip6963:requestProvider'));
if (window.ethereum?.request) addProvider({ name: 'Browser-Wallet' }, window.ethereum);

const walletSession = createWalletSession((session, reason) => {
  account = session.account; activeProvider = session.provider; prepared = null;
  $('#review').close();
  $('#connect').textContent = account ? short(account) : 'Wallet verbinden ↗';
  if ($('#wallet-network-text')) {
    $('#wallet-network-text').textContent = !account ? 'Wallet noch nicht verbunden.' : session.chainId === deployment.chainId
      ? `Verbunden · ${short(account)} · Robinhood Chain (4663)`
      : `Wallet verbunden · Aktuell Chain ${session.chainId ?? 'unbekannt'} · Robinhood Chain (4663) erforderlich`;
  }
  if ($('#switch-chain')) $('#switch-chain').hidden = !account || session.chainId === deployment.chainId;
  if ($('#wallet-network')) $('#wallet-network').classList.toggle('wrong-chain', Boolean(account) && session.chainId !== deployment.chainId);
  if (account && !$('#launch-wallet').value) $('#launch-wallet').value = account;
  if (reason === 'chain') show(session.chainId === deployment.chainId ? 'Robinhood Chain aktiv. Deine Wallet bleibt verbunden.' : 'Netzwerk geändert. Über „Zu Robinhood wechseln“ kannst du zurückwechseln.');
  if (reason === 'disconnect' || (reason === 'accounts' && !account)) show('Die Wallet hat den Kontozugriff getrennt. Bitte erneut verbinden.', true);
});

function selectedProvider() {
  const selection = $('#provider').value;
  return selection === '' ? null : providers[Number(selection)]?.provider;
}
$('#provider').onchange = () => {
  walletSession.select(selectedProvider());
  if (selectedProvider()) void walletSession.connect(true).catch(e => show(e.message, true));
};
$('#connect').onclick = () => busy($('#connect'), async () => {
  walletSession.select(selectedProvider()); await walletSession.connect();
  show(`Wallet ${short(account)} verbunden.${walletSession.snapshot().chainId !== deployment.chainId ? ' Bitte beim Launch zu Robinhood Chain wechseln.' : ''}`);
});
if ($('#switch-chain')) {
  $('#switch-chain').onclick = () => busy($('#switch-chain'), async () => {
    show('Bitte den Netzwerkwechsel in deiner Wallet bestätigen.');
    try { await walletSession.ensureChain(); show('Robinhood Chain aktiv. Deine Wallet bleibt verbunden.'); }
    catch (e) { throw new Error(Number(e.code) === 4001 ? 'Netzwerkwechsel abgelehnt. Die Wallet bleibt verbunden; du kannst den Wechsel erneut anfragen.' : Number(e.code) === -32002 ? 'In der Wallet wartet bereits eine Anfrage. Bitte dort bestätigen oder schließen.' : e.message); }
  });
}

function getDraft() {
  const data = Object.fromEntries(new FormData($('#launch-form')));
  data.enforced = $('#launch-enforced') ? $('#launch-enforced').value === 'true' : true;
  data.charterDropBps = $('#launch-charter-drop') ? Number($('#launch-charter-drop').value) : 1000;
  data.dropMode = $('#launch-drop-mode') ? Number($('#launch-drop-mode').value) : 1;
  data.snipeTaxOn = $('#launch-snipe-tax') ? $('#launch-snipe-tax').value === 'true' : false;
  data.devBuy = $('#launch-dev-buy')?.value || 'off';
  if ($('#launch-hook-module')?.value === 'custom') {
    data.module = $('#launch-module-address')?.value?.trim() || '0x0000000000000000000000000000000000000000';
  } else {
    data.module = '0x0000000000000000000000000000000000000000';
  }
  return data;
}

if ($('#launch-hook-module')) {
  $('#launch-hook-module').onchange = e => {
    const box = $('#hook-module-address-box');
    if (box) box.hidden = e.target.value !== 'custom';
  };
}
function preview() {
  const draft = getDraft(); prepared = null;
  $('#preview-name').textContent = draft.name || 'Dein Token';
  $('#preview-symbol').textContent = `$${draft.symbol || 'SYMBOL'}`;
  const pairInfo = deployment.stocks[draft.country] || deployment.stocks.us;
  $('#preview-pair').textContent = `${pairInfo.symbol} ↗`;
  $('#metadata-default-note').hidden = Boolean(draft.metadataURI.trim());
  const curMsg = `Kaufwährung: $${pairInfo.symbol} (Handelspaar ${pairInfo.symbol} · ${pairInfo.name}). Ausgewählte Tresor-Wallets kaufen sofort nach Bestätigung auf der Bonding-Curve ein.`;
  $('#snipe-currency-help').textContent = curMsg;
  $('#auto-snipe-currency-help').textContent = `Kaufwährung hängt vom Paar ab (z. B. $${pairInfo.symbol} für ${pairInfo.name}). Wähle bis zu 10 Wallets und Betrag:`;
  void updateSnipeWallets(draft.country);
}
$('#launch-form').addEventListener('input', preview);
$('#country').addEventListener('change', preview);

async function hostSelectedImageFile(file) {
  const statusEl = $('#host-status');
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.textContent = '⏳ Lade Bild hoch & generiere Metadaten...';
  }
  const reader = new FileReader();
  const base64Promise = new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
  });
  reader.readAsDataURL(file);
  const imageBase64 = await base64Promise;
  const draft = getDraft();
  const res = await post('/metadata/upload', {
    name: draft.name || 'Token',
    symbol: draft.symbol || 'TKN',
    description: draft.description || '',
    website: draft.website || '',
    imageBase64,
    imageFilename: file.name,
    imageMime: file.type,
  });
  $('#token-image').value = res.image;
  $('#token-metadata-uri').value = res.metadataURI;
  preview();
  if (statusEl) {
    statusEl.innerHTML = `✅ <strong>Erfolgreich gehostet!</strong> Bild-URL &amp; Metadata-URL automatisch eingetragen.`;
  }
  show('Bild und Metadaten wurden erfolgreich öffentlich gehostet!');
}

$('#image-file').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { e.target.value = ''; return show('Bitte PNG, JPG oder WebP bis 2 MB auswählen.', true); }
  const url = URL.createObjectURL(file), img = new Image();
  try { img.src = url; await img.decode(); } catch { URL.revokeObjectURL(url); return show('Die Bilddatei kann nicht gelesen werden.', true); }
  if (localImage) URL.revokeObjectURL(localImage); localImage = url;
  img.alt = 'Vorschau des gewählten Tokenbilds'; $('#preview-art').replaceChildren(img);
  show(`„${file.name}“ geladen. Klicke auf „Jetzt hosten“ oder lasse Bild/Metadaten für das Standardbild leer.`);
};

if ($('#auto-host-btn')) {
  $('#auto-host-btn').onclick = async () => {
    const file = $('#image-file')?.files?.[0];
    if (!file) {
      show('Bitte wähle zuerst über „Tokenbild auswählen“ eine Datei von deinem PC aus.', true);
      return;
    }
    await busy($('#auto-host-btn'), () => hostSelectedImageFile(file));
  };
}

if ($('#random-avatar-btn')) {
  $('#random-avatar-btn').onclick = async () => {
    const statusEl = $('#host-status');
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = '⏳ Wähle Meme-Avatar & hoste Metadaten...';
    }
    await busy($('#random-avatar-btn'), async () => {
      let assets = [];
      try { assets = await api('/sample-assets'); } catch {}
      const memes = assets.length ? assets.map(a => a.filename) : ['crocodile1.jpg', 'hippo1.jpg', 'parrot1.jpg', 'dog1.jpg', 'cat1.jpg'];
      const chosen = memes[Math.floor(Math.random() * memes.length)];
      const draft = getDraft();
      const res = await post('/metadata/upload', {
        name: draft.name || 'Token',
        symbol: draft.symbol || 'TKN',
        description: draft.description || '',
        website: draft.website || '',
        sampleAsset: chosen,
      });
      $('#token-image').value = res.image;
      $('#token-metadata-uri').value = res.metadataURI;
      const img = new Image();
      img.src = res.image;
      $('#preview-art').replaceChildren(img);
      preview();
      if (statusEl) {
        statusEl.innerHTML = `✅ <strong>Avatar „${chosen}“ erfolgreich gehostet!</strong> URLs eingetragen.`;
      }
      show(`Meme-Avatar „${chosen}“ wurde gewählt und öffentlich gehostet!`);
    });
  };
}

$('#wallet-choice').onchange = e => { $('#launch-wallet').value = e.target.value; preview(); };
$('#save-draft').onclick = () => busy($('#save-draft'), async () => { await post('/drafts', getDraft()); await refresh(); show('Entwurf lokal gespeichert. Bilddateien bitte separat behalten.'); });
$('#export-metadata').onclick = () => {
  const draft = getDraft();
  const metadata = { name: draft.name, symbol: draft.symbol, description: draft.description, ...(draft.image ? { image: draft.image } : {}), ...(draft.website ? { website: draft.website } : {}) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${draft.symbol.replace(/[^a-zA-Z0-9_-]/g, '') || 'token'}-metadata.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  show('Metadaten exportiert. JSON und Bild öffentlich hosten, dann die Metadata-URL im Entwurf eintragen.');
};

async function terms() {
  try {
    const t = await api('/terms');
    render('#terms', `<dl class="definition"><dt>Launch-Gebühr</dt><dd>${esc(t.feeEth)} ETH</dd><dt>Netzwerkgebühren</dt><dd>Zusätzlich · nach Simulation</dd><dt>Name / Symbol</dt><dd>${t.config.maxNameBytes} / ${t.config.maxSymbolBytes} Bytes</dd><dt>Metadata-URL</dt><dd>Max. ${t.config.maxUriBytes} Bytes</dd><dt>Zusätzliche Creator-Tax</dt><dd>0 %</dd><dt>Launch-Schutz</dt><dd>Aktiviert</dd><dt>Geprüft</dt><dd>${esc(new Date(t.checkedAt).toLocaleTimeString('de-DE'))}</dd></dl>`);
    if (Array.isArray(t.pairs) && t.pairs.length > 0) {
      const select = $('#country');
      if (select) {
        const cur = select.value;
        select.innerHTML = t.pairs.map(p => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${esc(p.symbol)} · ${esc(p.name)}</option>`).join('');
      }
    }
  } catch (e) { render('#terms', `<p class="error">Konditionen nicht verfügbar: ${esc(e.message)}</p>`); }
}
$('#refresh-terms').onclick = () => busy($('#refresh-terms'), terms);

// Snipe UI handlers
$('#launch-snipe-enabled').onchange = e => {
  $('#launch-snipe-box').hidden = !e.target.checked;
};
$('#auto-launcher-snipe-enabled').onchange = e => {
  $('#auto-launcher-snipe-box').hidden = !e.target.checked;
  if (e.target.checked) void updateSnipeWallets(state.queue?.[0]?.country || 'us');
};
if ($('#auto-snipe-select-all')) {
  $('#auto-snipe-select-all').onclick = () => {
    document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-checkbox').forEach(cb => cb.checked = true);
  };
}
if ($('#auto-snipe-select-none')) {
  $('#auto-snipe-select-none').onclick = () => {
    document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-checkbox').forEach(cb => cb.checked = false);
  };
}

function launchRuleRow(rule = { metric: 'marketCapUsd', operator: 'gte', threshold: 150000 }) {
  const row = document.createElement('div'); row.className = 'rule-row';
  row.innerHTML = `
    <select name="rule-metric">${Object.entries(metricLabels).map(([k, v]) => `<option value="${k}" ${k === rule.metric ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <select name="rule-operator"><option value="gte" ${rule.operator === 'gte' ? 'selected' : ''}>≥</option><option value="lte" ${rule.operator === 'lte' ? 'selected' : ''}>≤</option></select>
    <input name="rule-threshold" type="number" step="any" value="${rule.threshold}" required>
    <button type="button" class="icon-button" aria-label="Regel entfernen">×</button>
  `;
  row.querySelector('.icon-button').onclick = () => row.remove();
  $('#launch-rules-list')?.append(row);
}

if ($('#launch-add-rule-btn')) {
  $('#launch-add-rule-btn').onclick = () => launchRuleRow();
}
if ($('#launch-monitor-enabled')) {
  $('#launch-monitor-enabled').onchange = e => {
    if ($('#launch-monitor-box')) $('#launch-monitor-box').hidden = !e.target.checked;
  };
}
if ($('#launch-monitor-auto-sell')) {
  $('#launch-monitor-auto-sell').onchange = e => {
    if ($('#launch-auto-sell-box')) $('#launch-auto-sell-box').hidden = !e.target.checked;
  };
}
if ($('#auto-launcher-auto-sell')) {
  $('#auto-launcher-auto-sell').onchange = e => {
    if ($('#auto-launcher-sell-mode-box')) $('#auto-launcher-sell-mode-box').hidden = !e.target.checked;
  };
}
if ($('#monitor-auto-sell')) {
  $('#monitor-auto-sell').onchange = e => {
    if ($('#monitor-auto-sell-box')) $('#monitor-auto-sell-box').hidden = !e.target.checked;
  };
}
launchRuleRow({ metric: 'marketCapUsd', operator: 'gte', threshold: 150000 });
launchRuleRow({ metric: 'priceChangePct', operator: 'gte', threshold: 50 });
launchRuleRow({ metric: 'drawdownPct', operator: 'gte', threshold: 30 });

$('#apply-snipe-amount-btn').onclick = () => {
  const raw = $('#snipe-default-amount').value;
  const val = String(raw ?? '').trim().replace(',', '.');
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) {
    show('Bitte einen gültigen Betrag größer als 0 eingeben.', true);
    return;
  }
  document.querySelectorAll('#snipe-wallets-list .snipe-amount-input').forEach(input => {
    input.value = val;
  });
  show(`Betrag ${val} auf alle Wallets angewendet.`);
};

async function updateSnipeWallets(country = 'us') {
  if (!vaultWallets.length) return;
  try {
    stockBalances = await api(`/vault/stock-balances?country=${country}`);
  } catch {
    stockBalances = {};
  }
  const isNative = country === 'eth' || Boolean(deployment.stocks[country]?.native);
  const symbol = isNative ? 'ETH' : (deployment.stocks[country]?.symbol || 'SPCX');

  // Render launch form snipe list
  const existingChecked = new Set();
  document.querySelectorAll('#snipe-wallets-list .snipe-checkbox:checked').forEach(cb => existingChecked.add(cb.dataset.walletId));
  const existingAmounts = {};
  document.querySelectorAll('#snipe-wallets-list .snipe-wallet-row').forEach(row => {
    const id = row.querySelector('.snipe-checkbox')?.dataset.walletId;
    const amt = row.querySelector('.snipe-amount-input')?.value;
    if (id && amt) existingAmounts[id] = amt;
  });

  render('#snipe-wallets-list', vaultWallets.map(w => {
    const bal = stockBalances[w.address.toLowerCase()] ?? '0';
    const checked = existingChecked.has(w.id);
    const amt = existingAmounts[w.id] ?? ($('#snipe-default-amount')?.value?.trim().replace(',', '.') || '0.05');
    return `
      <div class="item snipe-wallet-row">
        <div class="snipe-row">
          <input type="checkbox" class="snipe-checkbox" data-wallet-id="${esc(w.id)}" ${checked ? 'checked' : ''}>
          <div>
            <strong>🔒 ${esc(w.label)}</strong>
            <small>${esc(short(w.address))} · Guthaben: <strong>${esc(bal)} ${isNative ? 'ETH' : '$' + esc(symbol)}</strong></small>
          </div>
        </div>
        <div class="item-actions">
          <label class="snipe-label">Betrag:
            <input type="text" inputmode="decimal" class="snipe-amount-input snipe-amount" value="${esc(amt)}" placeholder="0.05">
          </label>
        </div>
      </div>
    `;
  }).join(''));

  // Attach max-10 limit
  document.querySelectorAll('#snipe-wallets-list .snipe-checkbox').forEach(cb => {
    cb.onchange = e => {
      const allChecked = document.querySelectorAll('#snipe-wallets-list .snipe-checkbox:checked');
      if (allChecked.length > 10) {
        e.target.checked = false;
        show('Maximal 10 Wallets für den Erstkauf erlaubt.', true);
      }
    };
  });

  // Render auto launcher snipe list
  const autoChecked = new Set();
  const autoAmounts = {};
  const existingAutoDoms = document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-checkbox');
  if (existingAutoDoms.length > 0) {
    document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-checkbox:checked').forEach(cb => autoChecked.add(cb.dataset.walletId));
    document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-wallet-row').forEach(row => {
      const id = row.querySelector('.auto-snipe-checkbox')?.dataset.walletId;
      const amt = row.querySelector('.auto-snipe-amount-input')?.value;
      if (id && amt) autoAmounts[id] = amt;
    });
  } else {
    (state.autoLauncher?.snipeOrders || []).forEach(o => {
      if (o.walletId) {
        autoChecked.add(o.walletId);
        autoAmounts[o.walletId] = o.amount;
      }
    });
  }

  render('#auto-snipe-wallets-list', vaultWallets.map(w => {
    const bal = stockBalances[w.address.toLowerCase()] ?? '0';
    const checked = autoChecked.has(w.id);
    const amt = autoAmounts[w.id] ?? '0.05';
    return `
      <div class="item auto-snipe-wallet-row">
        <div class="snipe-row">
          <input type="checkbox" class="auto-snipe-checkbox" data-wallet-id="${esc(w.id)}" ${checked ? 'checked' : ''}>
          <div>
            <strong>🔒 ${esc(w.label)}</strong>
            <small>${esc(short(w.address))} · Guthaben: <strong>${esc(bal)} ${isNative ? 'ETH' : '$' + esc(symbol)}</strong></small>
          </div>
        </div>
        <div class="item-actions">
          <label class="snipe-label">Betrag:
            <input type="text" inputmode="decimal" class="auto-snipe-amount-input snipe-amount" value="${esc(amt)}" placeholder="0.05">
          </label>
        </div>
      </div>
    `;
  }).join(''));

  document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-checkbox').forEach(cb => {
    cb.onchange = e => {
      const allChecked = document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-checkbox:checked');
      if (allChecked.length > 10) {
        e.target.checked = false;
        show('Maximal 10 Wallets für den Erstkauf erlaubt.', true);
      }
    };
  });
}

$('#launch-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  if (pendingHash) throw new Error('Eine gesendete Transaktion wird noch geprüft. Warte auf die Bestätigung oder prüfe sie im Explorer.');
  const draft = getDraft();
  if (!draft.wallet) throw new Error('Bitte eine Deployer-Adresse angeben oder auswählen.');
  
  const isVaultWallet = vaultWallets.some(w => w.address.toLowerCase() === draft.wallet.toLowerCase());
  if (isVaultWallet) {
    if (!vaultStatus.unlocked) throw new Error('Diese Wallet liegt im Tresor, aber der Tresor ist gesperrt. Bitte zuerst im Menü Wallets entsperren.');
  } else {
    if (!activeProvider || !account) throw new Error('Zuerst eine Browser-Wallet verbinden oder eine Tresor-Wallet wählen.');
    if (draft.wallet.toLowerCase() !== account.toLowerCase()) throw new Error('Die verbundene Browser-Wallet stimmt nicht mit der Deployer-Adresse überein.');
    await walletSession.ensureChain();
    if (draft.wallet.toLowerCase() !== account?.toLowerCase()) throw new Error('Die aktive Adresse wurde beim Netzwerkwechsel geändert. Bitte die Deployer-Adresse prüfen.');
  }

  // Collect optional snipe orders
  const snipeOrders = [];
  if ($('#launch-snipe-enabled').checked) {
    document.querySelectorAll('#snipe-wallets-list .snipe-wallet-row').forEach(row => {
      const cb = row.querySelector('.snipe-checkbox');
      if (cb && cb.checked) {
        const walletId = cb.dataset.walletId;
        const rawAmt = row.querySelector('.snipe-amount-input')?.value;
        const cleanAmt = String(rawAmt ?? '').trim().replace(',', '.');
        const amount = Number(cleanAmt);
        if (Number.isFinite(amount) && amount > 0) snipeOrders.push({ walletId, amount: cleanAmt });
      }
    });
    if (snipeOrders.length > 10) throw new Error('Maximal 10 Wallets für Erstkauf erlaubt.');
    if (snipeOrders.length === 0) throw new Error('Erstkauf ist aktiviert, aber es wurde keine Wallet ausgewählt.');
  }

  // Collect optional auto-monitor config
  let monitorConfig = null;
  if ($('#launch-monitor-enabled').checked) {
    const rules = [];
    document.querySelectorAll('#launch-rules-list .rule-row').forEach(row => {
      const metric = row.querySelector('[name="rule-metric"]')?.value;
      const operator = row.querySelector('[name="rule-operator"]')?.value;
      const threshold = Number(row.querySelector('[name="rule-threshold"]')?.value);
      if (metric && operator && Number.isFinite(threshold)) {
        rules.push({ metric, operator, threshold });
      }
    });
    if (rules.length === 0) throw new Error('Bitte mindestens eine Trigger-Regel für das automatische Monitoring definieren oder das Monitoring abwählen.');
    monitorConfig = {
      enabled: true,
      rules,
      mode: $('#launch-monitor-mode').value,
      holdSeconds: Number($('#launch-monitor-hold').value) || 0,
      cooldownSeconds: Number($('#launch-monitor-cooldown').value) || 60,
      once: $('#launch-monitor-once').value === 'true',
      autoSell: $('#launch-monitor-auto-sell')?.checked ?? false,
      autoSellMode: $('#launch-monitor-sell-mode')?.value || 'all',
    };
  }

  const revision = walletSession.snapshot().revision;
  const result = await post('/prepare', draft);
  if (!isVaultWallet && walletSession.snapshot().revision !== revision) throw new Error('Wallet oder Netzwerk hat sich während der Prüfung geändert. Bitte erneut prüfen.');
  prepared = { ...result, snipeOrders, monitorConfig };

  const snipeSummary = snipeOrders.length
    ? `<dt>Erstkauf (Snipe)</dt><dd>Aktiv (${snipeOrders.length} Wallets mit $${esc(deployment.stocks[draft.country].symbol)})</dd>`
    : '';
  const monitorSummary = monitorConfig
    ? `<dt>Auto-Monitoring</dt><dd>Aktiv (${monitorConfig.rules.length} Trigger-Regeln · Sofortiger Start)</dd>`
    : '<dt>Auto-Monitoring</dt><dd class="subtle">Deaktiviert</dd>';
  const autoSellSummary = (monitorConfig && monitorConfig.autoSell)
    ? `<dt>Auto-Exit bei Trigger</dt><dd>Aktiv (${monitorConfig.autoSellMode === 'n_minus_1' ? 'N-1 verkaufen (Günstigste behalten)' : '100% aller Wallets verkaufen'})</dd>`
    : '';

  render('#review-content', `<dl class="definition"><dt>Token</dt><dd>${esc(result.details.name)} ($${esc(result.details.symbol)})</dd><dt>Signatur über</dt><dd>${isVaultWallet ? '🔒 Tresor-Wallet (Server-Signatur)' : '🦊 Browser-Wallet'}</dd><dt>Wallet</dt><dd>${esc(result.transaction.from)}</dd><dt>Factory</dt><dd>${esc(result.transaction.to)}</dd><dt>Paar</dt><dd>${esc(state.deployment.stocks[result.details.country].symbol)}</dd><dt>Launch-Gebühr</dt><dd>${esc(result.terms.feeEth)} ETH</dd><dt>Geschätztes Gas + 20 % Puffer</dt><dd>${esc(result.estimatedGasEth)} ETH</dd><dt>Metadata-URL</dt><dd>${esc(result.details.metadataURI)}</dd>${snipeSummary}${monitorSummary}${autoSellSummary}<dt>Prüfung gültig bis</dt><dd>${esc(new Date(result.expiresAt).toLocaleTimeString('de-DE'))}</dd></dl><p id="sign-error" class="error" role="alert"></p>`);
  
  $('#send-vault-launch').hidden = !isVaultWallet;
  $('#send-launch').hidden = isVaultWallet;
  $('#review').showModal();
  if (result.metadataDefaultApplied) {
    const note = document.createElement('p'); note.className = 'field-help';
    note.textContent = 'Standard-Metadaten werden verwendet: Das Bild stammt vom Referenz-Token. Lokale Bildvorschau und Beschreibung verändern diese JSON nicht.';
    $('#review-content').prepend(note);
  }
}); };

$('#close-review').onclick = () => $('#review').close();

$('#send-launch').onclick = async () => {
  const button = $('#send-launch'); button.disabled = true; $('#close-review').disabled = true;
  try {
    if (!prepared || Date.now() > prepared.expiresAt) throw new Error('Die Prüfung ist abgelaufen. Bitte zurückgehen und den Launch erneut prüfen.');
    const current = prepared;
    const accounts = await activeProvider.request({ method: 'eth_accounts' });
    const chain = await activeProvider.request({ method: 'eth_chainId' });
    if (accounts[0]?.toLowerCase() !== current.transaction.from.toLowerCase() || Number(chain) !== 4663) throw new Error('Wallet oder Netzwerk stimmt nicht mehr überein. Erneut prüfen.');
    if (Date.now() > current.expiresAt || prepared !== current) throw new Error('Transaktionsprüfung abgelaufen oder Wallet geändert. Erneut prüfen.');
    const hash = await activeProvider.request({ method: 'eth_sendTransaction', params: [current.transaction] });
    pendingHash = hash;
    if (current.snipeOrders && current.snipeOrders.length > 0) {
      pendingSnipe = { hash, country: current.details.country, snipeOrders: current.snipeOrders };
    }
    if (current.monitorConfig && current.monitorConfig.enabled) {
      pendingLaunchMonitor = {
        name: `${current.details.name} ($${current.details.symbol})`,
        ...current.monitorConfig,
      };
    } else {
      pendingLaunchMonitor = null;
    }
    try { localStorage.setItem('standard:pending-launch', hash); } catch {}
    updateFastPoller();
    $('#review').close(); prepared = null;
    show(`Transaktion gesendet: ${hash}. Bestätigung wird geprüft. Nicht erneut senden.`);
    await checkReceipt();
  } catch (error) {
    const message = error.message || 'Transaktion fehlgeschlagen.';
    if ($('#sign-error')) $('#sign-error').textContent = message;
    show(message, true);
  } finally { button.disabled = false; $('#close-review').disabled = false; }
};

$('#send-vault-launch').onclick = () => busy($('#send-vault-launch'), async () => {
  if (!prepared || Date.now() > prepared.expiresAt) throw new Error('Die Prüfung ist abgelaufen. Bitte erneut prüfen.');
  const vWallet = vaultWallets.find(w => w.address.toLowerCase() === prepared.transaction.from.toLowerCase());
  if (!vWallet) throw new Error('Tresor-Wallet nicht gefunden.');
  const payload = {
    ...prepared.details,
    walletId: vWallet.id,
    snipeOrders: prepared.snipeOrders || [],
    monitor: prepared.monitorConfig,
  };
  const res = await post('/vault/launch', payload);
  pendingHash = res.hash;
  updateFastPoller();
  if (prepared.monitorConfig && prepared.monitorConfig.enabled) {
    pendingLaunchMonitor = {
      name: `${prepared.details.name} ($${prepared.details.symbol})`,
      ...prepared.monitorConfig,
    };
  }
  try { localStorage.setItem('standard:pending-launch', pendingHash); } catch {}
  $('#review').close(); prepared = null;
  show(`Transaktion mit Tresor signiert & gesendet: ${res.hash}. Bestätigung wird geprüft …`);
  await checkReceipt();
});

async function checkReceipt() {
  if (!pendingHash || receiptChecking) return;
  receiptChecking = true;
  try {
    const result = await api(`/launch/${pendingHash}`);
    if (result.status === 'pending') return;
    if (result.status === 'reverted') show('Die Launch-Transaktion wurde on-chain zurückgesetzt. Es wurde kein Token gelauncht; Gas kann verbraucht worden sein.', true);
    else {
      show(`${result.name} erfolgreich gelauncht: ${result.token}.`);
      $('#monitor-token').value = result.token;

      let snipeResults = [];
      // If there are pending snipe orders from browser wallet launch, run them now!
      if (pendingSnipe && pendingSnipe.hash === pendingHash && result.curve) {
        try {
          show(`Starte sofortigen Erstkauf für ${pendingSnipe.snipeOrders.length} Wallets …`);
          const snipeRes = await post('/snipe', {
            curve: result.curve,
            token: result.token,
            country: pendingSnipe.country,
            snipeOrders: pendingSnipe.snipeOrders,
            antiFrontrun: true,
          });
          snipeResults = snipeRes.results || [];
          const succ = snipeResults.filter(r => r.status === 'success');
          show(`Erstkauf abgeschlossen: ${succ.length} von ${pendingSnipe.snipeOrders.length} Wallets erfolgreich.`);
        } catch (se) {
          show(`Erstkauf fehlgeschlagen: ${se.message}`, true);
        }
        pendingSnipe = null;
      }

      // If pending launch monitor is configured, activate immediately!
      if (pendingLaunchMonitor && pendingLaunchMonitor.enabled) {
        try {
          await post('/monitors', {
            token: result.token,
            curve: result.curve,
            country: pendingSnipe?.country || 'us',
            name: pendingLaunchMonitor.name || `${result.name} · Launch-Monitor`,
            rules: pendingLaunchMonitor.rules,
            mode: pendingLaunchMonitor.mode || 'any',
            holdSeconds: pendingLaunchMonitor.holdSeconds ?? 10,
            cooldownSeconds: pendingLaunchMonitor.cooldownSeconds ?? 60,
            once: pendingLaunchMonitor.once ?? true,
            creatorWallet: result.wallet || account,
            creatorLabel: 'Deployer',
            purchases: snipeResults,
            autoSell: Boolean(pendingLaunchMonitor.autoSell),
            autoSellMode: pendingLaunchMonitor.autoSellMode || 'all',
          });
          show(`Token gelauncht & Monitoring für ${result.name} (${result.token}) sofort aktiv geschaltet!`);
        } catch (me) {
          console.warn('Auto-monitor error in checkReceipt:', me);
        }
        pendingLaunchMonitor = null;
      }
    }
    pendingHash = null; localStorage.removeItem('standard:pending-launch');
    updateFastPoller();
    await refresh();
  } catch (e) { show(`Gesendete Transaktion noch nicht sicher bestätigt: ${e.message}. Nicht erneut senden; Hash im Explorer prüfen.`, true); }
  finally { receiptChecking = false; }
}

function ruleRow(rule = { metric: 'marketCapUsd', operator: 'gte', threshold: 100000 }) {
  const row = document.createElement('div'); row.className = 'rule-row';
  row.innerHTML = `<label>Kennzahl<select class="metric">${Object.entries(metricLabels).map(([key, label]) => `<option value="${key}" ${rule.metric === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Vergleich<select class="operator"><option value="gte" ${rule.operator === 'gte' ? 'selected' : ''}>≥ mindestens</option><option value="lte" ${rule.operator === 'lte' ? 'selected' : ''}>≤ höchstens</option></select></label><label>Schwelle<input class="threshold" type="number" step="any" value="${esc(rule.threshold)}" required></label><button type="button" class="icon-button remove-rule" aria-label="Regel entfernen">×</button>`;
  row.querySelector('button').onclick = () => { if ($('#rules').children.length > 1) row.remove(); else show('Mindestens eine Regel ist erforderlich.', true); };
  $('#rules').append(row);
}
ruleRow();
$('#add-rule').onclick = () => { if ($('#rules').children.length < 10) ruleRow({ metric: 'volume24hUsd', operator: 'gte', threshold: 10000 }); };
$('#monitor-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  const data = Object.fromEntries(new FormData(e.target));
  const input = { ...data, holdSeconds: Number(data.holdSeconds), cooldownSeconds: Number(data.cooldownSeconds), once: e.target.elements.once.checked,
    autoSell: $('#monitor-auto-sell')?.checked ?? false,
    autoSellMode: $('#monitor-sell-mode')?.value || 'all',
    rules: [...$('#rules').children].map(row => ({ metric: row.querySelector('.metric').value, operator: row.querySelector('.operator').value, threshold: Number(row.querySelector('.threshold').value) })) };
  if (editingMonitor) await api(`/monitors/${editingMonitor}`, { method: 'PUT', body: JSON.stringify(input) });
  else await post('/monitors', input);
  editingMonitor = null; e.submitter.textContent = 'Monitoring starten →';
  await refresh(); show('Monitor gespeichert und aktiviert. Die erste gültige Kursprobe setzt die Vergleichsbasis.');
}); };

// Vault forms
$('#vault-init-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  const p1 = $('#init-password').value, p2 = $('#init-password-repeat').value;
  if (p1 !== p2) throw new Error('Die Passwörter stimmen nicht überein.');
  await post('/vault/init', { password: p1 });
  e.target.reset(); await refresh(); show('Tresor erfolgreich mit Master-Passwort eingerichtet und entsperrt!');
}); };

$('#vault-unlock-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  await post('/vault/unlock', { password: $('#unlock-password').value });
  e.target.reset(); await refresh(); show('Tresor entsperrt.');
}); };

$('#lock-vault-btn').onclick = () => busy($('#lock-vault-btn'), async () => {
  await post('/vault/lock', {});
  await refresh(); show('Tresor gesperrt.');
});

$('#vault-generate-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  await post('/vault/wallets/generate', Object.fromEntries(new FormData(e.target)));
  e.target.reset(); await refresh(); show('Neue EVM-Wallet im Tresor generiert und verschlüsselt.');
}); };

$('#vault-import-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  await post('/vault/wallets/import', Object.fromEntries(new FormData(e.target)));
  e.target.reset(); await refresh(); show('Private Key erfolgreich verschlüsselt im Tresor abgelegt.');
}); };

// Export Dialog
$('#close-export-btn').onclick = () => $('#export-dialog').close();
$('#export-key-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  if (!exportingWalletId) throw new Error('Keine Wallet ausgewählt.');
  const res = await post(`/vault/wallets/${exportingWalletId}/export`, { password: $('#export-master-password').value });
  $('#export-key-output').value = res.privateKey;
  $('#export-result-box').hidden = false;
  show('Schlüssel erfolgreich entschlüsselt. Behandle ihn vertraulich!');
}); };
$('#copy-export-key').onclick = () => {
  const val = $('#export-key-output').value;
  if (!val) return;
  navigator.clipboard.writeText(val);
  show('Private Key in die Zwischenablage kopiert!');
};

// Auto Launcher form
if ($('#auto-wallet-mode-single')) {
  $('#auto-wallet-mode-single').onchange = () => {
    $('#auto-launcher-single-box').hidden = false;
    $('#auto-launcher-rotate-box').hidden = true;
  };
}
if ($('#auto-wallet-mode-rotate')) {
  $('#auto-wallet-mode-rotate').onchange = () => {
    $('#auto-launcher-single-box').hidden = true;
    $('#auto-launcher-rotate-box').hidden = false;
  };
}
if ($('#rotate-select-all')) {
  $('#rotate-select-all').onclick = () => {
    document.querySelectorAll('#auto-rotate-wallets-list .auto-rotate-checkbox').forEach(cb => cb.checked = true);
  };
}
if ($('#rotate-select-none')) {
  $('#rotate-select-none').onclick = () => {
    document.querySelectorAll('#auto-rotate-wallets-list .auto-rotate-checkbox').forEach(cb => cb.checked = false);
  };
}

$('#auto-launcher-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  const enabled = $('#auto-launcher-enabled').checked;
  const intervalMinutes = Number($('#auto-launcher-interval').value);
  const walletMode = $('#auto-wallet-mode-rotate').checked ? 'rotate' : 'single';
  const defaultWalletId = $('#auto-launcher-default-wallet').value;
  
  const rotationWalletIds = [];
  document.querySelectorAll('#auto-rotate-wallets-list .auto-rotate-checkbox:checked').forEach(cb => {
    rotationWalletIds.push(cb.dataset.walletId);
  });
  if (walletMode === 'rotate' && rotationWalletIds.length === 0) {
    throw new Error('Bitte mindestens eine Wallet für die automatische Rotation auswählen.');
  }

  const snipeOrders = [];
  if ($('#auto-launcher-snipe-enabled').checked) {
    document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-wallet-row').forEach(row => {
      const cb = row.querySelector('.auto-snipe-checkbox');
      if (cb && cb.checked) {
        const walletId = cb.dataset.walletId;
        const rawAmt = row.querySelector('.auto-snipe-amount-input')?.value;
        const cleanAmt = String(rawAmt ?? '').trim().replace(',', '.');
        const amount = Number(cleanAmt);
        if (Number.isFinite(amount) && amount > 0) snipeOrders.push({ walletId, amount: cleanAmt });
      }
    });
  }

  const defaultMonitor = {
    enabled: $('#auto-launcher-monitor-enabled')?.checked ?? true,
    autoSell: $('#auto-launcher-auto-sell')?.checked ?? false,
    autoSellMode: $('#auto-launcher-sell-mode')?.value || 'all',
    mode: 'any',
    holdSeconds: 10,
    cooldownSeconds: 60,
    once: true,
    rules: [
      { metric: 'marketCapUsd', operator: 'gte', threshold: 150000 },
      { metric: 'priceChangePct', operator: 'gte', threshold: 50 },
      { metric: 'drawdownPct', operator: 'gte', threshold: 30 },
    ],
  };

  await post('/auto-launcher/config', { enabled, intervalMinutes, walletMode, defaultWalletId, rotationWalletIds, snipeOrders, defaultMonitor });
  autoLauncherFormInitialized = false;
  await refresh();
  show(enabled
    ? `Automatischer Launch aktiviert (alle ${intervalMinutes} min, ${walletMode === 'rotate' ? `Rotation über ${rotationWalletIds.length} Wallets` : 'feste Wallet'}).`
    : 'Automatischer Launch pausiert (Einstellungen gespeichert).');
}); };

$('#auto-launcher-trigger-now').onclick = () => busy($('#auto-launcher-trigger-now'), async () => {
  const res = await post('/auto-launcher/trigger', {});
  if (res.error) throw new Error(res.error);
  if (res.skipped) show(`Übersprungen: ${res.skipped}`);
  else show(`Launch ausgeführt: Token ${res.token} (TX: ${short(res.hash)})`);
  await refresh();
});

$('#wallet-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => { await post('/wallets', Object.fromEntries(new FormData(e.target))); e.target.reset(); await refresh(); show('Öffentliche Wallet-Adresse gespeichert.'); }); };
$('#use-connected').onclick = () => { if (account) $('#new-wallet-address').value = account; else show('Bitte zuerst eine Wallet verbinden.', true); };
$('#notifications').onclick = () => busy($('#notifications'), async () => {
  if (!('Notification' in window)) throw new Error('Dieser Browser unterstützt keine Desktop-Benachrichtigungen. Alerts bleiben im Ereignisprotokoll verfügbar.');
  const result = await Notification.requestPermission();
  $('#notification-status').textContent = result === 'granted' ? 'Desktop-Benachrichtigungen aktiv, solange dieser Tab geöffnet bleibt.' : 'Keine Desktop-Berechtigung. Alerts werden weiterhin lokal gespeichert.';
});
$('#read-alerts').onclick = () => busy($('#read-alerts'), async () => { await post('/alerts/read'); await refresh(); });
$('#queue-form').onsubmit = e => {
  e.preventDefault(); busy(e.submitter, async () => {
    const file = $('#queue-file').files[0];
    if (!file || file.size > 60000) throw new Error('Bitte eine CSV bis 60 KB auswählen.');
    const result = await post('/queue/import', { csv: await file.text() });
    $('#queue-feedback').textContent = `${result.imported} Entwürfe importiert.`;
    await refresh(); show(`${result.imported} Einträge zur Entwurfs-Queue hinzugefügt.`);
  });
};

function loadDraft(draft) {
  for (const name of ['name', 'symbol', 'country', 'description', 'image', 'website', 'metadataURI', 'wallet']) {
    if ($('#launch-form').elements[name]) $('#launch-form').elements[name].value = draft[name] || (name === 'wallet' ? account ?? '' : '');
  }
  if ($('#launch-enforced')) $('#launch-enforced').value = String(draft.enforced ?? true);
  if ($('#launch-charter-drop')) $('#launch-charter-drop').value = String(draft.charterDropBps ?? 1000);
  if ($('#launch-drop-mode')) $('#launch-drop-mode').value = String(draft.dropMode ?? 1);
  if ($('#launch-snipe-tax')) $('#launch-snipe-tax').value = String(draft.snipeTaxOn ?? false);
  if ($('#launch-dev-buy')) $('#launch-dev-buy').value = String(draft.devBuy ?? 'off');
  if (draft.module && draft.module !== '0x0000000000000000000000000000000000000000') {
    if ($('#launch-hook-module')) $('#launch-hook-module').value = 'custom';
    if ($('#hook-module-address-box')) $('#hook-module-address-box').hidden = false;
    if ($('#launch-module-address')) $('#launch-module-address').value = draft.module;
  } else {
    if ($('#launch-hook-module')) $('#launch-hook-module').value = 'off';
    if ($('#hook-module-address-box')) $('#hook-module-address-box').hidden = true;
    if ($('#launch-module-address')) $('#launch-module-address').value = '';
  }
  $('#image-file').value = ''; $('#preview-art').textContent = '✳';
  if (localImage) URL.revokeObjectURL(localImage); localImage = null;
  preview(); navigate('launch');
}

async function refresh() {
  if (loadingState) return;
  loadingState = true;
  try {
    state = await api('/state');
    $('#connection-status').textContent = '● Server verbunden'; $('#connection-status').classList.remove('offline');
    
    // Vault status & wallets
    vaultStatus = state.vault || { initialized: false, unlocked: false };
    if (vaultStatus.unlocked) {
      try { vaultWallets = await api('/vault/wallets'); } catch { vaultWallets = []; }
    } else {
      vaultWallets = [];
    }

    // Topbar vault pill
    const vPill = $('#vault-status-pill');
    if (!vaultStatus.initialized) {
      vPill.textContent = 'Tresor: Nicht eingerichtet 🔒';
      vPill.className = 'pill offline';
    } else if (!vaultStatus.unlocked) {
      vPill.textContent = 'Tresor: Gesperrt 🔒';
      vPill.className = 'pill offline';
    } else {
      vPill.textContent = `Tresor: Entsperrt 🔓 (${vaultWallets.length})`;
      vPill.className = 'pill';
    }

    // Wallets page view
    $('#vault-init-box').hidden = vaultStatus.initialized;
    $('#vault-locked-box').hidden = !vaultStatus.initialized || vaultStatus.unlocked;
    $('#vault-unlocked-box').hidden = !vaultStatus.unlocked;
    $('#lock-vault-btn').hidden = !vaultStatus.unlocked;
    if (vaultStatus.unlocked) {
      $('#vault-wallet-count').textContent = `${vaultWallets.length} Wallets`;
      render('#vault-wallets', vaultWallets.length ? vaultWallets.map(w => `
        <div class="item">
          <div>
            <strong>🔒 ${esc(w.label)} <span class="subtle">(${esc(w.balanceEth)} ETH)</span></strong>
            <small class="address">${esc(w.address)}<br>Erstellt: ${esc(date(w.createdAt))}</small>
          </div>
          <div class="item-actions">
            <button class="text-button" data-action="use-vault-wallet" data-id="${w.id}">Für Launch wählen ↗</button>
            <button class="text-button" data-action="export-vault-wallet" data-id="${w.id}">Key anzeigen 👁</button>
            <button class="text-button" data-action="delete-vault-wallet" data-id="${w.id}">Löschen</button>
          </div>
        </div>
      `).join('') : '<div class="empty">Noch keine Wallets im Tresor. Generiere eine neue oder importiere einen Private Key.</div>');
    }

    // Auto launcher controls
    const al = state.autoLauncher;
    if (al) {
      // 1. Live status badge and countdown (non-destructive)
      let badgeText = 'Pausiert';
      let badgeClass = 'pill offline';
      if (al.status === 'paused_insufficient_funds') {
        badgeText = 'Pausiert: Guthaben fehlt ⚠️';
        badgeClass = 'pill offline';
      } else if (al.status === 'running') {
        badgeText = 'Läuft …'; badgeClass = 'pill';
      } else if (al.enabled) {
        if (al.status === 'error') {
          badgeText = `Fehler: ${short(al.lastError)}`;
          badgeClass = 'pill offline';
        } else {
          badgeText = `Aktiv (Nächster in ${al.countdownSeconds} s)`;
          badgeClass = 'pill';
        }
      }
      $('#auto-launcher-badge').textContent = badgeText;
      $('#auto-launcher-badge').className = badgeClass;

      const isRotate = al.walletMode === 'rotate';
      let infoText = isRotate
        ? `Führt alle ${al.intervalMinutes} Minuten den nächsten Eintrag der Queue aus und rotiert reihum durch ${al.rotationWalletIds?.length || 0} angewählte Tresor-Wallets.`
        : `Führt alle ${al.intervalMinutes} Minuten den nächsten Eintrag der Queue mit der festen Standard-Wallet aus (Fallback oder CSV).`;
      if (al.nextWallet) infoText += ` Nächste Launch-Wallet: 🔒 ${al.nextWallet.label} (${short(al.nextWallet.address)}).`;
      if (al.lastRunAt) infoText += ` Letzter Lauf: ${date(al.lastRunAt)}.`;
      if (al.lastSuccess) infoText += ` Zuletzt gelauncht: ${al.lastSuccess.name} (${short(al.lastSuccess.token)}).`;
      if (al.lastError) infoText += ` Fehler: ${al.lastError}`;
      $('#auto-launcher-info').textContent = infoText;

      // 2. Initialize inputs ONCE so polling never blows away user's typing/toggling
      if (!autoLauncherFormInitialized) {
        autoLauncherFormInitialized = true;
        $('#auto-launcher-enabled').checked = Boolean(al.enabled);
        $('#auto-launcher-interval').value = al.intervalMinutes || 5;

        $('#auto-wallet-mode-rotate').checked = isRotate;
        $('#auto-wallet-mode-single').checked = !isRotate;
        $('#auto-launcher-rotate-box').hidden = !isRotate;
        $('#auto-launcher-single-box').hidden = isRotate;

        render('#auto-launcher-default-wallet', '<option value="">Keine Standard-Wallet</option>' + vaultWallets.map(w => `<option value="${esc(w.id)}" ${w.id === al.defaultWalletId ? 'selected' : ''}>${esc(w.label)} · ${short(w.address)} (${esc(w.balanceEth)} ETH)</option>`).join(''));

        if (al.snipeOrders && al.snipeOrders.length > 0) {
          $('#auto-launcher-snipe-enabled').checked = true;
          $('#auto-launcher-snipe-box').hidden = false;
        }

        if (al.defaultMonitor) {
          if ($('#auto-launcher-monitor-enabled')) {
            $('#auto-launcher-monitor-enabled').checked = al.defaultMonitor.enabled !== false;
          }
          if ($('#auto-launcher-auto-sell')) {
            $('#auto-launcher-auto-sell').checked = Boolean(al.defaultMonitor.autoSell);
            if ($('#auto-launcher-sell-mode-box')) {
              $('#auto-launcher-sell-mode-box').hidden = !al.defaultMonitor.autoSell;
            }
          }
          if ($('#auto-launcher-sell-mode') && al.defaultMonitor.autoSellMode) {
            $('#auto-launcher-sell-mode').value = al.defaultMonitor.autoSellMode;
          }
        }

        const savedRotateSet = new Set(al.rotationWalletIds || []);
        render('#auto-rotate-wallets-list', vaultWallets.length ? vaultWallets.map(w => {
          const checked = savedRotateSet.has(w.id);
          const isNext = isRotate && al.nextWallet?.id === w.id;
          return `
            <div class="item auto-rotate-wallet-row">
              <div class="snipe-row">
                <input type="checkbox" class="auto-rotate-checkbox" data-wallet-id="${esc(w.id)}" ${checked ? 'checked' : ''}>
                <div>
                  <strong>🔒 ${esc(w.label)}</strong> <span class="next-pill-container">${isNext ? '<span class="pill pill-mini">Als Nächste an der Reihe ➔</span>' : ''}</span>
                  <small>${esc(short(w.address))} · Guthaben: <strong>${esc(w.balanceEth)} ETH</strong></small>
                </div>
              </div>
            </div>
          `;
        }).join('') : '<div class="empty">Noch keine Wallets im Tresor. Bitte zuerst im Menü Wallets anlegen.</div>');

        void updateSnipeWallets(state.queue?.[0]?.country || 'us');
      } else {
        // Subsequent poll: only update the next-wallet indicator badge without touching checkboxes or rebuilding the DOM!
        document.querySelectorAll('#auto-rotate-wallets-list .auto-rotate-wallet-row').forEach(row => {
          const id = row.querySelector('.auto-rotate-checkbox')?.dataset.walletId;
          const container = row.querySelector('.next-pill-container');
          if (container) {
            const isNext = isRotate && al.nextWallet?.id === id;
            container.innerHTML = isNext ? '<span class="pill pill-mini">Als Nächste an der Reihe ➔</span>' : '';
          }
        });
      }
    }

    // Alerts
    const newAlerts = state.alerts.filter(a => !alerted.has(a.id));
    if (booted && newAlerts.length) {
      show(`${newAlerts.length} neuer Alert: ${newAlerts[0].name} – ${newAlerts[0].message}`);
      if ('Notification' in window && Notification.permission === 'granted') {
        for (const alert of newAlerts.slice(0, 5)) { try { new Notification(`Standard · ${alert.name}`, { body: alert.message, tag: alert.id }); } catch {} }
      }
    }
    state.alerts.forEach(a => alerted.add(a.id)); booted = true;
    $('#monitor-count').textContent = state.monitors.filter(m => m.enabled).length;
    $('#active-count').textContent = `${state.monitors.filter(m => m.enabled).length} aktiv`;
    $('#alert-count').textContent = state.alerts.filter(a => !a.read).length;
    $('#draft-count').textContent = `${state.drafts.length} Entwürfe`;
    $('#queue-count').textContent = state.queue?.length ?? 0;

    // Render Queue with vault indicator
    render('#queue', state.queue?.length ? state.queue.map((q, index) => {
      const vMatch = q.wallet ? vaultWallets.find(w => w.address.toLowerCase() === q.wallet.toLowerCase() || w.label.toLowerCase() === q.wallet.toLowerCase()) : null;
      const walletTag = al?.walletMode === 'rotate'
        ? `<span class="pill pill-mini">🔄 Rotation aktiv</span>`
        : vMatch ? `<span class="pill pill-mini">🔒 Tresor: ${esc(vMatch.label)}</span>`
        : q.wallet ? `Deployer: ${esc(short(q.wallet))}` : `<span class="subtle">Fallback auf Standard-Tresor-Wallet</span>`;
      const monTag = q.monitor && q.monitor.enabled !== false
        ? `<span class="pill pill-mini">📊 Auto-Monitor (${q.monitor.rules?.length || 1})</span>`
        : q.monitor && q.monitor.enabled === false
        ? `<span class="subtle">Monitor aus</span>`
        : al?.defaultMonitor?.enabled !== false
        ? `<span class="pill pill-mini">📊 Auto-Monitor</span>`
        : '';
      const autoSellTag = (q.monitor?.autoSell ?? (q.monitor?.enabled !== false && al?.defaultMonitor?.autoSell))
        ? `<span class="pill pill-mini">⚡ Auto-Exit (${(q.monitor?.autoSellMode || al?.defaultMonitor?.autoSellMode) === 'n_minus_1' ? 'N-1' : '100%'})</span>`
        : '';
      return `<div class="item"><div><strong>${index + 1}. ${esc(q.name)} · $${esc(q.symbol)}</strong><small>${esc(state.deployment.stocks[q.country].symbol)} · ${walletTag}${monTag ? ` · ${monTag}` : ''}${autoSellTag ? ` · ${autoSellTag}` : ''}<br>${q.metadataURI ? 'Eigene Metadata-URL' : 'Standard-Metadaten des Referenz-Tokens'}${q.imagePath ? `<br>Lokale Vorschau: ${esc(q.imagePath)}` : ''}</small></div><div class="item-actions"><button class="text-button" data-action="load-queue" data-id="${q.id}">Zur Prüfung laden ↗</button><button class="text-button" data-action="delete-queue" data-id="${q.id}">Entfernen</button></div></div>`;
    }).join('') : '<div class="empty">Noch keine Entwürfe importiert. Nutze die CSV-Vorlage als Ausgangspunkt.</div>');

    // Wallet Choice dropdown in launch form
    const walletChoiceSig = vaultWallets.map(w => w.address + w.balanceEth).join(',') + '|' + state.wallets.map(w => w.address).join(',');
    if (walletChoiceSig !== lastWalletChoiceSig && document.activeElement !== $('#wallet-choice')) {
      lastWalletChoiceSig = walletChoiceSig;
      const selected = $('#wallet-choice').value;
      let optHtml = '<option value="">Adresse eingeben oder Wallet verbinden</option>';
      if (vaultWallets.length) {
        optHtml += '<optgroup label="Tresor-Wallets (Direktsignatur)">' + vaultWallets.map(w => `<option value="${esc(w.address)}">🔒 ${esc(w.label)} · ${short(w.address)} (${esc(w.balanceEth)} ETH)</option>`).join('') + '</optgroup>';
      }
      if (state.wallets.length) {
        optHtml += '<optgroup label="Beobachtungs-Adressen (Browser-Signatur)">' + state.wallets.map(w => `<option value="${esc(w.address)}">${esc(w.label)} · ${short(w.address)}</option>`).join('') + '</optgroup>';
      }
      render('#wallet-choice', optHtml);
      $('#wallet-choice').value = selected;
    }

    render('#drafts', state.drafts.length ? state.drafts.map(d => `<div class="item"><div><strong>${esc(d.name)} <span class="subtle">$${esc(d.symbol)}</span></strong><small>${esc(state.deployment.stocks[d.country].symbol)} · ${esc(short(d.wallet))}</small></div><div class="item-actions"><button class="text-button" data-action="load-draft" data-id="${d.id}">Laden ↗</button><button class="text-button" data-action="delete-drafts" data-id="${d.id}">Entfernen</button></div></div>`).join('') : '<div class="empty">Noch kein Entwurf. Speichere deine Token-Details, um später weiterzumachen.</div>');
    render('#wallets', state.wallets.length ? state.wallets.map(w => `<div class="item"><div><strong>${esc(w.label)}</strong><small>${esc(w.address)}</small></div><div class="item-actions"><button class="text-button" data-action="choose-wallet" data-id="${w.id}">Für Launch verwenden ↗</button><button class="text-button" data-action="delete-wallets" data-id="${w.id}">Entfernen</button></div></div>`).join('') : '<div class="empty">Noch keine Beobachtungs-Adressen gespeichert.</div>');

    const pending = pendingHash ? `<div class="pending-launch"><a class="text-link" href="${state.deployment.explorer}/tx/${esc(pendingHash)}" target="_blank" rel="noopener noreferrer">Gesendeten Launch im Explorer prüfen ↗</a><p class="field-help">Warte auf Bestätigung. Bei Ersatztransaktionen den neuen Hash im Explorer prüfen.</p></div>` : '';
    render('#launches', pending + (state.launches.length ? state.launches.map(l => `<div class="item"><div><strong>${esc(l.name)} · $${esc(l.symbol)}</strong><small>${esc(l.token)}</small></div><div class="item-actions"><button class="text-button" data-action="monitor-launch" data-id="${l.hash}">Monitor anlegen ↗</button><a class="text-link" href="${state.deployment.explorer}/tx/${l.hash}" target="_blank" rel="noopener noreferrer">Transaktion ↗</a></div></div>`).join('') : '<div class="empty">Bestätigte Launches erscheinen hier automatisch.</div>'));

    try {
      const fees = await api('/fees');
      claimableFeesMap = Object.fromEntries(fees.map(f => [f.curve?.toLowerCase(), f]));
    } catch {
      claimableFeesMap = {};
    }

    render('#monitors', state.monitors.length ? state.monitors.map(m => {
      const s = m.snapshot;
      const creatorHtml = m.creatorWallet
        ? `<div class="monitor-creator-info"><small>Creator:</small> <strong>${esc(m.creatorLabel || 'Deployer')}</strong> <span class="address">(${esc(short(m.creatorWallet))})</span></div>`
        : '';
      const feeInfo = m.curve ? claimableFeesMap[m.curve.toLowerCase()] : null;
      const feeHtml = (feeInfo && Number(feeInfo.balanceEth) > 0)
        ? `<div class="monitor-creator-info" style="margin-top:0.4rem; background:rgba(0,255,100,0.08); padding:0.4rem 0.6rem; border-radius:6px; display:flex; justify-content:space-between; align-items:center;">
             <span>💰 <strong>${esc(feeInfo.balanceEth)} ${esc(state.deployment.stocks[m.country || 'us']?.symbol || 'SPCX')}</strong> Creator-Fees gesammelt</span>
             ${feeInfo.isMine ? `<button type="button" class="button mini primary" data-action="claim-fees" data-curve="${esc(m.curve)}">Gebühren claimen ➔</button>` : ''}
           </div>`
        : '';
      const purchasesHtml = m.purchases && m.purchases.length > 0
        ? `<div class="monitor-purchases-info"><strong>Erstkäufe (${m.purchases.length} Wallets):</strong><ul class="snipe-purchases-list">${m.purchases.map(p => `<li>${p.status === 'success' ? '✅' : '❌'} <strong>${esc(p.label || short(p.address))}</strong>: ${esc(p.amount)} ${esc(p.currency || 'SPCX')} ${p.hash ? `<a class="text-link" href="${state.deployment.explorer}/tx/${esc(p.hash)}" target="_blank" rel="noopener noreferrer">${esc(short(p.hash))} ↗</a>` : ''} ${p.error ? `<span class="error">(${esc(p.error)})</span>` : ''}</li>`).join('')}</ul></div>`
        : '';
      const sellBadge = m.autoSell
        ? `<span class="pill pill-mini ${m.autoSellExecuted ? '' : 'pill-active'}">⚡ Auto-Exit (${m.autoSellMode === 'n_minus_1' ? 'N-1' : '100%'}) ${m.autoSellExecuted ? '✓ Ausgeführt' : 'Bereit'}</span>`
        : '';
      const sellResultsHtml = m.sellResults && m.sellResults.length > 0
        ? `<div class="monitor-purchases-info"><strong>Auto-Exit Verkäufe:</strong><ul class="snipe-purchases-list">${m.sellResults.map(s => `<li>${s.status === 'success' ? '✅' : s.status === 'kept_best_entry' ? '💎 (Moonbag behalten)' : '❌'} <strong>${esc(s.label || short(s.walletId || s.address || ''))}</strong>: ${s.tokensSold ? `${esc(s.tokensSold)} Tokens` : ''} ${s.hash ? `<a class="text-link" href="${state.deployment.explorer}/tx/${esc(s.hash)}" target="_blank" rel="noopener noreferrer">${esc(short(s.hash))} ↗</a>` : ''} ${s.error ? `<span class="error">(${esc(s.error)})</span>` : ''}</li>`).join('')}</ul></div>`
        : '';
      return `<article class="panel monitor-card"><div class="monitor-title"><h2>${esc(m.name)}</h2>${sellBadge}<span class="pill ${!m.enabled || m.error ? 'offline' : ''}">${m.error ? 'Datenfehler' : m.enabled ? 'Aktiv' : 'Pausiert'}</span></div><p class="address">${esc(m.token)}</p><div class="metrics"><div><small>MARKET CAP</small><strong>${money(s?.marketCapUsd)}</strong></div><div><small>VOLUMEN · 24 H</small><strong>${money(s?.volume24hUsd)}</strong></div><div><small>LIQUIDITÄT</small><strong>${money(s?.liquidityUsd)}</strong></div><div><small>PREIS</small><strong>${money(s?.priceUsd)}</strong></div></div><div class="rule-summary">${m.rules.map(r => `${metricLabels[r.metric]} ${r.operator === 'gte' ? '≥' : '≤'} ${esc(r.threshold)}`).join(m.mode === 'all' ? '<br>UND ' : '<br>ODER ')}<br><span class="subtle">${m.holdSeconds} s Haltezeit · ${m.once ? 'Einmalig' : `${m.cooldownSeconds} s Cooldown`}</span></div>${creatorHtml}${feeHtml}${purchasesHtml}${sellResultsHtml}${m.error ? `<p class="error">${esc(m.error)}</p>` : ''}<p class="subtle">Datenstand: ${date(s?.asOfTime ? s.asOfTime * 1000 : null)}</p><div class="item-actions"><button class="text-button" data-action="toggle" data-id="${m.id}">${m.enabled ? 'Pausieren' : 'Fortsetzen'}</button><button class="text-button" data-action="edit-monitor" data-id="${m.id}">Bearbeiten</button><button class="text-button" data-action="rearm" data-id="${m.id}">Neu scharfstellen</button><button class="text-button" data-action="delete-monitors" data-id="${m.id}">Entfernen</button></div></article>`;
    }).join('') : '<div class="panel empty">Noch keine Monitore aktiv. Füge eine Token-Adresse und deine erste Trigger-Regel hinzu.</div>');

    render('#alerts', state.alerts.length ? state.alerts.map(a => `<article class="item ${a.read ? '' : 'alert-unread'}"><div><strong>◇ ${esc(a.name)}</strong><small>${esc(a.message)}</small><div class="alert-details">${esc(date(a.at))} · Market Cap ${money(a.metrics.marketCapUsd)} · Volumen 24 h ${money(a.metrics.volume24hUsd)}<br>${esc(a.token)}</div></div><span class="pill">${a.read ? 'Gelesen' : 'Neu'}</span></article>`).join('') : '<div class="empty">Alles ruhig. Sobald eine Regel auslöst, findest du den Alert mit Zeitstempel und Kennzahlen hier.</div>');
  } catch (e) {
    $('#connection-status').textContent = '● Server nicht erreichbar'; $('#connection-status').classList.add('offline');
    show(`Lokaler Server nicht erreichbar: ${e.message}. Monitoring läuft nur bei gestartetem Server.`, true);
  } finally { loadingState = false; }
}

document.addEventListener('click', e => {
  const button = e.target.closest('[data-action]'); if (!button) return;
  busy(button, async () => {
    const { action, id } = button.dataset;
    if (action.startsWith('delete-')) {
      if (action === 'delete-vault-wallet') {
        if (!confirm('Soll diese Wallet wirklich aus dem Tresor gelöscht werden?')) return;
        await api(`/vault/wallets/${id}`, { method: 'DELETE' });
        show('Wallet aus dem Tresor gelöscht.');
      } else {
        await api(`/${action.slice(7)}/${id}`, { method: 'DELETE' });
      }
      if (id === editingMonitor) { editingMonitor = null; $('#monitor-form button[type="submit"]').textContent = 'Monitoring starten →'; }
    } else if (action === 'toggle' || action === 'rearm') await post(`/monitors/${id}/${action}`);
    else if (action === 'load-draft') {
      const d = state.drafts.find(x => x.id === id);
      loadDraft(d); show('Entwurf geladen. Eine Bildvorschau kannst du bei Bedarf erneut auswählen.');
    } else if (action === 'load-queue') {
      const d = state.queue.find(x => x.id === id); loadDraft(d);
      show('Queue-Eintrag geladen. Prüfe Wallet, Metadaten und Transaktion.');
      if (d.imagePath) {
        const response = await fetch(`/api/queue/${id}/image`);
        if (!response.ok) throw new Error(`Entwurf geladen, Bild nicht verfügbar: ${(await response.json()).error}`);
        const url = URL.createObjectURL(await response.blob()), img = new Image();
        try { img.src = url; await img.decode(); } catch { URL.revokeObjectURL(url); throw new Error('Entwurf geladen, aber die lokale Bilddatei ist nicht lesbar.'); }
        localImage = url; img.alt = 'Lokale Bildvorschau aus der CSV'; $('#preview-art').replaceChildren(img);
      }
    } else if (action === 'choose-wallet') {
      const w = state.wallets.find(x => x.id === id); $('#launch-wallet').value = w.address; $('#wallet-choice').value = w.address; prepared = null; navigate('launch');
    } else if (action === 'use-vault-wallet') {
      const w = vaultWallets.find(x => x.id === id);
      if (w) { $('#launch-wallet').value = w.address; $('#wallet-choice').value = w.address; prepared = null; navigate('launch'); show(`Tresor-Wallet „${w.label}“ für Launch ausgewählt.`); }
    } else if (action === 'export-vault-wallet') {
      exportingWalletId = id;
      $('#export-master-password').value = '';
      $('#export-result-box').hidden = true;
      $('#export-dialog').showModal();
    } else if (action === 'monitor-launch') {
      const l = state.launches.find(x => x.hash === id); $('#monitor-token').value = l.token; $('#monitor-form').elements.name.value = l.name; navigate('monitor');
    } else if (action === 'edit-monitor') {
      const m = state.monitors.find(x => x.id === id); editingMonitor = id;
      for (const key of ['name', 'token', 'mode', 'holdSeconds', 'cooldownSeconds']) $('#monitor-form').elements[key].value = m[key];
      $('#monitor-form').elements.once.checked = m.once; $('#rules').replaceChildren(); m.rules.forEach(ruleRow);
      if ($('#monitor-auto-sell')) {
        $('#monitor-auto-sell').checked = Boolean(m.autoSell);
        if ($('#monitor-auto-sell-box')) $('#monitor-auto-sell-box').hidden = !m.autoSell;
      }
      if ($('#monitor-sell-mode') && m.autoSellMode) {
        $('#monitor-sell-mode').value = m.autoSellMode;
      }
      $('#monitor-form button[type="submit"]').textContent = 'Änderungen speichern →';
      show('Monitor wird bearbeitet. Speichern setzt Kursbasis und bisherigen Auslösezustand zurück.');
      $('#monitor-form').scrollIntoView({ behavior: 'smooth' });
    } else if (action === 'claim-fees') {
      const curve = button.dataset.curve;
      const res = await post('/fees/claim', { curve });
      show(`Erfolgreich ${res.claimedAmount || ''} Gebühren abgeholt! TX: ${res.hash}`);
    }
    await refresh();
  });
});

await refresh(); void terms();
if (selectedProvider()) { walletSession.select(selectedProvider()); void walletSession.connect(true).catch(() => {}); }
if (pendingHash) { show(`Gesendeter Launch ${pendingHash} wird weiter geprüft.`); void checkReceipt(); }
setInterval(() => { void refresh(); void checkReceipt(); }, 3000);
