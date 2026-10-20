# Standard Launch Console & Auto-Launchpad Bot

Lokale, hochoptimierte Launch-Konsole und automatisierter Bonding-Curve-Runner für **Standard Reserve** auf der **Robinhood Chain** (Chain ID: `4663`).

Enthält einen verschlüsselten AES-256-GCM-Tresor, automatisierte Multi-Wallet-Snipes, Take-Profit/Stop-Loss-Monitoring mit Auto-Exit, exakte Creator-Fee-Verwaltung nach Handelspaar (ETH, SPCX, BABA, SKHY) und ein Echtzeit-PnL-Dashboard mit live bewerteten Season-1-Pilotenpunkten.

---

## ⚡ Schnellstart unter Windows

### 1-Klick Start (Empfohlen)
* **Starten:** Doppelklick auf [`start-bot.bat`](file:///e:/AI%20Projekte/Standard-Launchpad-Bot/start-bot.bat)
  * Prüft die Node.js-Umgebung
  * Kompiliert bei Bedarf das Web-Frontend
  * Startet den lokalen Server auf `http://127.0.0.1:4317`
  * Öffnet automatisch deinen Standardbrowser
* **Stoppen:** Doppelklick auf [`stop-bot.bat`](file:///e:/AI%20Projekte/Standard-Launchpad-Bot/stop-bot.bat) (beendet alle Hintergrundprozesse auf Port 4317 sauber)

### Manueller Start über Terminal
Voraussetzung: [Node.js](https://nodejs.org/) v20 oder neuer.

```bash
npm install
npm run build
npm start
```
Konsole öffnen unter: **`http://127.0.0.1:4317`**

---

## 🌟 Kernfunktionen im Überblick

### 1. 🔒 Verschlüsselter Wallet-Tresor (Vault)
* **Sicherheit at Rest:** Private Keys werden mit **AES-256-GCM** und `scrypt`-Schlüsselableitung verschlüsselt in der lokalen SQLite-Datenbank (`data/console.sqlite`) gespeichert. Private Keys liegen **niemals im Klartext** auf der Festplatte.
* **Flüchtige Entschlüsselung:** Entschlüsselung erfolgt nur temporär im RAM. Nach 15 Minuten Inaktivität sperrt sich der Tresor automatisch (Auto-Lock).
* **Multi-Wallet-Verwaltung:** Beliebig viele Wallets generieren oder importieren.
* **Guthaben-Tracking:** Zeigt für jede Wallet sowohl das native **ETH**-Guthaben als auch das **SPCX**-Guthaben (sowie weitere Stock-Token) in Echtzeit an.

### 2. 📋 Entwurfs-Queue & Automatische Dateisynchronisation
* **Lokale Arbeits-Queue (`data/launch-queue.csv`):**
  * Hier liegt deine aktive Launch-Reihe (bis zu 200 Tokens).
  * Durch `.gitignore` geschützt – deine Token-Daten, Beschreibungen und Adressen werden **niemals auf GitHub übertragen**.
  * **Automatisches Entfernen:** Sobald ein Token gelauncht oder aus der Queue gelöscht wird, wird die Zeile sofort und sauber direkt aus `data/launch-queue.csv` auf der Festplatte entfernt.
  * **Hot-Reload:** Änderungen an der Datei werden im laufenden Betrieb erkannt und sofort in den Bot übernommen.
* **Vorlage für GitHub (`examples/launch-queue.csv`):**
  * Enthält neutrale Dummy-Beispieldaten für GitHub und kann über den Button *„CSV-Vorlage herunterladen ↓“* in der UI als Template bezogen werden.

### 3. 🎯 Multi-Währungs-Unterstützung (ETH, SPCX, BABA, SKHY)
Der Bot unterstützt alle Handelspaare von Standard Reserve nativ:
* 🇺🇸 **USA (`us`):** `$SPCX` (`0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa`)
* ⚡ **Ethereum (`eth`):** `$WETH` / Native ETH (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`)
* 🇨🇳 **China (`cn`):** `$BABA` (`0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4`)
* 🇰🇷 **Südkorea (`kr`):** `$SKHY` (`0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8`)

### 4. 🚀 Automatischer Erstkauf (Snipe)
* Bis zu 10 Tresor-Wallets können beim Launch parallel als Erstkäufer einsteigen.
* **Währungsgerechte Beträge:** Für jedes Handelspaar (ETH, SPCX, BABA, SKHY) können eigene Beträge konfiguriert werden (z. B. 0.0042 ETH bzw. 0.05 SPCX).
* **Automatisches Approval:** Benötigte ERC-20-Freigaben für den Standard Reserve Router werden vollautomatisch vor dem Kauf erteilt.
* **Anti-Frontrun-Schutz:** Prüft vor der Transaktion, ob bereits Fremdkäufe im selben Block stattfanden, und schützt vor Slippage.

### 5. 📈 Auto-Monitor & TP/SL Auto-Exit
* Unmittelbar nach dem Launch wird ein Live-Monitor für die Bonding-Curve erstellt.
* **Regeln:** Take-Profit (z. B. Market Cap $\ge$ \$5.000 oder Kursgewinn $\ge$ 50%), Stop-Loss (z. B. Drawdown $\ge$ 30%).
* **Auto-Sell / Exit:**
  * **Modus `all`:** Verkauft alle gesnipten Token auf der Bonding-Curve bei Trigger-Erreichung.
  * **Modus `n_minus_1` (Moonbag):** Behält die Wallet mit dem günstigsten Einstiegskurs als Moonbag und verkauft die restlichen.
  * **Manueller Exit:** Mit dem Button *„⚡ Manuell verkaufen (Exit)“* kann jederzeit ein Sofort-Ausstieg für alle Wallets ausgelöst werden.
* **Exakte Erlöserfassung:** Liest den tatsächlichen Rückfluss in ETH oder SPCX direkt aus den On-Chain-Receipts aus.

### 6. 📊 Dashboard, PnL & Punkte-Auswertung
* **Live-Punkte von Standard Reserve:** Bezieht die offiziellen Season-1-Punkte direkt von der Standard Reserve API (5,07 Punkte pro gehandeltem Dollar + Deployer-Anteile).
* **Dynamische Punktwert-Szenarien:**
  * 🛡️ **Garantiert (65% Incentives):** ~\$0,01703 / Punkt (Ausschüttung an alle Teilnehmer)
  * ⚖️ **100% Ø Pool:** ~\$0,02619 / Punkt (Gesamter Reward-Pool gemittelt)
  * 🏆 **Sieger-Team US:** ~\$0,03290 / Punkt (Jackpot-Bonus für das führende US-Team)
  * ✍️ **Manuell:** Beliebiger Schätzwert pro Punkt
* **Vollständiges PnL:** Verrechnet Launch-Gebühr, Snipe-Einsatz, Verkaufserlös, Creator-Gebühren und den Dollar-Gegenwert der gesammelten Pilotenpunkte zu einem **effektiven Netto-PnL**.
* **Saubere Creator-Fees:** Weist unbeanspruchte Gebühren exakt nach Währung aus (z. B. `0.0098 SPCX + 0.000346 ETH`).

---

## 🛠️ CSV-Spaltenreferenz

Format für [`data/launch-queue.csv`](file:///e:/AI%20Projekte/Standard-Launchpad-Bot/data/launch-queue.csv):

| Spalte | Pflicht | Beschreibung / Beispiel |
| --- | :---: | --- |
| `name` | Ja | Tokenname (z. B. `Robin Token`) |
| `symbol` | Ja | Ticker (z. B. `RHT`) |
| `country` | Ja | `us` (SPCX), `eth` (WETH), `cn` (BABA) oder `kr` (SKHY) |
| `description` | Nein | Beschreibungstext für Metadaten |
| `image_path` | Nein | Bilddatei im Ordner `assets/` (z. B. `assets/rhtoken1.jpg`) |
| `after_graduates` | Nein | Standard: `only in its own pool` |
| `charter_drop` | Nein | Standard: `10%` |
| `charter_payout` | Nein | Standard: `at exit` |
| `dev_buy` | Nein | Standard: `off` |
| `snipe_tax` | Nein | Standard: `off` |
| `monitor_enabled`| Nein | `true` (Standard) oder `false` |
| `monitor_rules` | Nein | z. B. `marketCapUsd>=5000;gain>=50;drawdown>=30` |
| `monitor_auto_sell` | Nein | `true` (Standard) oder `false` |
| `monitor_sell_mode` | Nein | `all` oder `n_minus_1` |
| `referrer` | Nein | Standard Reserve Referrer-Adresse |

---

## 🧪 Tests ausführen

Das Projekt verfügt über eine vollständige automatisierte Test-Suite (47 Unit- & Integrationstests) inklusive Mock-RPCs, Isolierung und Validierung:

```bash
npm test
```

Alle Tests laufen isoliert in temporären Verzeichnissen ab und verändern weder die echte SQLite-Datenbank noch deine Arbeits-Queue.

---

## 🔗 Blockchain- & Contract-Parameter

* **Netzwerk:** Robinhood Chain (`mainnet`)
* **Chain ID:** `4663`
* **RPC URL:** `https://rpc.mainnet.chain.robinhood.com`
* **Standard Factory:** `0x3D6Ea4e97B8AB9E1A1B4943fEBfFe22D8c920091`
* **Router:** `0x190B452D16e12e3bEeDd76a030EA991fE3856c33`
* **Explorer:** [Robinhood Chain Explorer](https://robin.etherscan.io)
