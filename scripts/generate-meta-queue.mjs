import fs from 'node:fs';
import { parseCsv } from '../shared/csv.mjs';

// Read existing 20 rows
const existingContent = fs.readFileSync('examples/launch-queue.csv', 'utf8').trim();
const existingRows = existingContent.split(/\r?\n/).slice(1); // skip header

console.log(`Found ${existingRows.length} existing rows.`);

const assetList = [
  'assets/rhtoken1.jpg',
  'assets/bull1.jpg',
  'assets/bear1.jpg',
  'assets/lion1.jpg',
  'assets/wolf1.jpg',
  'assets/owl1.jpg',
  'assets/fox1.jpg',
  'assets/frog1.jpg',
  'assets/shark1.jpg',
  'assets/tiger1.jpg',
  'assets/panda1.jpg',
  'assets/parrot1.jpg',
  'assets/monkey1.jpg',
  'assets/rabbit1.jpg',
  'assets/hippo1.jpg',
  'assets/crocodile1.jpg',
  'assets/cat1.jpg',
  'assets/cat2.jpg',
  'assets/dog1.jpg',
  'assets/penguin1.jpg'
];

// 180 high-conviction meta tokens
const metaTokens = [
  // --- 0xBeans & Standard Reserve Protocol Lore (35) ---
  { name: "0xBeans Reserve", symbol: "BEANS", country: "eth", desc: "The code-governed central bank architected by 0xBeans. In Beans we trust." },
  { name: "Banker Charter", symbol: "CHARTER", country: "eth", desc: "Fractional reserve is obsolete. Decentralized charter to issue sovereign credit." },
  { name: "Uniswap Hook", symbol: "HOOK", country: "eth", desc: "Custom Uni v4 hook dynamically controlling emissions on net ETH inflows." },
  { name: "Standard Gold", symbol: "STND", country: "us", desc: "The immutable algorithmic gold standard backing the Robinhood economy." },
  { name: "Net Inflow", symbol: "FLOW", country: "eth", desc: "Pure monetary physics: supply expands on net capital inflows, burns on outflows." },
  { name: "The Branch", symbol: "BRANCH", country: "us", desc: "On-chain banking franchise licensed directly under the Standard Reserve umbrella." },
  { name: "Bonding Curve King", symbol: "CURVE", country: "us", desc: "Deterministic mathematical pricing model with zero rug potential." },
  { name: "Fractional Zero", symbol: "FZERO", country: "eth", desc: "No fractional reserves, no hidden bailouts, just verifiable code." },
  { name: "Algo Central Bank", symbol: "ACB", country: "eth", desc: "Replacing central bank boardrooms with 4000 lines of immutable Solidity." },
  { name: "Reserve Ratio", symbol: "RATIO", country: "eth", desc: "Optimal collateral backing maintained automatically by Uniswap v4 pool mechanics." },
  { name: "Liquidity Sink", symbol: "SINK", country: "eth", desc: "Absorbing all external ETH liquidity into permanent protocol-owned reserves." },
  { name: "Olympus Reborn", symbol: "THREE3", country: "eth", desc: "(3,3) redesigned with real yield, automated buybacks, and zero dilution." },
  { name: "Beans Multiplier", symbol: "BMULT", country: "eth", desc: "The compounding flywheel turning Robinhood Chain inflows into reserve value." },
  { name: "Sovereign Vault", symbol: "VAULT", country: "us", desc: "Permissionless treasury backed by multi-asset synthetic liquidity." },
  { name: "Charter Royalty", symbol: "ROYAL", country: "eth", desc: "Protocol fee yields streaming directly to verified charter holders." },
  { name: "DeFi Federal Reserve", symbol: "FED", country: "us", desc: "Jerome Powell stepped down; the smart contract took over the printing press." },
  { name: "Mint And Burn", symbol: "MNB", country: "eth", desc: "Automated contraction and expansion preserving purchasing power." },
  { name: "Robinhood Banker", symbol: "BANKER", country: "us", desc: "Elite liquidity providers staking charters to run sovereign liquidity nodes." },
  { name: "Standard Flywheel", symbol: "FLYWHEEL", country: "eth", desc: "More volume breeds deeper liquidity, which pulls more volume indefinitely." },
  { name: "Invariant X", symbol: "INVAR", country: "eth", desc: "The mathematical constant holding the bonding curve equilibrium together." },
  { name: "Zero Slippage", symbol: "NOSLIP", country: "us", desc: "Continuous liquidity curve guaranteeing execution at any market scale." },
  { name: "Exit Fee Burner", symbol: "EXBURN", country: "eth", desc: "Paper hands pay the protocol; all exit penalties fuel token buybacks." },
  { name: "Hard Peg", symbol: "HPEG", country: "us", desc: "Algorithmic backing defended strictly by programmed arbitrage bounds." },
  { name: "Solidity Powell", symbol: "POWELL", country: "us", desc: "Money printer goes brrr, but only when verified ETH hits the reserve." },
  { name: "TSR Apex", symbol: "APEX", country: "eth", desc: "The pinnacle token of the Standard Reserve algorithmic ecosystem." },
  { name: "Proof of Inflow", symbol: "POIN", country: "eth", desc: "Consensus mechanism based on verifiable capital entering the vault." },
  { name: "Hook Liquidity", symbol: "HVOL", country: "eth", desc: "Uni v4 execution hooks redirecting MEV directly back into token holders." },
  { name: "Autonomous Yield", symbol: "AYIELD", country: "eth", desc: "Yield generated purely through organic trading volume and rebalancing." },
  { name: "Treasury Max", symbol: "TMAX", country: "us", desc: "Maximizing protocol-owned capital over speculative temporary TVL." },
  { name: "Standard Bond", symbol: "BOND", country: "us", desc: "Discounted liquidity acquisition mechanism building eternal protocol runway." },
  { name: "0xArchitect", symbol: "ARCH", country: "eth", desc: "Honoring the visionary mechanism designers behind decentralized reserve banking." },
  { name: "Virtual Liquidity", symbol: "VLIQ", country: "eth", desc: "Synthetic deep reserves giving penny tokens billion-dollar orderbooks." },
  { name: "Sound Standard", symbol: "SOUND", country: "eth", desc: "The soundest money on Robinhood Chain, completely immune to inflation." },
  { name: "Branch Syndicate", symbol: "SYND", country: "us", desc: "Alliance of chartered bankers orchestrating coordinated liquidity injections." },
  { name: "Reserve Alpha", symbol: "RALPHA", country: "eth", desc: "The premier intelligence and liquidity vehicle on Standard Reserve." },

  // --- Robinhood & Vlad Tenev / WSB Lore (35) ---
  { name: "Boy From Bulgaria", symbol: "VLAD", country: "us", desc: "When I was a young boy in Bulgaria... the buy button was always turned on." },
  { name: "Buy Button On", symbol: "BUY", country: "us", desc: "Hardcoded into immutable EVM bytecode. This button can never be disabled." },
  { name: "Sherwood Forest", symbol: "WOOD", country: "us", desc: "Steal from the predatory market makers, distribute yield to the degens." },
  { name: "Margin Call", symbol: "MARGIN", country: "us", desc: "Max leverage, instant liquidation, eternal glory on Robinhood Chain." },
  { name: "Payment For Order Flow", symbol: "PFOF", country: "us", desc: "Turning high-frequency market microstructure into retail profit." },
  { name: "Diamond Hands", symbol: "DIAMOND", country: "us", desc: "Refusing to sell through 90% drawdowns until interstellar graduation." },
  { name: "Ape Army", symbol: "APES", country: "us", desc: "United retail degens overwhelming institutional sell walls with brute volume." },
  { name: "Robin Chad", symbol: "RCHAD", country: "us", desc: "The ultimate evolution of the commission-free day trader." },
  { name: "Sherwood Archer", symbol: "ARCHER", country: "us", desc: "Splitting arrows and hitting green candles with sniper precision." },
  { name: "Commission Free", symbol: "FREE", country: "us", desc: "Zero fees, pure velocity, frictionless liquidity on Robinhood Chain." },
  { name: "Tendies Reserve", symbol: "TENDIES", country: "us", desc: "Crispy fried profits harvested directly from Wall Street shorters." },
  { name: "Deep Value", symbol: "VALUE", country: "us", desc: "Roaring into the market with unstoppable asymmetric upside conviction." },
  { name: "Short Squeeze", symbol: "SQUEEZE", country: "us", desc: "Forcing bearish frontrunners into recursive liquidation spirals." },
  { name: "Green Candle Cult", symbol: "GMC", country: "us", desc: "Worshipping continuous god candles shooting past the stratosphere." },
  { name: "Wall Street Bets", symbol: "WSB", country: "us", desc: "The retail rebellion that started it all, now fully on-chain." },
  { name: "Gamma Squeeze", symbol: "GAMMA", country: "us", desc: "Market maker hedging dynamics triggering explosive upside momentum." },
  { name: "Halts Are Over", symbol: "NOHALT", country: "us", desc: "Decentralized trading never halts for regulatory press conferences." },
  { name: "Bulgarian Prince", symbol: "PRINCE", country: "us", desc: "Vlad's crypto alter-ego fueling sovereign L2 retail dominance." },
  { name: "Retail Revolution", symbol: "REVOLT", country: "us", desc: "Leveling the playing field against Citadel and dark-pool cartels." },
  { name: "Giga Chad Broker", symbol: "BROKER", country: "us", desc: "Instant order routing, zero counterparty risk, direct on-chain settlement." },
  { name: "Instant Deposit", symbol: "INSTANT", country: "us", desc: "No 3-day clearing delay; funds hit the curve at the speed of light." },
  { name: "Robinhood Whale", symbol: "RWHALE", country: "us", desc: "Gigantic accounts scooping up entire bonding curves in single transactions." },
  { name: "Midnight Degen", symbol: "NIGHT", country: "us", desc: "Trading Robinhood stock pairs while traditional exchanges sleep." },
  { name: "Limit Order Bull", symbol: "LIMIT", country: "us", desc: "Catching dips automatically before retail even wakes up." },
  { name: " Sherwood Gold", symbol: "SGLD", country: "us", desc: "The sacred currency of Robin Hood's merry band of blockchain traders." },
  { name: "Unlimited Margin", symbol: "INFMARG", country: "us", desc: "Tribute to the legendary infinite leverage glitch, immortalized in code." },
  { name: "Ticker Tape", symbol: "TAPE", country: "us", desc: "Live high-frequency tick data lighting up screens worldwide." },
  { name: "Robinhood Maxi", symbol: "RHMAXI", country: "us", desc: "Every portfolio asset bridged onto Robinhood Chain for maximum speed." },
  { name: "Market Open", symbol: "BELL", country: "us", desc: "Ringing the opening bell 24/7/365 with zero closing auctions." },
  { name: "YOLO Capital", symbol: "YOLO", country: "us", desc: "Total portfolio allocation into bonding curve graduation candidates." },
  { name: "Robin Quants", symbol: "QUANT", country: "us", desc: "Math prodigies optimizing sandwich protection on Robinhood Chain." },
  { name: "No PDT Rule", symbol: "NOPDT", country: "us", desc: "No 25k pattern day trader restrictions. Trade as many times as you want." },
  { name: "Robin Falcon", symbol: "FALCON", country: "us", desc: "Swift airborne predator diving into fresh launch pools." },
  { name: "The Big Green", symbol: "GREEN", country: "us", desc: "Neon green UI theme reflecting perpetual portfolio expansion." },
  { name: "Robinhood Pioneer", symbol: "PIONEER", country: "us", desc: "Day-one pioneer bridging Wall Street equities into DeFi curves." },

  // --- US Stock Pair: $SPCX (SpaceX / Space / Tech / Defense) (30) ---
  { name: "Starship Reserve", symbol: "STAR", country: "us", desc: "US Pair (SPCX): Interplanetary liquidity powering Mars orbital economy." },
  { name: "Falcon Heavy", symbol: "HEAVY", country: "us", desc: "US Pair (SPCX): Dual boosters landing back on pad after sending charts parabolic." },
  { name: "Mechazilla Catch", symbol: "CATCH", country: "us", desc: "US Pair (SPCX): Giant mechanical chopsticks catching falling knives with ease." },
  { name: "Raptor Engine", symbol: "RAPTOR", country: "us", desc: "US Pair (SPCX): Methane-fueled full-flow staged combustion driving token velocity." },
  { name: "Starlink Orbital", symbol: "LINKX", country: "us", desc: "US Pair (SPCX): Constellation of orbital nodes connecting every trader on Earth." },
  { name: "Mars Colonist", symbol: "MARS", country: "us", desc: "US Pair (SPCX): Official currency for future red planet propellant plants." },
  { name: "Escape Velocity", symbol: "ESCAPE", country: "us", desc: "US Pair (SPCX): Exceeding planetary gravity to enter eternal price discovery." },
  { name: "Super Heavy Booster", symbol: "BOOST", country: "us", desc: "US Pair (SPCX): 33 Raptor engines blasting through macro resistance levels." },
  { name: "Orbital Refuel", symbol: "REFUEL", country: "us", desc: "US Pair (SPCX): In-orbit propellant transfer for long-distance multi-cycle voyages." },
  { name: "Boca Chica Bull", symbol: "BOCA", country: "us", desc: "US Pair (SPCX): Starbase Texas launch site energy condensed into a meme." },
  { name: "Hyper Drive", symbol: "HYPER", country: "us", desc: "US Pair (SPCX): Warping through sell orders at faster-than-light speed." },
  { name: "Lunar Lander", symbol: "MOONX", country: "us", desc: "US Pair (SPCX): Artemis contract winner bringing liquidity to the Moon's south pole." },
  { name: "Interplanetary Degen", symbol: "IPDEGEN", country: "us", desc: "US Pair (SPCX): First multi-planet decentralized liquidity collective." },
  { name: "Heat Shield", symbol: "SHIELD", country: "us", desc: "US Pair (SPCX): Ceramic hexagonal tiles withstanding extreme re-entry volatility." },
  { name: "Space Foundry", symbol: "FOUNDRY", country: "us", desc: "US Pair (SPCX): Manufacturing zero-gravity crypto reserves in low Earth orbit." },
  { name: "Payload Fairing", symbol: "FAIRING", country: "us", desc: "US Pair (SPCX): Protecting precious token reserves during supersonic ascent." },
  { name: "Astro Degen", symbol: "ASTRO", country: "us", desc: "US Pair (SPCX): Spacesuit-wearing retail heroes exploring unexplored chart territory." },
  { name: "Gravity Assist", symbol: "SLING", country: "us", desc: "US Pair (SPCX): Slingshotting past planetary orbits to reach 100x market cap." },
  { name: "Deep Space Yield", symbol: "DSY", country: "us", desc: "US Pair (SPCX): Harvesting cosmic rays and streaming yield to bonded stakers." },
  { name: "Space Propulsion", symbol: "PROPEL", country: "us", desc: "US Pair (SPCX): Ion thrusters keeping the chart in perpetual upward trajectory." },
  { name: "Cosmic Rocket", symbol: "COSMIC", country: "us", desc: "US Pair (SPCX): Leaving Earth's atmosphere to colonize the top DEX rankings." },
  { name: "Telemetry Bull", symbol: "TELEM", country: "us", desc: "US Pair (SPCX): High-rate sensor telemetry confirming all green systems." },
  { name: "Pad 39A", symbol: "PAD39", country: "us", desc: "US Pair (SPCX): Historic launchpad legacy upgraded for the decentralized era." },
  { name: "Titanium Grid Fin", symbol: "FINS", country: "us", desc: "US Pair (SPCX): Aerodynamic steering surfaces guiding perfect bonding landings." },
  { name: "Starship Flight 7", symbol: "FLIGHT7", country: "us", desc: "US Pair (SPCX): Commemorating revolutionary aerospace milestones on-chain." },
  { name: "Autonomous Drone Ship", symbol: "OCISLY", country: "us", desc: "US Pair (SPCX): 'Of Course I Still Love You' receiving massive liquidity injections." },
  { name: "Mars Terraform", symbol: "TERRA", country: "us", desc: "US Pair (SPCX): Heating the poles and generating green atmosphere on-chain." },
  { name: "Raptor Vacuum", symbol: "RVAC", country: "us", desc: "US Pair (SPCX): Massive expansion nozzle engineered for peak space vacuum efficiency." },
  { name: "Orbital Mechanics", symbol: "ORBIT", country: "us", desc: "US Pair (SPCX): Keplerian orbital laws applied to token supply and velocity." },
  { name: "Zero Gravity Bull", symbol: "ZEROG", country: "us", desc: "US Pair (SPCX): Floating freely in outer space without downward gravitational pull." },

  // --- China Stock Pair: $BABA (Alibaba / Eastern Liquidity / Dragon) (30) ---
  { name: "Jack Ma Revenge", symbol: "JACK", country: "cn", desc: "CN Pair (BABA): Jack Ma returns to build unstoppable algorithmic finance." },
  { name: "Golden Dragon", symbol: "LONG", country: "cn", desc: "CN Pair (BABA): Awaking the imperial dragon to unleash massive eastern liquidity." },
  { name: "Eastern Stimulus", symbol: "STIM", country: "cn", desc: "CN Pair (BABA): Trillions in digital stimulus flooding the Alibaba pairing curve." },
  { name: "Taobao Degen", symbol: "TAOBAO", country: "cn", desc: "CN Pair (BABA): 1-click shopping experience translated into instant token buys." },
  { name: "Hang Seng Bull", symbol: "HSI", country: "cn", desc: "CN Pair (BABA): Hong Kong financial district capital surging into Robinhood Chain." },
  { name: "Alibaba Cloud AI", symbol: "QWEN", country: "cn", desc: "CN Pair (BABA): Powered by China's largest LLM compute clusters." },
  { name: "Red Envelope", symbol: "HONGBAO", country: "cn", desc: "CN Pair (BABA): Distributing prosperous lunar new year blessings to curve holders." },
  { name: "Silk Road Liquidity", symbol: "SILK", country: "cn", desc: "CN Pair (BABA): Ancient trading routes revived as high-throughput crypto highways." },
  { name: "Shanghai Whale", symbol: "SHANGHAI", country: "cn", desc: "CN Pair (BABA): Deep pocketed Eastern hedge funds bidding every micro-dip." },
  { name: "Shenzhen Silicon", symbol: "SHENZHEN", country: "cn", desc: "CN Pair (BABA): Hardware capital of the world manufacturing next-gen mining tech." },
  { name: "Singles Day Bull", symbol: "DOUBLE11", country: "cn", desc: "CN Pair (BABA): 11.11 shopping festival breaking all historical on-chain volume records." },
  { name: "Yangtze River Flow", symbol: "YANGTZE", country: "cn", desc: "CN Pair (BABA): Unstoppable torrent of capital flowing into decentralized pools." },
  { name: "Forbidden City", symbol: "PALACE", country: "cn", desc: "CN Pair (BABA): Imperial dynasty grade wealth storage on Robinhood Chain." },
  { name: "Ant Financial Spirit", symbol: "ANT", country: "cn", desc: "CN Pair (BABA): The fintech titan that was too big to IPO, resurrected in Web3." },
  { name: "Panda Quantum", symbol: "QPANDA", country: "cn", desc: "CN Pair (BABA): Peaceful Zen exterior concealing ruthless trading algorithms." },
  { name: "Great Wall Defense", symbol: "WALL", country: "cn", desc: "CN Pair (BABA): Impenetrable buy wall shielding token price from foreign dumps." },
  { name: "Guangzhou Trader", symbol: "CANTON", country: "cn", desc: "CN Pair (BABA): Veteran maritime merchant spirit dominating modern AMM curves." },
  { name: "BABA Flywheel", symbol: "BABAF", country: "cn", desc: "CN Pair (BABA): Cloud revenue meets algorithmic buybacks in an infinite loop." },
  { name: "Lucky Eight", symbol: "BA888", country: "cn", desc: "CN Pair (BABA): The ultimate auspicious prosperity number guiding green candles." },
  { name: "Eastern Phoenix", symbol: "FENIX", country: "cn", desc: "CN Pair (BABA): Rising from regulatory scrutiny stronger and more decentralized." },
  { name: "Peking Duck Bull", symbol: "DUCK", country: "cn", desc: "CN Pair (BABA): Crispy, golden, and satisfying every hungry degen in Asia." },
  { name: "Dim Sum Capital", symbol: "DIMSUM", country: "cn", desc: "CN Pair (BABA): Steaming hot baskets of fresh alpha served 24 hours a day." },
  { name: "Zhijiang Tech", symbol: "ZHEJIANG", country: "cn", desc: "CN Pair (BABA): Hangzhou tech hub engineers shipping flawless smart contracts." },
  { name: "Golden Koi", symbol: "KOI", country: "cn", desc: "CN Pair (BABA): Legendary carp leaping over the dragon gate to reach graduation." },
  { name: "BABA Sovereign", symbol: "SOVBABA", country: "cn", desc: "CN Pair (BABA): Sovereign-grade liquidity anchor for cross-border e-commerce." },
  { name: "Wulong Tea Master", symbol: "WULONG", country: "cn", desc: "CN Pair (BABA): Patience and disciplined tea ceremony applied to chart accumulation." },
  { name: "Cyber Terracotta", symbol: "TERRACOT", country: "cn", desc: "CN Pair (BABA): Undying digital army guarding the bonding curve treasury." },
  { name: "China AI Supercluster", symbol: "CHAIC", country: "cn", desc: "CN Pair (BABA): Massive distributed inference powering next-gen Asian trading bots." },
  { name: "Alipay Phoenix", symbol: "ALIPAY", country: "cn", desc: "CN Pair (BABA): Digital payment pioneer mindset transformed into trustless AMM swaps." },
  { name: "Red Dragon Surge", symbol: "SURGE", country: "cn", desc: "CN Pair (BABA): Sudden massive volume spikes sending the bonding curve vertical." },

  // --- Korea Stock Pair: $SKHY (SK Hynix / Semiconductor AI / Seoul) (30) ---
  { name: "Kimchi Premium", symbol: "KIMCHI", country: "kr", desc: "KR Pair (SKHY): The legendary Seoul price premium fueled by retail mania." },
  { name: "HBM Silicon", symbol: "HBM", country: "kr", desc: "KR Pair (SKHY): High Bandwidth Memory supplying the entire global AI supercycle." },
  { name: "Gangnam Whale", symbol: "GANGNAM", country: "kr", desc: "KR Pair (SKHY): Wealthy Seoul crypto aristocrats sweeping the order books." },
  { name: "SK Hynix Ultra", symbol: "HYNIX", country: "kr", desc: "KR Pair (SKHY): World leader in memory chips powering GPU accelerator clusters." },
  { name: "Seoul Night Trader", symbol: "SEOUL", country: "kr", desc: "KR Pair (SKHY): High-caffeine PC Bang degens trading all night on Robinhood." },
  { name: "Wafer Fab 1", symbol: "FAB1", country: "kr", desc: "KR Pair (SKHY): Cleanroom semiconductor fabrication yielding pure cryptographic gold." },
  { name: "Nvidia Supplier", symbol: "SUPPLY", country: "kr", desc: "KR Pair (SKHY): Without Hynix memory, Jensen Huang cannot ship AI GPUs." },
  { name: "DRAM Supercycle", symbol: "DRAM", country: "kr", desc: "KR Pair (SKHY): Generational supply shortage driving memory valuations sky high." },
  { name: "Cyber K-Pop Bull", symbol: "KPOP", country: "kr", desc: "KR Pair (SKHY): Infectious rhythm and global fanbase driving unstoppable hype." },
  { name: "Icheon Foundry", symbol: "ICHEON", country: "kr", desc: "KR Pair (SKHY): Mega-fab cluster producing the chips that run the global cloud." },
  { name: "Soju Moonshot", symbol: "SOJU", country: "kr", desc: "KR Pair (SKHY): Green bottle celebrations after breaking all-time highs." },
  { name: "PC Bang Degen", symbol: "PCBANG", country: "kr", desc: "KR Pair (SKHY): 240Hz monitors, zero input lag, sniping bonding curves before anyone else." },
  { name: "EUV Lithography", symbol: "EUV", country: "kr", desc: "KR Pair (SKHY): Extreme ultraviolet light etching nanoscale financial contracts." },
  { name: "Chimaek Profits", symbol: "CHIMAEK", country: "kr", desc: "KR Pair (SKHY): Crispy Korean fried chicken and ice-cold beer paid with curve gains." },
  { name: "Hynix Titan", symbol: "TITAN", country: "kr", desc: "KR Pair (SKHY): The semiconductor colossus carrying the memory market on its back." },
  { name: "Han River Bull", symbol: "HANRIVER", country: "kr", desc: "KR Pair (SKHY): The Miracle on the Han River reborn in decentralized liquidity." },
  { name: "High Bandwidth Bull", symbol: "BWAVE", country: "kr", desc: "KR Pair (SKHY): Terabytes per second bandwidth feeding hungry AI neural networks." },
  { name: "Busan Port Liquidity", symbol: "BUSAN", country: "kr", desc: "KR Pair (SKHY): Massive container vessels shipping silicon and tokens across the globe." },
  { name: "K-Silicon Valley", symbol: "PANGYO", country: "kr", desc: "KR Pair (SKHY): Pangyo Techno Valley engineers building next-gen crypto infrastructure." },
  { name: "Stacking Dies", symbol: "3DSTACK", country: "kr", desc: "KR Pair (SKHY): 12-layer HBM3E packaging mirroring layered staking yield." },
  { name: "Seoul Cyber Tiger", symbol: "KTIGER", country: "kr", desc: "KR Pair (SKHY): Ferocious Asian tiger hunting down frontrunners and MEV extractors." },
  { name: "Semiconductor Sovereign", symbol: "SEMI", country: "kr", desc: "KR Pair (SKHY): Silicon is the new oil, and Hynix is the supreme refinery." },
  { name: "Kimchi Pump", symbol: "KPUMP", country: "kr", desc: "KR Pair (SKHY): Instant 30% gap up when Korean retail catches the narrative." },
  { name: "Silicon Shield", symbol: "CHIP", country: "kr", desc: "KR Pair (SKHY): Hardware security and chip sovereignty backing digital assets." },
  { name: "Gangwon Snow Bull", symbol: "GANGWON", country: "kr", desc: "KR Pair (SKHY): Cold as ice under market stress, unyielding in commitment." },
  { name: "Next Gen Memory", symbol: "NXM", country: "kr", desc: "KR Pair (SKHY): Non-volatile algorithmic memory caching all curve transactions." },
  { name: "Taekwondo Bull", symbol: "TKD", country: "kr", desc: "KR Pair (SKHY): High-impact spinning kicks knocking bears out of the order book." },
  { name: "AI Accelerator Gold", symbol: "ACCEL", country: "kr", desc: "KR Pair (SKHY): The indispensable memory engine powering planetary intelligence." },
  { name: "Silicon Miracle", symbol: "MIRACLE", country: "kr", desc: "KR Pair (SKHY): Transforming common sand into billions in high-tech value." },
  { name: "K-Degen Alliance", symbol: "KDEGEN", country: "kr", desc: "KR Pair (SKHY): Elite Korean crypto community driving explosive viral volume." },

  // --- AI Agents & Autonomous Quantitative Meta (20) ---
  { name: "Reserve Agent 0x", symbol: "AGENT", country: "eth", desc: "Autonomous AI banker executing real-time liquidity rebalancing on-chain." },
  { name: "Deep Liquidity AI", symbol: "DEEP", country: "eth", desc: "Neural network quant model predicting net capital inflows before block inclusion." },
  { name: "Autonomous Market Maker", symbol: "AMM0", country: "eth", desc: "Self-optimizing algorithmic market maker adjusting spreads to market regime." },
  { name: "Singularity Reserve", symbol: "SINGUL", country: "eth", desc: "The reserve currency for artificial superintelligence operating on Robinhood." },
  { name: "Quant Oracle", symbol: "ORACLE", country: "eth", desc: "Machine intelligence feeding cryptographic proofs to the bonding curve." },
  { name: "Terminal Velocity AI", symbol: "TERM", country: "eth", desc: "High-frequency reinforcement learning bot defending token price floors." },
  { name: "Neural Banker", symbol: "NEURAL", country: "eth", desc: "Synaptic weights calibrated to maximize protocol-owned liquidity yield." },
  { name: "Autonomous Hedger", symbol: "HEDGE", country: "us", desc: "Cross-asset synthetic hedge agent protecting against downside tail risk." },
  { name: "Prompt Engineer", symbol: "PROMPT", country: "us", desc: "Transforming natural language intent into complex multi-call DeFi strategies." },
  { name: "Code Is Law AI", symbol: "LAWAI", country: "eth", desc: "Zero emotion, zero human error, purely objective algorithmic execution." },
  { name: "Cyber Arbitrage", symbol: "CYBARB", country: "eth", desc: "Lightning fast sub-second arbitrage keeping curves locked to external fair value." },
  { name: "AI Swarm Reserve", symbol: "SWARM", country: "eth", desc: "Decentralized swarm intelligence coordinating liquidity provision." },
  { name: "Matrix Vault", symbol: "MATRIX", country: "eth", desc: "Multidimensional mathematical vault structure securing user capital." },
  { name: "Algo Brain", symbol: "BRAIN", country: "us", desc: "Continuous learning loop adapting curve parameters to market volatility." },
  { name: "Flash Reserve AI", symbol: "FLASH", country: "eth", desc: "Sub-millisecond liquidity provision reacting to incoming block builder bundles." },
  { name: "Quantum Order Flow", symbol: "QFLOW", country: "us", desc: "Predictive microstructure routing optimizing Robinhood order execution." },
  { name: "Synthetic Asset AI", symbol: "SYNTH", country: "us", desc: "AI engine generating real-time collateral proofs for synthetic equities." },
  { name: "Autonomous Treasury", symbol: "AUTOTRE", country: "eth", desc: "Fully automated decentralized balance sheet management governed by code." },
  { name: "Agentic Alpha", symbol: "AALPHA", country: "eth", desc: "Autonomous scout agents surfacing high-momentum bonding curves." },
  { name: "Zero Knowledge Quant", symbol: "ZKQUANT", country: "eth", desc: "Private quantitative execution proving trade validity without leaking alpha." }
];

console.log(`Generated ${metaTokens.length} meta tokens.`);

// Build new rows
const newRows = metaTokens.map((t, idx) => {
  const asset = assetList[idx % assetList.length];
  // Vary monitor sell mode between n_minus_1 and all
  const sellMode = idx % 3 === 0 ? 'all' : 'n_minus_1';
  // Vary charter drop slightly (mostly 10%, some 5% or 0%)
  const drop = idx % 7 === 0 ? 'off' : '10%';
  return `${t.name},${t.symbol},${t.country},"${t.desc}",${asset},only in its own pool,${drop},at exit,off,off,true,"marketCapUsd>=150000;gain>=50;drawdown>=30",true,${sellMode}`;
});

const allRows = [...existingRows, ...newRows];
console.log(`Total rows to save: ${allRows.length}`);

const header = "name,symbol,country,description,image_path,after_graduates,charter_drop,charter_payout,dev_buy,snipe_tax,monitor_enabled,monitor_rules,monitor_auto_sell,monitor_sell_mode";
const finalCsv = [header, ...allRows].join('\n');

fs.writeFileSync('examples/launch-queue.csv', finalCsv, 'utf8');

// Validate with parseCsv
const parsed = parseCsv(finalCsv);
console.log(`Validation SUCCESS! Parsed ${parsed.length} items without error.`);
