// Source: public Standard Reserve frontend, retrieved 2026-10-20.
export const deployment = {
  chainId: 4663,
  name: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robin.etherscan.io',
  markets: 'https://markets.standardreserve.xyz',
  factory: '0x3D69104Da2518f4833D71444D6611310F2D685f2',
  router: '0x3c7476e8Be0efd5b9667421448a99E217B806E80',
  earlierLaunchpads: [
    {
      factory: '0x3D6Ea4e97B8AB9E1A1B4943fEBfFe22D8c920091',
      router: '0x190B452D16e12e3bEeDd76a030EA991fE3856c33',
    },
  ],
  metadataDefault: {
    token: '0xf54da332441779178c84553e9d98019a46867c02',
    uri: 'https://img.standardreserve.xyz/m/d4c2ac8cf9708493ab310a2cfbd5cd56.json',
    image: 'https://img.standardreserve.xyz/img/63bc2eca2ff4fa569be36b8a6618065d5162d00c714cef1c715da44c0426f14b.webp',
    verifiedBlock: '92715867',
  },
  stocks: {
    us: { symbol: 'SPCX', name: 'USA', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa' },
    eth: { symbol: 'WETH', name: 'Ethereum', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', native: true },
    cn: { symbol: 'BABA', name: 'China', address: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4' },
    kr: { symbol: 'SKHY', name: 'Südkorea', address: '0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8' },
  },
};
