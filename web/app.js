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
let activeAlertFilter = 'all';

function getAlertCategory(a) {
  if (a.category) return a.category;
  const str = `${a.name || ''} ${a.message || ''}`.toLowerCase();
  if (str.includes('fehler') || str.includes('error') || str.includes('reverted') || str.includes('fehlgeschlagen')) return 'error';
  if (str.includes('angehalten') || str.includes('warnung') || str.includes('warning') || str.includes('abgebrochen') || str.includes('unzureichend') || str.includes('gesperrt')) return 'warning';
  if (str.includes('erfolgreich') || str.includes('auto-launch:') || str.includes('ausgeführt')) return 'success';
  return 'info';
}
function updateFastPoller() {
  if (pendingHash && !fastPoller) {
    fastPoller = setInterval(() => { void checkReceipt(); }, 350);
  } else if (!pendingHash && fastPoller) {
    clearInterval(fastPoller);
    fastPoller = null;
  }
}

try { pendingHash = localStorage.getItem('standard:pending-launch'); updateFastPoller(); } catch {}

let noticeTimer = null;
function show(message, error = false) {
  for (const el of [$('#notice'), $('#launch-feedback')]) {
    if (!el) continue;
    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:14px;">
        <div style="flex:1;">${error ? '🚨 <strong>Fehler:</strong> ' : '✅ <strong>Info:</strong> '}${esc(message)}</div>
        <button type="button" class="icon-button" data-action="close-notice" style="font-size:18px; line-height:1; padding:2px 8px; cursor:pointer; min-height:unset;" title="Meldung schließen" aria-label="Meldung schließen">✕</button>
      </div>
    `;
    el.classList.toggle('is-error', error);
    el.hidden = false;
  }
  clearTimeout(noticeTimer);
  if (!error) {
    noticeTimer = setTimeout(() => {
      const n = $('#notice');
      if (n) n.hidden = true;
    }, 6000);
  }
}

document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-action="close-notice"]');
  if (closeBtn) {
    const noticeEl = closeBtn.closest('.notice');
    if (noticeEl) noticeEl.hidden = true;
  }
});

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
  $('#page-label').textContent = {
    dashboard: 'Dashboard & Gebühren',
    launch: 'Token launchen',
    queue: 'Entwurfs-Queue',
    monitor: 'Monitoring',
    wallets: 'Wallets & Tresor',
    alerts: 'Alerts'
  }[page] || 'Launch Console';
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
  if ($('#snipe-currency-help')) $('#snipe-currency-help').textContent = curMsg;
  if ($('#auto-snipe-currency-help')) $('#auto-snipe-currency-help').textContent = `Kaufwährung hängt vom Paar ab (z. B. $${pairInfo.symbol} für ${pairInfo.name}). Wähle bis zu 10 Wallets und Betrag:`;
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
  if (!vaultStatus.unlocked) {
    const lockedMsg = `
      <div class="callout-box" style="margin: 8px 0;">
        <strong style="color:var(--orange);">🔒 Tresor ist gesperrt</strong>
        <p style="margin: 4px 0 10px; font-size: 11px;">Bitte entsperre deinen Tresor mit deinem Master-Passwort, um Wallets für den Erstkauf (Snipe) festzulegen.</p>
        <button type="button" class="button mini primary" data-action="quick-unlock-vault">Jetzt Tresor entsperren 🔓</button>
      </div>
    `;
    render('#snipe-wallets-list', lockedMsg);
    render('#auto-snipe-wallets-list', lockedMsg);
    return;
  }
  if (!vaultWallets.length) {
    render('#snipe-wallets-list', '<div class="empty">Noch keine Wallets im Tresor hinterlegt. Bitte unter „Wallets“ anlegen.</div>');
    render('#auto-snipe-wallets-list', '<div class="empty">Noch keine Wallets im Tresor hinterlegt. Bitte unter „Wallets“ anlegen.</div>');
    return;
  }
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
      if (id) {
        autoAmounts[id] = {
          us: row.querySelector('.auto-snipe-amt-us')?.value || '0.05',
          eth: row.querySelector('.auto-snipe-amt-eth')?.value || '0.005',
          cn: row.querySelector('.auto-snipe-amt-cn')?.value || '0.1',
          kr: row.querySelector('.auto-snipe-amt-kr')?.value || '0.1',
        };
      }
    });
  } else {
    (state.autoLauncher?.snipeOrders || []).forEach(o => {
      if (o.walletId) {
        autoChecked.add(o.walletId);
        autoAmounts[o.walletId] = o.amounts || {
          us: o.amount || '0.05',
          eth: state.autoLauncher?.pairAmounts?.eth || '0.005',
          cn: state.autoLauncher?.pairAmounts?.cn || '0.1',
          kr: state.autoLauncher?.pairAmounts?.kr || '0.1',
        };
      }
    });
  }

  const defPairAmounts = state.autoLauncher?.pairAmounts || { us: '0.05', eth: '0.005', cn: '0.1', kr: '0.1' };

  render('#auto-snipe-wallets-list', vaultWallets.map(w => {
    const bal = stockBalances[w.address.toLowerCase()] ?? '0';
    const checked = autoChecked.has(w.id);
    const amt = autoAmounts[w.id] || defPairAmounts;
    const amtUs = amt.us ?? defPairAmounts.us ?? '0.05';
    const amtEth = amt.eth ?? defPairAmounts.eth ?? '0.005';
    const amtCn = amt.cn ?? defPairAmounts.cn ?? '0.1';
    const amtKr = amt.kr ?? defPairAmounts.kr ?? '0.1';
    return `
      <div class="item auto-snipe-wallet-row">
        <div class="snipe-row">
          <input type="checkbox" class="auto-snipe-checkbox" data-wallet-id="${esc(w.id)}" ${checked ? 'checked' : ''}>
          <div>
            <strong>🔒 ${esc(w.label)}</strong>
            <small>${esc(short(w.address))} · ETH: <strong>${esc(w.balanceEth)}</strong></small>
          </div>
        </div>
        <div class="auto-snipe-pair-inputs">
          <label>🇺🇸 SPCX
            <input type="text" inputmode="decimal" class="auto-snipe-amt-us snipe-amount" value="${esc(amtUs)}" placeholder="0.05">
          </label>
          <label>⟠ ETH
            <input type="text" inputmode="decimal" class="auto-snipe-amt-eth snipe-amount" value="${esc(amtEth)}" placeholder="0.005">
          </label>
          <label>🇨🇳 BABA
            <input type="text" inputmode="decimal" class="auto-snipe-amt-cn snipe-amount" value="${esc(amtCn)}" placeholder="0.1">
          </label>
          <label>🇰🇷 SKHY
            <input type="text" inputmode="decimal" class="auto-snipe-amt-kr snipe-amount" value="${esc(amtKr)}" placeholder="0.1">
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

if ($('#auto-snipe-apply-all-btn')) {
  $('#auto-snipe-apply-all-btn').onclick = () => {
    const usVal = $('#auto-snipe-amount-us')?.value?.trim().replace(',', '.') || '0.05';
    const ethVal = $('#auto-snipe-amount-eth')?.value?.trim().replace(',', '.') || '0.005';
    const cnVal = $('#auto-snipe-amount-cn')?.value?.trim().replace(',', '.') || '0.1';
    const krVal = $('#auto-snipe-amount-kr')?.value?.trim().replace(',', '.') || '0.1';
    document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-wallet-row').forEach(row => {
      const u = row.querySelector('.auto-snipe-amt-us'); if (u) u.value = usVal;
      const e = row.querySelector('.auto-snipe-amt-eth'); if (e) e.value = ethVal;
      const c = row.querySelector('.auto-snipe-amt-cn'); if (c) c.value = cnVal;
      const k = row.querySelector('.auto-snipe-amt-kr'); if (k) k.value = krVal;
    });
    show('Standardbeträge auf alle ausgewählten Wallets übertragen.');
  };
}

$('#auto-launcher-form').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
  const enabled = state.autoLauncher?.enabled ?? false;
  const intervalMinutes = Number($('#auto-launcher-interval').value);
  const intervalVarianceSeconds = Number($('#auto-launcher-variance')?.value || 0);
  const limitMode = $('#auto-launcher-limit-mode')?.value || 'all';
  const targetCount = Number($('#auto-launcher-target-count')?.value) || 0;
  const walletMode = $('#auto-wallet-mode-rotate').checked ? 'rotate' : 'single';
  const defaultWalletId = $('#auto-launcher-default-wallet').value;
  
  const rotationWalletIds = [];
  document.querySelectorAll('#auto-rotate-wallets-list .auto-rotate-checkbox:checked').forEach(cb => {
    rotationWalletIds.push(cb.dataset.walletId);
  });
  if (walletMode === 'rotate' && rotationWalletIds.length === 0) {
    throw new Error('Bitte mindestens eine Wallet für die automatische Rotation auswählen.');
  }

  const pairAmounts = {
    us: $('#auto-snipe-amount-us')?.value?.trim().replace(',', '.') || '0.05',
    eth: $('#auto-snipe-amount-eth')?.value?.trim().replace(',', '.') || '0.005',
    cn: $('#auto-snipe-amount-cn')?.value?.trim().replace(',', '.') || '0.1',
    kr: $('#auto-snipe-amount-kr')?.value?.trim().replace(',', '.') || '0.1',
  };

  const snipeOrders = [];
  if ($('#auto-launcher-snipe-enabled').checked) {
    document.querySelectorAll('#auto-snipe-wallets-list .auto-snipe-wallet-row').forEach(row => {
      const cb = row.querySelector('.auto-snipe-checkbox');
      if (cb && cb.checked) {
        const walletId = cb.dataset.walletId;
        const u = row.querySelector('.auto-snipe-amt-us')?.value?.trim().replace(',', '.') || pairAmounts.us;
        const e = row.querySelector('.auto-snipe-amt-eth')?.value?.trim().replace(',', '.') || pairAmounts.eth;
        const c = row.querySelector('.auto-snipe-amt-cn')?.value?.trim().replace(',', '.') || pairAmounts.cn;
        const k = row.querySelector('.auto-snipe-amt-kr')?.value?.trim().replace(',', '.') || pairAmounts.kr;
        snipeOrders.push({
          walletId,
          amount: u,
          amounts: { us: u, eth: e, cn: c, kr: k },
        });
      }
    });
  }

  const defaultMonitor = {
    enabled: $('#auto-launcher-monitor-enabled')?.checked ?? true,
    autoSell: $('#auto-launcher-auto-sell')?.checked ?? true,
    autoSellMode: $('#auto-launcher-sell-mode')?.value || 'all',
    mode: 'any',
    holdSeconds: 10,
    cooldownSeconds: 60,
    once: true,
    rules: [
      { metric: 'marketCapUsd', operator: 'gte', threshold: 5000 },
      { metric: 'priceChangePct', operator: 'gte', threshold: 50 },
      { metric: 'drawdownPct', operator: 'gte', threshold: 30 },
    ],
  };

  const defaultReferrer = $('#auto-launcher-referrer')?.value?.trim() || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7';

  await post('/auto-launcher/config', {
    enabled,
    intervalMinutes,
    intervalVarianceSeconds,
    limitMode,
    targetCount,
    walletMode,
    defaultWalletId,
    rotationWalletIds,
    pairAmounts,
    snipeOrders,
    defaultMonitor,
    defaultReferrer,
  });
  autoLauncherFormInitialized = false;
  await refresh();
  show('Einstellungen erfolgreich gespeichert.');
}); };

async function sendAutoLauncherControl(action) {
  try {
    const res = await post('/auto-launcher/control', { action });
    await refresh();
    return res;
  } catch (err) {
    show(`Steuerungsfehler: ${err.message}`, true);
  }
}

if ($('#ctrl-btn-start')) {
  $('#ctrl-btn-start').onclick = () => busy($('#ctrl-btn-start'), async () => {
    const limitMode = $('#auto-launcher-limit-mode')?.value || 'all';
    const targetCount = Number($('#auto-launcher-target-count')?.value) || 0;
    await post('/auto-launcher/config', { limitMode, targetCount });
    await sendAutoLauncherControl('start');
    show(limitMode === 'count'
      ? `Queue gestartet (Ziel: ${targetCount} Tokens ab jetzt).`
      : 'Queue gestartet (alle Tokens abarbeiten).');
  });
}

if ($('#ctrl-btn-pause')) {
  $('#ctrl-btn-pause').onclick = () => busy($('#ctrl-btn-pause'), async () => {
    await sendAutoLauncherControl('pause');
    show('Queue pausiert.');
  });
}

if ($('#ctrl-btn-soft-stop')) {
  $('#ctrl-btn-soft-stop').onclick = () => busy($('#ctrl-btn-soft-stop'), async () => {
    await sendAutoLauncherControl('soft_stop');
    show('Soft Stop angefordert: Aktiver Launch wird abgeschlossen, danach stoppt die Queue.');
  });
}

if ($('#ctrl-btn-hard-stop')) {
  $('#ctrl-btn-hard-stop').onclick = () => busy($('#ctrl-btn-hard-stop'), async () => {
    await sendAutoLauncherControl('hard_stop');
    show('Hard Stop ausgeführt: Alle automatischen Aktivitäten sofort gestoppt.');
  });
}

if ($('#auto-launcher-limit-mode')) {
  $('#auto-launcher-limit-mode').onchange = () => {
    if ($('#auto-launcher-target-count-box')) {
      $('#auto-launcher-target-count-box').hidden = ($('#auto-launcher-limit-mode').value !== 'count');
    }
  };
}

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

document.querySelectorAll('.alert-filter-btn').forEach(btn => {
  btn.onclick = () => {
    activeAlertFilter = btn.dataset.filter || 'all';
    document.querySelectorAll('.alert-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    void refresh();
  };
});
if ($('#queue-sync-form')) {
  $('#queue-sync-form').onsubmit = e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const path = $('#queue-file-path').value.trim();
      const res = await post('/queue/sync', { path });
      show(`Queue erfolgreich synchronisiert (${res.count} Entwürfe aus ${res.path} eingelesen).`);
      await refresh();
    });
  };
}

if ($('#queue-sync-now-btn')) {
  $('#queue-sync-now-btn').onclick = () => busy($('#queue-sync-now-btn'), async () => {
    const path = $('#queue-file-path')?.value.trim();
    const res = await post('/queue/sync', { path });
    show(`Queue neu eingelesen (${res.count} Entwürfe).`);
    await refresh();
  });
}

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
  for (const name of ['name', 'symbol', 'country', 'description', 'image', 'website', 'metadataURI', 'wallet', 'referrer']) {
    if ($('#launch-form').elements[name]) $('#launch-form').elements[name].value = draft[name] || (name === 'wallet' ? account ?? '' : name === 'referrer' ? '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7' : '');
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

let currentPointSettings = {
  mode: 'guaranteed',
  customVal: 0.01703,
  guaranteedVal: 0.01703,
  averageVal: 0.02621,
  jackpotVal: 0.03291,
};
let lastState = null;
let lastFeeData = null;
let pointControlsInitialized = false;

function renderDashboard(state, feeData) {
  const launches = (feeData && Array.isArray(feeData.launches) && feeData.launches.length) ? feeData.launches : (state.launches || []);
  const byWallet = feeData?.byWallet || {};

  if ($('#dash-total-launches')) $('#dash-total-launches').textContent = launches.length;
  if ($('#dash-launch-count')) $('#dash-launch-count').textContent = `${launches.length} Token${launches.length === 1 ? '' : 's'}`;

  const pilotStats = feeData?.pilotStats || {};
  const serverSettings = feeData?.settings || {};

  currentPointSettings.guaranteedVal = Number(pilotStats.incentivesPointValueUsd || 0.01703);
  currentPointSettings.averageVal = Number(pilotStats.poolPointValueUsd || 0.02621);
  currentPointSettings.jackpotVal = Number(pilotStats.leaderPointValueUsd || 0.03291);

  if (serverSettings.pointValueMode) {
    currentPointSettings.mode = serverSettings.pointValueMode;
  }
  if (typeof serverSettings.customPointValueUsd === 'number') {
    currentPointSettings.customVal = serverSettings.customPointValueUsd;
  }

  let effectivePointVal = currentPointSettings.guaranteedVal;
  if (currentPointSettings.mode === 'average') {
    effectivePointVal = currentPointSettings.averageVal;
  } else if (currentPointSettings.mode === 'jackpot') {
    effectivePointVal = currentPointSettings.jackpotVal;
  } else if (currentPointSettings.mode === 'manual') {
    effectivePointVal = Number(currentPointSettings.customVal) || currentPointSettings.guaranteedVal;
  }

  const guaranteedRadio = $('#dash-point-mode-guaranteed');
  const averageRadio = $('#dash-point-mode-average');
  const jackpotRadio = $('#dash-point-mode-jackpot');
  const manualRadio = $('#dash-point-mode-manual');
  const valInput = $('#dash-point-value-input');
  const poolStatusText = $('#dash-pool-status-text');

  if (guaranteedRadio && averageRadio && jackpotRadio && manualRadio && valInput) {
    if (document.activeElement !== valInput) {
      guaranteedRadio.checked = currentPointSettings.mode === 'guaranteed';
      averageRadio.checked = currentPointSettings.mode === 'average';
      jackpotRadio.checked = currentPointSettings.mode === 'jackpot';
      manualRadio.checked = currentPointSettings.mode === 'manual';

      valInput.value = effectivePointVal.toFixed(5);
      valInput.readOnly = currentPointSettings.mode !== 'manual';
      valInput.style.opacity = currentPointSettings.mode === 'manual' ? '1' : '0.75';
    }
  }

  if (poolStatusText) {
    const totalPoolUsd = Number(pilotStats.rewardVaultUsd || pilotStats.feesUsd) || 1141245.2;
    const incPool = Number(pilotStats.incentivesPoolUsd || (totalPoolUsd * 0.65));
    const jackPool = Number(pilotStats.jackpotPoolUsd || (totalPoolUsd * 0.35));
    const totalPoolPts = Number(pilotStats.totalPoints) || 43549000;
    const leader = pilotStats.leaderCountry || 'US';
    poolStatusText.innerHTML = `Pool: <strong>${totalPoolUsd.toLocaleString('de-DE', {maximumFractionDigits:0})} $</strong> · 65% Incentives: <strong>${incPool.toLocaleString('de-DE', {maximumFractionDigits:0})} $</strong> (garantiert) · 35% Jackpot: <strong>${jackPool.toLocaleString('de-DE', {maximumFractionDigits:0})} $</strong> (${leader} führt)`;
  }

  if (!pointControlsInitialized && guaranteedRadio && averageRadio && jackpotRadio && manualRadio && valInput) {
    pointControlsInitialized = true;
    const setMode = async (mode, val) => {
      currentPointSettings.mode = mode;
      valInput.value = val.toFixed(5);
      valInput.readOnly = mode !== 'manual';
      valInput.style.opacity = mode === 'manual' ? '1' : '0.75';
      if (mode === 'manual') valInput.focus();
      await post('/settings', { pointValueMode: mode, customPointValueUsd: val }).catch(() => {});
      if (lastFeeData && lastState) renderDashboard(lastState, lastFeeData);
    };

    guaranteedRadio.onchange = () => { if (guaranteedRadio.checked) void setMode('guaranteed', currentPointSettings.guaranteedVal); };
    averageRadio.onchange = () => { if (averageRadio.checked) void setMode('average', currentPointSettings.averageVal); };
    jackpotRadio.onchange = () => { if (jackpotRadio.checked) void setMode('jackpot', currentPointSettings.jackpotVal); };
    manualRadio.onchange = () => { if (manualRadio.checked) void setMode('manual', Number(valInput.value) || currentPointSettings.guaranteedVal); };

    let saveTimer = null;
    valInput.oninput = () => {
      const val = Number(valInput.value) || 0;
      currentPointSettings.customVal = val;
      currentPointSettings.mode = 'manual';
      manualRadio.checked = true;
      guaranteedRadio.checked = false;
      averageRadio.checked = false;
      jackpotRadio.checked = false;
      valInput.readOnly = false;
      valInput.style.opacity = '1';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await post('/settings', { pointValueMode: 'manual', customPointValueUsd: val }).catch(() => {});
      }, 500);
      if (lastFeeData && lastState) renderDashboard(lastState, lastFeeData);
    };
  }

  let totalVaultFees = 0;
  let vaultWalletsWithFees = 0;
  let totalFeeItemsCount = 0;

  for (const w of Object.values(byWallet)) {
    if (w.isVault && Number(w.totalBalanceEth) > 0) {
      totalVaultFees += Number(w.totalBalanceEth);
      vaultWalletsWithFees++;
      totalFeeItemsCount += w.curves?.length || 0;
    }
  }

  if ($('#dash-total-fees')) {
    $('#dash-total-fees').textContent = `${totalVaultFees.toFixed(6).replace(/\.?0+$/, '') || '0'} SPCX`;
  }
  if ($('#dash-wallets-with-fees')) {
    $('#dash-wallets-with-fees').textContent = vaultWalletsWithFees;
  }

  // Summary Metrics: Eigene Punkte & Effektives PnL
  let totalOwnPoints = 0;
  let totalOnchainPnlUsd = 0;
  for (const l of launches) {
    const dep = l.deployerPoints || 0;
    const buy = (Array.isArray(l.buyerPoints) ? l.buyerPoints : []).reduce((a, b) => a + (b.points || 0), 0);
    totalOwnPoints += (dep + buy);
    const netEth = (typeof l.netPnlEth === 'number') ? l.netPnlEth : 0;
    totalOnchainPnlUsd += (netEth * 2600);
  }
  const totalPointsUsd = totalOwnPoints * effectivePointVal;
  const totalEffPnlUsd = totalOnchainPnlUsd + totalPointsUsd;

  if ($('#dash-total-own-points')) {
    $('#dash-total-own-points').textContent = `${totalOwnPoints.toLocaleString('de-DE')} Pkt`;
  }
  if ($('#dash-total-points-usd')) {
    $('#dash-total-points-usd').textContent = `~${totalPointsUsd.toFixed(2)} $ geschätzt`;
  }
  if ($('#dash-total-effective-pnl')) {
    $('#dash-total-effective-pnl').textContent = `${totalEffPnlUsd >= 0 ? '+' : ''}${totalEffPnlUsd.toFixed(2)} $`;
    $('#dash-total-effective-pnl').className = totalEffPnlUsd >= 0 ? 'dash-accent-text' : 'dash-danger-text';
  }
  if ($('#dash-total-onchain-pnl')) {
    $('#dash-total-onchain-pnl').textContent = `On-Chain: ${totalOnchainPnlUsd >= 0 ? '+' : ''}${totalOnchainPnlUsd.toFixed(2)} $`;
  }

  const feeBadge = $('#dashboard-fee-count');
  if (feeBadge) {
    if (totalFeeItemsCount > 0) {
      feeBadge.textContent = totalFeeItemsCount;
      feeBadge.classList.remove('dash-hidden');
      feeBadge.classList.add('dash-visible');
    } else {
      feeBadge.classList.remove('dash-visible');
      feeBadge.classList.add('dash-hidden');
    }
  }

  // Section 1: Claimbare Gebühren pro Wallet
  const walletEntries = Object.values(byWallet);
  const walletsWithFees = walletEntries.filter(w => Number(w.totalBalanceEth) > 0);

  if (!walletsWithFees.length) {
    render('#dash-wallet-cards', '<div class="empty dash-empty-grid">Aktuell keine unbeanspruchten Creator-Gebühren vorhanden. Sobald auf den Bonding-Curves deiner Tokens gehandelt wird, sammeln sich die Gebühren hier automatisch an.</div>');
  } else {
    render('#dash-wallet-cards', walletsWithFees.map(w => {
      const isMine = w.isVault;
      return `
        <article class="dash-wallet-card has-fees">
          <div>
            <div class="dash-wallet-header">
              <div>
                <strong>${esc(w.label)}</strong>
                <span class="subtle dash-address-subtle">${esc(short(w.address))}</span>
              </div>
              <span class="pill ${isMine ? 'pill-active' : ''}">${isMine ? '🔒 Im Tresor' : 'Beobachtet'}</span>
            </div>
            <div class="dash-fee-block">
              <small class="subtle dash-fee-label">OFFENE GEBÜHREN</small>
              <div class="dash-fee-amount">${esc(w.totalBalanceEth)} ${esc(w.stockSymbol || 'SPCX')}</div>
            </div>
            ${(w.totalDeployerPoints || w.totalBuyerPoints) ? `
              <div class="dash-points-summary-row" style="margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap;">
                ${w.totalDeployerPoints ? `<span class="pill pill-mini pill-highlight" title="Verifizierte Deployer-Punkte auf Standard Reserve (Creator)">👑 ${esc(w.totalDeployerPoints.toLocaleString('de-DE'))} Deployer-Pkt</span>` : ''}
                ${w.totalBuyerPoints ? `<span class="pill pill-mini pill-active" title="Echte Trading-Punkte auf Standard Reserve (Käufe)">🛒 ${esc(w.totalBuyerPoints.toLocaleString('de-DE'))} Buyer-Pkt</span>` : ''}
              </div>
            ` : ''}
            ${(() => {
              const activeCurves = (w.curves || []).filter(c => Number(c.balanceEth) > 0);
              if (!activeCurves.length) return '';
              return `
                <div class="dash-curves-box">
                  <small class="subtle dash-curves-title">Claimbare Token-Gebühren (${activeCurves.length}):</small>
                  ${activeCurves.map(c => `
                    <div class="dash-curve-item">
                      <span class="dash-token-badge">🪙 ${esc(c.name || 'Token')} <span class="subtle">$${esc(c.symbol || '')}</span></span>
                      <strong>${esc(c.balanceEth)} ${esc(c.stockSymbol || 'SPCX')}</strong>
                    </div>
                  `).join('')}
                </div>
              `;
            })()}
          </div>
          <div class="dash-actions-row">
            ${isMine ? `
              <button type="button" class="button primary dash-button-flex" data-action="claim-wallet-fees" data-wallet="${esc(w.address)}">
                Alle Gebühren abholen ⚡
              </button>
            ` : `
              <span class="subtle dash-subtle-hint">Private Key nicht im Tresor hinterlegt</span>
            `}
            <a class="text-link" href="${state.deployment.explorer}/address/${esc(w.address)}" target="_blank" rel="noopener noreferrer">Explorer ↗</a>
          </div>
        </article>
      `;
    }).join(''));
  }

  // Section 2: Dauerhafte Übersicht aller gelaunchten Tokens
  if (!launches.length) {
    render('#dash-launches-list', '<div class="empty">Noch keine Tokens gelauncht. Gelaunchte Tokens werden hier dauerhaft und übersichtlich aufgeführt.</div>');
  } else {
    render('#dash-launches-list', launches.map(l => {
      const fee = claimableFeesMap[l.curve?.toLowerCase()];
      const feeAmount = fee ? Number(fee.balanceEth) : 0;
      const formattedFee = feeAmount > 0 ? feeAmount.toFixed(6).replace(/\.?0+$/, '') : '0';
      const stockSym = fee?.stockSymbol || 'SPCX';
      const hasFees = feeAmount > 0;
      const isMine = fee?.isMine || false;

      // Points calculation per launch
      const depPoints = l.deployerPoints || 0;
      const pltPoints = l.pilotPoints || 0;
      const buyerList = Array.isArray(l.buyerPoints) ? l.buyerPoints : [];
      const buyPoints = buyerList.reduce((acc, b) => acc + (b.points || 0), 0);
      const eigenePunkte = Number((depPoints + buyPoints).toFixed(2));

      // PnL calculation per launch
      const launchFeeEth = Number(l.launchFeeEth || 0.0005);
      const snipeEth = Number(l.snipeEth || 0);
      const sellEth = Number(l.sellEth || 0);
      const feesAccrued = feeAmount > 0 ? feeAmount : Number(l.feesEth || 0);
      const netPnlEth = (typeof l.netPnlEth === 'number') ? l.netPnlEth : ((sellEth + feesAccrued) - (launchFeeEth + snipeEth));
      const hasPnlData = Boolean(l.hasPnlData || snipeEth || sellEth);
      const onchainPnlUsd = netPnlEth * 2600;
      const punkteWertUsd = eigenePunkte * effectivePointVal;
      const effPnlUsd = onchainPnlUsd + punkteWertUsd;

      return `
        <div class="item dash-launch-item">
          <div style="flex:1;">
            <div class="dash-token-row-header">
              <strong class="dash-token-title">${esc(l.name)}</strong>
              <span class="pill pill-mini">$${esc(l.symbol)}</span>
              ${hasFees ? `<span class="pill pill-mini pill-active">💰 ${esc(formattedFee)} ${esc(stockSym)}</span>` : ''}
            </div>

            <!-- Punkte pro Launch -->
            <div class="dash-points-row">
              ${depPoints > 0 ? `<span class="pill pill-mini pill-highlight" title="Verifizierte Deployer-Punkte auf Standard Reserve (Creator-Wallet)">👑 Deployer: ${esc(depPoints.toLocaleString('de-DE'))} Pkt</span>` : ''}
              ${buyerList.map(b => `<span class="pill pill-mini pill-active" title="${esc(b.label)} (${esc(short(b.wallet))}): $${b.usdVolume} Handelsvolumen">🛒 ${esc(b.label)}: ${esc(b.points.toLocaleString('de-DE'))} Pkt</span>`).join('')}
              <span class="pill pill-mini pill-button" style="font-weight: 700; border-color: var(--accent);" title="Summe deiner persönlichen Punkte (Deployer + Buyer Wallets)">⭐ Eigene Punkte: ${esc(eigenePunkte.toLocaleString('de-DE'))} Pkt</span>
            </div>

            <!-- PnL Auswertung pro Launch -->
            <div class="dash-pnl-box">
              <div class="dash-pnl-row">
                <div>
                  <span class="subtle">Launch:</span> <strong>${(launchFeeEth).toFixed(4)} ETH</strong> · 
                  <span class="subtle">Snipe:</span> <strong>${snipeEth > 0 ? `${snipeEth.toFixed(4)} ETH` : '0 ETH'}</strong> · 
                  <span class="subtle">Erlös:</span> <strong>${sellEth > 0 ? `${sellEth.toFixed(4)} ETH` : (snipeEth > 0 ? 'Moonbag' : '0 ETH')}</strong> · 
                  <span class="subtle">Fees:</span> <strong>+${feesAccrued.toFixed(6)} ETH</strong>
                </div>
                <div>
                  <span class="subtle">On-Chain Net:</span>
                  <strong class="${netPnlEth >= 0 ? 'dash-accent-text' : 'dash-danger-text'}" style="margin-left: 4px;">
                    ${netPnlEth >= 0 ? '+' : ''}${netPnlEth.toFixed(5)} ETH (${netPnlEth >= 0 ? '+' : ''}${onchainPnlUsd.toFixed(2)} $)
                  </strong>
                </div>
              </div>
              <div class="dash-pnl-effective-row">
                <div>
                  <span class="subtle">Punkte-Wert (${effectivePointVal.toFixed(5)} $/Pkt):</span>
                  <strong class="dash-accent-text" style="margin-left: 4px;">+${punkteWertUsd.toFixed(2)} $</strong>
                  <span class="subtle">(${eigenePunkte.toLocaleString('de-DE')} eigene Pkt)</span>
                </div>
                <div>
                  <span class="subtle">Effektives PnL (inkl. Punkte):</span>
                  <strong class="${effPnlUsd >= 0 ? 'dash-accent-text' : 'dash-danger-text'}" style="font-size: 13px; margin-left: 4px;">
                    ${effPnlUsd >= 0 ? '+' : ''}${effPnlUsd.toFixed(2)} $
                  </strong>
                </div>
              </div>
            </div>

            <small class="dash-contracts-line">
              Token: <a class="text-link" href="${state.deployment.explorer}/address/${esc(l.token)}" target="_blank" rel="noopener noreferrer">${esc(l.token)} ↗</a>
              &nbsp;·&nbsp; Curve: <a class="text-link" href="${state.deployment.explorer}/address/${esc(l.curve)}" target="_blank" rel="noopener noreferrer">${esc(short(l.curve))} ↗</a>
              &nbsp;·&nbsp; Deployer: ${esc(short(l.wallet || ''))}
            </small>
            ${l.confirmedAt ? `<small class="subtle dash-confirmed-line">Gelauncht am: ${date(l.confirmedAt)}</small>` : ''}
          </div>
          <div class="item-actions dash-item-actions">
            ${(hasFees && isMine) ? `
              <button type="button" class="button mini primary" data-action="claim-fees" data-curve="${esc(l.curve)}">
                Gebühr claimen ➔
              </button>
            ` : ''}
            <button type="button" class="button mini secondary" data-action="monitor-launch" data-id="${esc(l.hash)}">
              Monitoring anlegen ↗
            </button>
            <a class="button mini secondary" href="${state.deployment.explorer}/tx/${esc(l.hash)}" target="_blank" rel="noopener noreferrer">
              TX ↗
            </a>
            <a class="button mini secondary" href="https://www.standardreserve.xyz/token/${esc(l.token)}" target="_blank" rel="noopener noreferrer">
              Standard Reserve ↗
            </a>
            <button type="button" class="button mini secondary danger-hover" data-action="delete-launch" data-hash="${esc(l.hash)}" title="Diesen Launch aus der Liste entfernen">
              ✕ Entfernen
            </button>
          </div>
        </div>
      `;
    }).join(''));
  }
}

let lastRenderedNextTokenId = null;
let lastRenderedVaultHash = null;

function renderNextTokenCard(item, al) {
  const card = $('#next-token-card');
  if (!card) return;
  if (!item) {
    card.hidden = true;
    lastRenderedNextTokenId = null;
    return;
  }
  card.hidden = false;

  const content = $('#next-token-content');
  if (!content) return;

  const isRunning = al?.status === 'running' || al?.status === 'soft_stopping';
  const badge = $('#next-token-status-badge');
  if (badge) {
    if (al?.status === 'soft_stopping') {
      badge.textContent = 'Soft Stop: Beendet laufenden Launch …';
      badge.className = 'pill pill-warning';
    } else if (isRunning) {
      badge.textContent = 'Läuft gerade on-chain …';
      badge.className = 'pill pill-active';
    } else if (al?.enabled && al.countdownSeconds > 0) {
      badge.textContent = `Auto-Start in ${al.countdownSeconds} s`;
      badge.className = 'pill';
    } else {
      badge.textContent = 'Bereit (vor Launch editierbar)';
      badge.className = 'pill';
    }
  }

  // IMPORTANT: Prevent flickering!
  // If the same queue token is already displayed, DO NOT wipe content.innerHTML.
  // Re-creating the <img> tag causes the browser to re-request and re-decode the image every 3 seconds!
  if (lastRenderedNextTokenId === item.id) {
    content.querySelectorAll('input, select, button').forEach(el => {
      if (el.id !== 'next-token-save-btn' && el.id !== 'next-token-trigger-btn') {
        el.disabled = isRunning;
      }
    });
    const saveBtn = $('#next-token-save-btn');
    const trigBtn = $('#next-token-trigger-btn');
    if (saveBtn) saveBtn.disabled = isRunning;
    if (trigBtn) trigBtn.disabled = isRunning;
    return;
  }

  if (content.contains(document.activeElement)) {
    return; // Keep user's focus/typing intact
  }

  lastRenderedNextTokenId = item.id;

  const imgSrc = (item.id && item.imagePath) ? `/api/queue/${esc(item.id)}/image` : (item.image || '/favicon.svg');
  const country = item.country || 'us';
  const drop = item.charterDrop || '10%';
  const pool = item.afterGraduates || 'only in its own pool';
  const hook = item.hook || 'off';
  const payout = item.payout || 'at exit';
  const devBuy = item.devBuy || 'off';
  const snipeTax = item.snipeTax || 'off';
  const mcap = item.monitor?.rules?.[0]?.threshold || 5000;
  const sellMode = item.monitor?.autoSellMode || 'all';
  const assetName = item.imagePath ? item.imagePath.split('/').pop().split('\\').pop() : 'Kein lokales Bild';

  content.innerHTML = `
    <div class="next-token-grid">
      <div>
        <div class="next-token-art">
          <img src="${imgSrc}" alt="${esc(item.name)}">
        </div>
        <p class="field-help monospace subtle">${esc(assetName)}</p>
      </div>
      <div>
        <div class="fields two">
          <label>Token-Name
            <input type="text" id="next-token-name" value="${esc(item.name)}" ${isRunning ? 'disabled' : ''} maxlength="40" required>
          </label>
          <label>Symbol
            <input type="text" id="next-token-symbol" value="${esc(item.symbol)}" ${isRunning ? 'disabled' : ''} maxlength="10" required>
          </label>
        </div>
        <div class="fields two">
          <label>Beschreibung
            <input type="text" id="next-token-desc" value="${esc(item.description || '')}" ${isRunning ? 'disabled' : ''} maxlength="200">
          </label>
          <label>Website
            <input type="url" id="next-token-website" value="${esc(item.website || '')}" ${isRunning ? 'disabled' : ''} placeholder="https://…">
          </label>
        </div>
        <div class="fields three">
          <label>Handelspaar
            <select id="next-token-country" ${isRunning ? 'disabled' : ''}>
              <option value="us" ${country === 'us' ? 'selected' : ''}>🇺🇸 US ($SPCX)</option>
              <option value="eth" ${country === 'eth' ? 'selected' : ''}>⟠ ETH (ETH)</option>
              <option value="cn" ${country === 'cn' ? 'selected' : ''}>🇨🇳 CN ($BABA)</option>
              <option value="kr" ${country === 'kr' ? 'selected' : ''}>🇰🇷 KR ($SKHY)</option>
            </select>
          </label>
          <label>Charter Drop
            <select id="next-token-charterDrop" ${isRunning ? 'disabled' : ''}>
              <option value="0%" ${drop === '0%' ? 'selected' : ''}>0%</option>
              <option value="5%" ${drop === '5%' ? 'selected' : ''}>5%</option>
              <option value="10%" ${(drop === '10%' || !drop) ? 'selected' : ''}>10% (Standard)</option>
              <option value="15%" ${drop === '15%' ? 'selected' : ''}>15%</option>
              <option value="20%" ${drop === '20%' ? 'selected' : ''}>20%</option>
            </select>
          </label>
          <label>Liquidität nach Abschluss
            <select id="next-token-pool" ${isRunning ? 'disabled' : ''}>
              <option value="only in its own pool" ${pool !== 'uniswap v3' ? 'selected' : ''}>only in its own pool (Standard)</option>
              <option value="uniswap v3" ${pool === 'uniswap v3' ? 'selected' : ''}>uniswap v3</option>
            </select>
          </label>
        </div>
        <div class="fields four">
          <label>Hook Module
            <select id="next-token-hook" ${isRunning ? 'disabled' : ''}>
              <option value="off" ${hook !== 'on' ? 'selected' : ''}>off (Standard)</option>
              <option value="on" ${hook === 'on' ? 'selected' : ''}>on</option>
            </select>
          </label>
          <label>Payout
            <select id="next-token-payout" ${isRunning ? 'disabled' : ''}>
              <option value="at exit" ${payout !== 'instant' ? 'selected' : ''}>at exit (Standard)</option>
              <option value="instant" ${payout === 'instant' ? 'selected' : ''}>instant</option>
            </select>
          </label>
          <label>Dev Buy
            <select id="next-token-devBuy" ${isRunning ? 'disabled' : ''}>
              <option value="off" ${devBuy !== 'on' ? 'selected' : ''}>off (Standard)</option>
              <option value="on" ${devBuy === 'on' ? 'selected' : ''}>on</option>
            </select>
          </label>
          <label>Snipe Tax
            <select id="next-token-snipeTax" ${isRunning ? 'disabled' : ''}>
              <option value="off" ${snipeTax !== 'on' ? 'selected' : ''}>off (Standard)</option>
              <option value="on" ${snipeTax === 'on' ? 'selected' : ''}>on</option>
            </select>
          </label>
        </div>
        <div class="fields two">
          <label>Monitor Market Cap Trigger ($)
            <input type="number" id="next-token-mcap" value="${mcap}" ${isRunning ? 'disabled' : ''} min="1000" step="5000">
          </label>
          <label>Auto-Sell Modus
            <select id="next-token-sellMode" ${isRunning ? 'disabled' : ''}>
              <option value="all" ${sellMode !== 'n_minus_1' ? 'selected' : ''}>Alle Wallets verkaufen (100%)</option>
              <option value="n_minus_1" ${sellMode === 'n_minus_1' ? 'selected' : ''}>N-1 verkaufen (Moonbag behalten)</option>
            </select>
          </label>
        </div>
        <div class="fields">
          <label>Referrer / Punkte-Adresse (Ref)
            <input type="text" id="next-token-referrer" value="${esc(item.referrer && item.referrer !== '0x0000000000000000000000000000000000000000' ? item.referrer : (autoLauncherStatus?.defaultReferrer || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7'))}" ${isRunning ? 'disabled' : ''} placeholder="0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7" spellcheck="false">
          </label>
        </div>
        <div class="form-actions">
          <button type="button" id="next-token-save-btn" class="button primary" ${isRunning ? 'disabled' : ''}>Änderungen für nächsten Launch speichern 💾</button>
          <button type="button" id="next-token-trigger-btn" class="button secondary" ${isRunning ? 'disabled' : ''}>⚡ Jetzt genau diesen Launch ausführen</button>
        </div>
      </div>
    </div>
  `;

  const artImg = content.querySelector('.next-token-art img');
  if (artImg) {
    artImg.addEventListener('error', () => {
      artImg.src = '/favicon.svg';
    }, { once: true });
  }

  $('#next-token-save-btn').onclick = () => busy($('#next-token-save-btn'), async () => {
    const name = $('#next-token-name').value.trim();
    const symbol = $('#next-token-symbol').value.trim().toUpperCase();
    const description = $('#next-token-desc').value.trim();
    const website = $('#next-token-website').value.trim();
    const country = $('#next-token-country').value;
    const charterDrop = $('#next-token-charterDrop').value;
    const afterGraduates = $('#next-token-pool').value;
    const hook = $('#next-token-hook').value;
    const payout = $('#next-token-payout').value;
    const devBuy = $('#next-token-devBuy').value;
    const snipeTax = $('#next-token-snipeTax').value;
    const referrer = $('#next-token-referrer')?.value.trim() || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7';
    const thresholdMcap = Number($('#next-token-mcap').value) || 150000;
    const autoSellMode = $('#next-token-sellMode').value;

    const updated = await api(`/queue/${item.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name,
        symbol,
        description,
        website,
        country,
        charterDrop,
        afterGraduates,
        hook,
        payout,
        devBuy,
        snipeTax,
        referrer,
        monitor: {
          rules: [{ metric: 'marketCapUsd', operator: 'gte', threshold: thresholdMcap }],
          autoSellMode,
        }
      })
    });
    show(`Änderungen für nächsten Launch „${updated.name}“ erfolgreich gespeichert.`);
    lastRenderedNextTokenId = null;
    await refresh();
  });

  $('#next-token-trigger-btn').onclick = () => busy($('#next-token-trigger-btn'), async () => {
    const res = await post('/auto-launcher/trigger', {});
    if (res.error) throw new Error(res.error);
    if (res.skipped) show(`Übersprungen: ${res.skipped}`);
    else show(`Launch ausgeführt: Token ${res.token} (TX: ${short(res.hash)})`);
    await refresh();
  });
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

    // Topbar vault status / toggle button
    const vPill = $('#vault-status-pill');
    if (vPill) {
      if (!vaultStatus.initialized) {
        vPill.textContent = '🔒 Tresor einrichten ➔';
        vPill.className = 'pill offline pill-button';
        vPill.title = 'Klicken, um den Tresor mit Master-Passwort einzurichten';
      } else if (!vaultStatus.unlocked) {
        vPill.textContent = '🔒 Tresor gesperrt · Entsperren ➔';
        vPill.className = 'pill offline pill-button';
        vPill.title = 'Klicken, um den Tresor mit Master-Passwort zu entsperren';
      } else {
        vPill.textContent = `🔓 Tresor entsperrt (${vaultWallets.length}) · Sperren`;
        vPill.className = 'pill pill-active pill-button';
        vPill.title = 'Klicken, um den Tresor jetzt manuell zu sperren';
      }
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
      } else if (al.status === 'paused_vault_locked') {
        badgeText = 'Pausiert: Tresor gesperrt 🔒';
        badgeClass = 'pill offline';
      } else if (al.status === 'soft_stopping') {
        badgeText = 'Soft Stop: Beendet laufenden Launch …';
        badgeClass = 'pill pill-warning';
      } else if (al.status === 'running') {
        badgeText = 'Läuft …';
        badgeClass = 'pill pill-active';
      } else if (al.status === 'completed') {
        badgeText = `Ziel erreicht (${al.executedInRun}/${al.targetCount}) 🎯`;
        badgeClass = 'pill pill-active';
      } else if (al.status === 'stopped') {
        badgeText = 'Gestoppt ⏹️';
        badgeClass = 'pill offline';
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

      // Update control button highlight classes
      const isRunning = al.status === 'running';
      const isSoftStopping = al.status === 'soft_stopping' || al.softStopRequested;
      const isPaused = al.status === 'paused' || al.status === 'paused_insufficient_funds' || al.status === 'paused_vault_locked';

      $('#ctrl-btn-start')?.classList.toggle('active-running', al.enabled && !isSoftStopping);
      $('#ctrl-btn-pause')?.classList.toggle('active-paused', isPaused);
      $('#ctrl-btn-soft-stop')?.classList.toggle('active-stopping', isSoftStopping);

      // Progress banner
      if ($('#auto-launcher-status-text')) {
        let statusMsg = 'Status: Bereit zum Start';
        if (isSoftStopping) {
          statusMsg = 'Status: 🛑 Soft Stop angefordert (aktiver Launch läuft noch zu Ende)';
        } else if (isRunning) {
          statusMsg = 'Status: 🚀 Launch wird gerade on-chain ausgeführt …';
        } else if (al.enabled) {
          statusMsg = al.countdownSeconds > 0
            ? `Status: ▶️ Aktiv (Nächster Launch in ${al.countdownSeconds} s)`
            : 'Status: ▶️ Aktiv (Start in Kürze …)';
        } else if (isPaused) {
          statusMsg = 'Status: ⏸️ Pausiert';
        } else if (al.status === 'completed') {
          statusMsg = `Status: 🎯 Ziel-Anzahl erreicht (${al.executedInRun}/${al.targetCount} gelauncht)`;
        } else if (al.status === 'stopped') {
          statusMsg = 'Status: ⏹️ Gestoppt';
        }
        $('#auto-launcher-status-text').textContent = statusMsg;
      }

      if ($('#auto-launcher-count-pill')) {
        const targetStr = al.limitMode === 'count' ? String(al.targetCount) : '∞';
        $('#auto-launcher-count-pill').textContent = `${al.executedInRun || 0} / ${targetStr} ausgeführt`;
        $('#auto-launcher-count-pill').className = `pill ${al.enabled ? 'pill-active' : 'subtle'}`;
      }

      const isRotate = al.walletMode === 'rotate';
      let infoText = isRotate
        ? `Führt alle ${al.intervalMinutes} Minuten den nächsten Eintrag der Queue aus und rotiert reihum durch ${al.rotationWalletIds?.length || 0} angewählte Tresor-Wallets.`
        : `Führt alle ${al.intervalMinutes} Minuten den nächsten Eintrag der Queue mit der festen Standard-Wallet aus (Fallback oder CSV).`;
      if (al.nextWallet) infoText += ` Nächste Launch-Wallet: 🔒 ${al.nextWallet.label} (${short(al.nextWallet.address)}).`;
      if (al.lastRunAt) infoText += ` Letzter Lauf: ${date(al.lastRunAt)}.`;
      if (al.lastSuccess) infoText += ` Zuletzt gelauncht: ${al.lastSuccess.name} (${short(al.lastSuccess.token)}).`;
      if (al.intervalVarianceSeconds > 0) infoText += ` (Zufallsvarianz: ± ${al.intervalVarianceSeconds} s).`;
      if (al.lastError) infoText += ` Fehler: ${al.lastError}`;
      $('#auto-launcher-info').textContent = infoText;

      // 2. Initialize inputs ONCE so polling never blows away user's typing/toggling
      if (!autoLauncherFormInitialized) {
        autoLauncherFormInitialized = true;
        if ($('#auto-launcher-enabled')) $('#auto-launcher-enabled').checked = Boolean(al.enabled);
        $('#auto-launcher-interval').value = al.intervalMinutes || 5;
        if ($('#auto-launcher-variance')) {
          $('#auto-launcher-variance').value = al.intervalVarianceSeconds ?? 0;
        }

        if ($('#auto-launcher-limit-mode')) {
          $('#auto-launcher-limit-mode').value = al.limitMode || 'all';
        }
        if ($('#auto-launcher-target-count')) {
          $('#auto-launcher-target-count').value = al.targetCount || 5;
        }
        if ($('#auto-launcher-target-count-box')) {
          $('#auto-launcher-target-count-box').hidden = (al.limitMode !== 'count');
        }

        if (al.pairAmounts) {
          if ($('#auto-snipe-amount-us')) $('#auto-snipe-amount-us').value = al.pairAmounts.us || '0.05';
          if ($('#auto-snipe-amount-eth')) $('#auto-snipe-amount-eth').value = al.pairAmounts.eth || '0.005';
          if ($('#auto-snipe-amount-cn')) $('#auto-snipe-amount-cn').value = al.pairAmounts.cn || '0.1';
          if ($('#auto-snipe-amount-kr')) $('#auto-snipe-amount-kr').value = al.pairAmounts.kr || '0.1';
        }

        if ($('#auto-launcher-referrer')) {
          $('#auto-launcher-referrer').value = al.defaultReferrer || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7';
        }

        $('#auto-wallet-mode-rotate').checked = isRotate;
        $('#auto-wallet-mode-single').checked = !isRotate;
        $('#auto-launcher-rotate-box').hidden = !isRotate;
        $('#auto-launcher-single-box').hidden = isRotate;

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
      }

      // Reactive Vault Check: Update wallet dropdowns and lists whenever the vault is locked/unlocked or wallet list changes!
      const currentVaultHash = vaultStatus.unlocked ? vaultWallets.map(w => w.id + w.balanceEth).join(',') : 'locked';
      if (currentVaultHash !== lastRenderedVaultHash) {
        lastRenderedVaultHash = currentVaultHash;

        if (!vaultStatus.unlocked) {
          render('#auto-launcher-default-wallet', '<option value="">🔒 Tresor ist gesperrt – bitte zuerst entsperren</option>');
          render('#auto-rotate-wallets-list', `
            <div class="callout-box" style="margin: 8px 0;">
              <strong style="color:var(--orange);">🔒 Tresor ist gesperrt</strong>
              <p style="margin: 4px 0 10px; font-size: 11px;">Bitte entsperre deinen Tresor mit dem Master-Passwort, um Wallets für die Rotation auszuwählen.</p>
              <button type="button" class="button mini primary" data-action="quick-unlock-vault">Jetzt Tresor entsperren 🔓</button>
            </div>
          `);
        } else if (!vaultWallets.length) {
          render('#auto-launcher-default-wallet', '<option value="">Keine Wallets im Tresor</option>');
          render('#auto-rotate-wallets-list', '<div class="empty">Noch keine Wallets im Tresor. Bitte zuerst unter „Wallets“ neue Wallets anlegen.</div>');
        } else {
          const currentVal = $('#auto-launcher-default-wallet')?.value || al.defaultWalletId;
          render('#auto-launcher-default-wallet', '<option value="">Keine Standard-Wallet (CSV-Fallback)</option>' + vaultWallets.map(w => `<option value="${esc(w.id)}" ${w.id === currentVal ? 'selected' : ''}>${esc(w.label)} · ${short(w.address)} (${esc(w.balanceEth)} ETH)</option>`).join(''));

          const savedRotateSet = new Set(al.rotationWalletIds || []);
          render('#auto-rotate-wallets-list', vaultWallets.map(w => {
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
          }).join(''));
        }

        void updateSnipeWallets(state.queue?.[0]?.country || 'us');
      } else {
        // Subsequent poll with unchanged vault: only update the next-wallet indicator badge without touching checkboxes or rebuilding the DOM!
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

    // Render Next Token Teaser Card
    renderNextTokenCard(state.queue?.[0], al);

    // Queue CSV Sync status
    try {
      const syncInfo = await api('/queue/sync');
      if (syncInfo && document.activeElement !== $('#queue-file-path')) {
        if ($('#queue-file-path')) $('#queue-file-path').value = syncInfo.path || 'examples/launch-queue.csv';
        if ($('#queue-sync-badge')) {
          $('#queue-sync-badge').textContent = syncInfo.error ? 'Fehler' : 'Live synchronisiert';
          $('#queue-sync-badge').className = `pill ${syncInfo.error ? 'offline' : 'pill-active'}`;
        }
        if ($('#queue-sync-info')) {
          const syncTime = syncInfo.lastSyncAt ? date(syncInfo.lastSyncAt) : 'noch nicht synchronisiert';
          $('#queue-sync-info').textContent = `Dateipfad: ${syncInfo.path} · Zuletzt eingelesen: ${syncTime} (${syncInfo.count} Entwürfe in Queue)${syncInfo.error ? ` · Fehler: ${syncInfo.error}` : ''}`;
        }
      }
    } catch {}

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
      const refAddr = q.referrer && q.referrer !== '0x0000000000000000000000000000000000000000' ? q.referrer : (al?.defaultReferrer || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7');
      const refTag = `<span class="pill pill-mini" title="Punkte/Ref gehen an ${esc(refAddr)}">🎯 Ref: ${esc(short(refAddr))}</span>`;
      return `<div class="item"><div><strong>${index + 1}. ${esc(q.name)} · $${esc(q.symbol)}</strong><small>${esc(state.deployment.stocks[q.country].symbol)} · ${walletTag}${monTag ? ` · ${monTag}` : ''}${autoSellTag ? ` · ${autoSellTag}` : ''} · ${refTag}<br>${q.metadataURI ? 'Eigene Metadata-URL' : 'Standard-Metadaten des Referenz-Tokens'}${q.imagePath ? `<br>Lokale Vorschau: ${esc(q.imagePath)}` : ''}</small></div><div class="item-actions"><button class="text-button" data-action="load-queue" data-id="${q.id}">Zur Prüfung laden ↗</button><button class="text-button" data-action="delete-queue" data-id="${q.id}">Entfernen</button></div></div>`;
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

    let feeData = { byCurve: [], byWallet: {} };
    try {
      const feesResp = await api('/fees');
      feeData = Array.isArray(feesResp) ? { byCurve: feesResp, byWallet: {} } : feesResp;
      claimableFeesMap = Object.fromEntries((feeData.byCurve || []).map(f => [f.curve?.toLowerCase(), f]));
    } catch {
      claimableFeesMap = {};
    }

    lastState = state;
    lastFeeData = feeData;
    renderDashboard(state, feeData);

    render('#monitors', state.monitors.length ? state.monitors.map(m => {
      const s = m.snapshot;
      const creatorHtml = m.creatorWallet
        ? `<div class="monitor-creator-info"><small>Creator:</small> <strong>${esc(m.creatorLabel || 'Deployer')}</strong> <span class="address">(${esc(short(m.creatorWallet))})</span></div>`
        : '';
      const feeInfo = m.curve ? claimableFeesMap[m.curve.toLowerCase()] : null;
      const feeHtml = (feeInfo && Number(feeInfo.balanceEth) > 0)
        ? `<div class="monitor-creator-info monitor-fee-banner">
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
      return `<article class="panel monitor-card"><div class="monitor-title"><h2>${esc(m.name)}</h2>${sellBadge}<span class="pill ${!m.enabled || m.error ? 'offline' : ''}">${m.error ? 'Datenfehler' : m.enabled ? 'Aktiv' : 'Pausiert'}</span></div><p class="address">${esc(m.token)}</p><div class="metrics"><div><small>MARKET CAP</small><strong>${money(s?.marketCapUsd)}</strong></div><div><small>VOLUMEN · 24 H</small><strong>${money(s?.volume24hUsd)}</strong></div><div><small>LIQUIDITÄT</small><strong>${money(s?.liquidityUsd)}</strong></div><div><small>PREIS</small><strong>${money(s?.priceUsd)}</strong></div></div><div class="rule-summary">${m.rules.map(r => `${metricLabels[r.metric]} ${r.operator === 'gte' ? '≥' : '≤'} ${esc(r.threshold)}`).join(m.mode === 'all' ? '<br>UND ' : '<br>ODER ')}<br><span class="subtle">${m.holdSeconds} s Haltezeit · ${m.once ? 'Einmalig' : `${m.cooldownSeconds} s Cooldown`}</span></div>${creatorHtml}${feeHtml}${purchasesHtml}${sellResultsHtml}${m.error ? `<p class="error">${esc(m.error)}</p>` : ''}<p class="subtle">Datenstand: ${date(s?.asOfTime ? s.asOfTime * 1000 : null)}</p><div class="item-actions"><button type="button" class="button mini secondary danger-hover" data-action="manual-exit" data-id="${m.id}" title="Sofort alle gekauften Token auf der Bonding-Curve verkaufen">⚡ Manuell verkaufen (Exit)</button><button class="text-button" data-action="toggle" data-id="${m.id}">${m.enabled ? 'Pausieren' : 'Fortsetzen'}</button><button class="text-button" data-action="edit-monitor" data-id="${m.id}">Bearbeiten</button><button class="text-button" data-action="rearm" data-id="${m.id}">Neu scharfstellen</button><button class="text-button" data-action="delete-monitors" data-id="${m.id}">Entfernen</button></div></article>`;
    }).join('') : '<div class="panel empty">Noch keine Monitore aktiv. Füge eine Token-Adresse und deine erste Trigger-Regel hinzu.</div>');

    const filteredAlerts = activeAlertFilter === 'all'
      ? state.alerts
      : state.alerts.filter(a => getAlertCategory(a) === activeAlertFilter);

    render('#alerts', filteredAlerts.length ? filteredAlerts.map(a => {
      const cat = getAlertCategory(a);
      const catCfg = {
        error: { label: 'Fehler', icon: '🚨', pill: 'pill-danger', item: 'alert-item-error' },
        warning: { label: 'Warnung', icon: '⚠️', pill: 'pill-warning', item: 'alert-item-warning' },
        success: { label: 'Erfolg', icon: '✅', pill: 'pill-success', item: 'alert-item-success' },
        info: { label: 'Info', icon: 'ℹ️', pill: 'pill-info', item: 'alert-item-info' },
      }[cat] || { label: 'Info', icon: 'ℹ️', pill: 'pill-info', item: 'alert-item-info' };

      const mcapText = a.metrics?.marketCapUsd ? ` · Market Cap ${money(a.metrics.marketCapUsd)}` : '';
      const volText = a.metrics?.volume24hUsd ? ` · Volumen 24 h ${money(a.metrics.volume24hUsd)}` : '';
      const tokenText = (a.token && a.token !== '0x0000000000000000000000000000000000000000') ? `<br>${esc(a.token)}` : '';

      return `
        <article class="item alert-card ${catCfg.item} ${a.read ? '' : 'alert-unread'}">
          <div>
            <div class="alert-header">
              <span class="alert-icon">${catCfg.icon}</span>
              <strong>${esc(a.name)}</strong>
              <span class="pill pill-mini ${catCfg.pill}">${catCfg.label}</span>
            </div>
            <p class="alert-message">${esc(a.message)}</p>
            <div class="alert-details">
              ${esc(date(a.at))}${mcapText}${volText}${tokenText}
            </div>
          </div>
          <span class="pill">${a.read ? 'Gelesen' : 'Neu'}</span>
        </article>
      `;
    }).join('') : `<div class="empty">${activeAlertFilter === 'all' ? 'Alles ruhig. Sobald eine Regel auslöst, findest du den Alert mit Zeitstempel und Kennzahlen hier.' : 'Keine Alerts in dieser Kategorie vorhanden.'}</div>`);
  } catch (e) {
    $('#connection-status').textContent = '● Server nicht erreichbar'; $('#connection-status').classList.add('offline');
    show(`Lokaler Server nicht erreichbar: ${e.message}. Monitoring läuft nur bei gestartetem Server.`, true);
  } finally { loadingState = false; }
}

document.addEventListener('click', e => {
  const button = e.target.closest('[data-action]'); if (!button) return;
  busy(button, async () => {
    const { action, id, hash } = button.dataset;
    if (action === 'delete-launch') {
      const targetHash = hash || id || button.dataset.hash;
      await api(`/launches/${targetHash}`, { method: 'DELETE' });
      show('Launch aus der Übersicht entfernt.');
      await refresh();
      return;
    }
    if (action === 'delete-all-launches') {
      if (!confirm('Möchtest du wirklich alle gelaunchten Tokens aus dieser Übersicht entfernen?')) return;
      await api('/launches', { method: 'DELETE' });
      show('Alle gelaunchten Tokens wurden aus der Übersicht entfernt.');
      await refresh();
      return;
    }
    if (action === 'manual-exit') {
      if (!confirm('Möchtest du wirklich sofort alle Token dieses Monitors auf der Bonding-Curve verkaufen?')) return;
      show('Sofort-Verkauf wird auf der Blockchain ausgeführt …');
      const res = await post(`/monitors/${id}/exit`, {});
      if (res.results && res.results.length) {
        const successes = res.results.filter(r => r.status === 'success');
        if (successes.length) {
          show(`Erfolgreich verkauft: ${successes.length} Wallet(s) haben ihre Token abgestoßen!`);
        } else {
          show(`Verkauf fehlgeschlagen: ${res.results[0]?.error || 'Kein Erlös erzielt.'}`, true);
        }
      } else {
        show('Verkauf ausgeführt.');
      }
      await refresh();
      return;
    }
    if (action === 'quick-unlock-vault') {
      handleVaultToggle();
      return;
    }
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
    } else if (action === 'claim-fees' || action === 'claim-wallet-fees') {
      const origHtml = button.innerHTML;
      const allClaimButtons = Array.from(document.querySelectorAll('[data-action^="claim-"]'));
      allClaimButtons.forEach(b => b.disabled = true);
      button.innerHTML = '<span class="claim-spinner">⏳</span> Wird geclaimt …';
      show('Gebühren werden on-chain abgeholt und verarbeitet. Bitte einen Moment Geduld …');
      try {
        if (action === 'claim-fees') {
          const curve = button.dataset.curve;
          const swapToEth = $('#dash-global-autoswap') ? $('#dash-global-autoswap').checked : true;
          const res = await post('/fees/claim', { curve, swapToEth });
          if (res.swapResult?.swapped) {
            show(`Erfolgreich ${res.claimedAmount || ''} ${res.stockSymbol || 'SPCX'} geclaimt und direkt in ${res.swapResult.ethReceived || ''} ETH umgetauscht! (TX: ${short(res.hash)})`);
          } else {
            show(`Erfolgreich ${res.claimedAmount || ''} ${res.stockSymbol || 'SPCX'} Gebühren abgeholt! TX: ${res.hash}`);
          }
        } else if (action === 'claim-wallet-fees') {
          const walletAddress = button.dataset.wallet;
          const swapToEth = $('#dash-global-autoswap') ? $('#dash-global-autoswap').checked : true;
          const res = await post('/fees/claim', { walletAddress, swapToEth });
          if (res.success) {
            const count = res.results?.length || 0;
            show(`Erfolgreich alle Gebühren für ${short(walletAddress)} (${count} Token) abgeholt${swapToEth ? ' und direkt in ETH getauscht' : ''}!`);
          } else {
            show(`Gebühren-Abholung abgeschlossen: ${JSON.stringify(res)}`);
          }
        }
      } finally {
        button.innerHTML = origHtml;
        allClaimButtons.forEach(b => b.disabled = false);
      }
    }
    await refresh();
  });
});

async function handleVaultToggle() {
  if (!vaultStatus.initialized) {
    navigate('wallets');
    return;
  }
  if (vaultStatus.unlocked) {
    await post('/vault/lock');
    show('Tresor gesperrt 🔒.');
    await refresh();
  } else {
    $('#quick-unlock-password').value = '';
    $('#vault-quick-unlock-dialog').showModal();
    $('#quick-unlock-password').focus();
  }
}

if ($('#vault-status-pill')) {
  $('#vault-status-pill').onclick = handleVaultToggle;
}
if ($('#vault-topbar-toggle-btn')) {
  $('#vault-topbar-toggle-btn').onclick = handleVaultToggle;
}

if ($('#vault-quick-unlock-form')) {
  $('#vault-quick-unlock-form').onsubmit = e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const password = $('#quick-unlock-password').value;
      await post('/vault/unlock', { password });
      $('#vault-quick-unlock-dialog').close();
      $('#quick-unlock-password').value = '';
      show('Tresor erfolgreich entsperrt 🔓.');
      await refresh();
    });
  };
}

if ($('#close-quick-unlock-btn')) {
  $('#close-quick-unlock-btn').onclick = () => {
    $('#vault-quick-unlock-dialog').close();
  };
}

await refresh(); void terms();
if (selectedProvider()) { walletSession.select(selectedProvider()); void walletSession.connect(true).catch(() => {}); }
if (pendingHash) { show(`Gesendeter Launch ${pendingHash} wird weiter geprüft.`); void checkReceipt(); }
setInterval(() => { void refresh(); void checkReceipt(); }, 3000);
