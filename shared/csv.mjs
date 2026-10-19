// CSV import format, not a transaction or scheduling format.
export const csvColumns = [
  'name', 'symbol', 'country', 'description', 'image_path', 'image_url', 'metadata_uri', 'website', 'wallet',
  'monitor_enabled', 'monitor_rules', 'monitor_mcap_gte', 'monitor_price_change_gte', 'monitor_drawdown_gte',
  'monitor_volume_gte', 'monitor_mode', 'monitor_hold_seconds', 'monitor_cooldown_seconds', 'monitor_once',
  'monitor_auto_sell', 'monitor_sell_mode'
];
export function parseCsv(source) {
  if (typeof source !== 'string' || source.length > 60000) throw new Error('CSV fehlt oder ist größer als 60 KB.');
  const input = source.replace(/^\uFEFF/, '');
  const headerLine = input.split(/\r?\n/, 1)[0];
  const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
  const rows = []; let row = [], value = '', quoted = false, closed = false;
  const field = () => { row.push(value); value = ''; closed = false; };
  const record = () => { field(); if (row.some(v => v.trim())) rows.push(row); row = []; };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else value += ch;
    } else if (ch === delimiter) field();
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && input[i + 1] === '\n') i++; record(); }
    else if (ch === '"' && value === '' && !closed) quoted = true;
    else if (closed || ch === '"') throw new Error(`Ungültige CSV-Quotes bei Zeichen ${i + 1}.`);
    else value += ch;
  }
  if (quoted) throw new Error('CSV enthält ein nicht geschlossenes Anführungszeichen.');
  if (value || row.length || closed) record();
  const headers = rows.shift()?.map(v => v.trim());
  if (!headers || headers.length !== new Set(headers).size || headers.some(h => !csvColumns.includes(h))) throw new Error('CSV-Kopfzeile fehlt, ist doppelt oder enthält unbekannte Spalten.');
  if (!['name', 'symbol', 'country'].every(h => headers.includes(h))) throw new Error('CSV benötigt die Spalten name, symbol und country.');
  if (!rows.length || rows.length > 200) throw new Error('CSV muss 1 bis 200 Einträge enthalten.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV-Eintrag ${index + 1}: falsche Spaltenanzahl.`);
    return Object.fromEntries(headers.map((key, i) => [key, values[i]]));
  });
}
