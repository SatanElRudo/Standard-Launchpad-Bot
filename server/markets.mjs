import { deployment } from '../shared/deployment.mjs';
export async function marketToken(address) {
  const response = await fetch(`${deployment.markets}/v1/tokens/${address}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Markt-API: HTTP ${response.status}${response.status === 404 ? ' – Token noch nicht indexiert.' : ''}`);
  const data = await response.json();
  if (!data.token || data.token.address?.toLowerCase() !== address.toLowerCase()) throw new Error('Markt-API liefert keine passenden Token-Daten.');
  const t = data.token;
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return { name: t.name, symbol: t.symbol, token: address, stage: t.stage,
    asOfTime: numeric(data.asOfTime), asOfBlock: data.asOfBlock, stale: data.stale !== false,
    priceUsd: numeric(t.priceUsd), marketCapUsd: numeric(t.marketCapUsd), volume24hUsd: numeric(t.volume24hUsd),
    liquidityUsd: numeric(t.liquidityUsd), trades24h: numeric(t.trades24h), launchedAt: numeric(t.launchedAt) };
}
