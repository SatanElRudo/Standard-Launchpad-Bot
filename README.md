# Standard Launch Console & Auto-Launchpad Bot

Hochoptimierte lokale Launch-Konsole und automatisierter Bonding-Curve-Runner für **Standard Reserve** auf der **Robinhood Chain** (Chain ID: `4663`).

Enthält einen verschlüsselten AES-256-GCM-Tresor, parallele Multi-Wallet-Snipes mit Priority-Gas-Frontrun-Schutz, Take-Profit/Stop-Loss-Monitoring mit Auto-Exit, exakte Creator-Fee-Verwaltung nach Handelspaar (ETH, SPCX, BABA, SKHY) und ein Echtzeit-PnL-Dashboard mit live bewerteten Season-1-Pilotenpunkten.

---

## 📋 Systemvoraussetzungen (Prerequisites)

Bevor du den Bot startest, stelle sicher, dass folgende Software auf deinem Computer installiert ist:

| Voraussetzung | Mindestversion | Zweck | Download-Link |
| :--- | :---: | :--- | :--- |
| **Node.js** | **v20.0.0+** (LTS empfohlen) | JavaScript-Runtime für Server & Bot-Logik | [nodejs.org](https://nodejs.org/) |
| **Git** | Aktuell | Quellcode klonen und Updates beziehen | [git-scm.com](https://git-scm.com/) |
| **Webbrowser** | Aktuell | Benutzeroberfläche (Chrome, Brave, Edge, Firefox) | – |
| **Robinhood Chain Wallet** | – | Für Gas und Launch-Gebühren (0.0005 ETH pro Token) | z. B. MetaMask / Rabby |

> [!IMPORTANT]
> **Windows-Installation von Node.js:** Achte bei der Installation von Node.js darauf, dass die Option **„Add to PATH“** aktiviert ist. Starte dein Terminal oder die Eingabeaufforderung nach der Installation einmal neu, damit der Befehl `node` im System erkannt wird.

---

## ⚡ Schnellstart

### Methode 1: 1-Klick Start unter Windows (Empfohlen)

1. Repository klonen oder als ZIP herunterladen und entpacken:
   ```bash
   git clone https://github.com/SatanElRudo/Standard-Launchpad-Bot.git
   cd Standard-Launchpad-Bot
   ```
2. **Starten:** Doppelklick auf [`start-bot.bat`](start-bot.bat)
   * Prüft automatisch deine Node.js-Installation.
   * Installiert beim ersten Start automatisch alle Abhängigkeiten (`npm install`).
   * Baut das Web-Frontend (`npm run build`).
   * Startet den Server und öffnet automatisch die Web-Konsole im Browser unter: **`http://127.0.0.1:4317`**
3. **Stoppen:** Doppelklick auf [`stop-bot.bat`](stop-bot.bat)
   * Beendet alle im Hintergrund laufenden Bot-Prozesse auf Port 4317 sauber und gibt den Port frei.

---

### Methode 2: Manueller Start über das Terminal (Windows / macOS / Linux)

```bash
# 1. Repository klonen
git clone https://github.com/SatanElRudo/Standard-Launchpad-Bot.git
cd Standard-Launchpad-Bot

# 2. Abhängigkeiten installieren
npm install

# 3. Web-Frontend bauen
npm run build

# 4. Server starten
npm start
```

Anschließend im Browser aufrufen: **`http://127.0.0.1:4317`**

---

## 🌟 Kernfunktionen im Detail

### 1. 🔒 Verschlüsselter Wallet-Tresor (Vault)
* **Sicherheit at Rest:** Private Keys werden mit **AES-256-GCM** und `scrypt`-Schlüsselableitung verschlüsselt in der lokalen SQLite-Datenbank (`data/console.sqlite`) gespeichert. Private Keys liegen **niemals im Klartext** auf der Festplatte.
* **Flüchtige Entschlüsselung:** Die Entschlüsselung erfolgt nur temporär im Arbeitsspeicher (RAM). Nach 15 Minuten Inaktivität sperrt sich der Tresor automatisch (Auto-Lock).
* **Multi-Wallet-Verwaltung:** Beliebig viele Wallets generieren oder bestehende Hex-Private-Keys sicher importieren.
* **Guthaben-Tracking:** Zeigt für jede Wallet sowohl das native **ETH**-Guthaben als auch das **SPCX**-Guthaben (sowie weitere Stock-Token) in Echtzeit an.

### 2. ⚡ Priority Gas & Frontrun-Schutz
* **Konfigurierbare Snipe-Geschwindigkeit:** Einstellbar direkt im Auto-Launcher und im manuellen Launch-Formular:
  * `Schnell (0.05 Gwei)` – Solide Grundgeschwindigkeit.
  * `Turbo / Anti-Frontrun (0.075 Gwei - Empfohlen)` – Überholt Standard-Bots (~0.06 Gwei) bei der Block-Priorisierung.
  * `Ultra Speed (0.15 Gwei)` – Maximale Priorität für heiß umkämpfte Launches.
  * `Benutzerdefiniert…` – Beliebiger Gwei-Wert nach Wunsch.
* **Latenz-Optimierung:** 
  * Keine unnötigen RPC-Simulationen mehr im zeitkritischen Pfad.
  * Exakte `minTokensOut`-Berechnung anhand der Bonding-Curve-Mathematik.
  * Parallele Gas- und Kontostandsabfragen.
  * Snipe-Transaktionen werden sofort nach Erhalt des Receipts abgeschickt, noch bevor Datei-I/O oder Alerts verarbeitet werden.

### 3. 📋 Entwurfs-Queue & Automatische Dateisynchronisation
* **Lokale Arbeits-Queue (`data/launch-queue.csv`):**
  * Hier liegt deine aktive Launch-Reihe (bis zu 200 Tokens).
  * Durch `.gitignore` geschützt – deine Token-Namen, Beschreibungen und Adressen werden **niemals auf GitHub übertragen**.
  * **Automatisches Entfernen:** Sobald ein Token erfolgreich gelauncht wird, wird die Zeile sofort und sauber direkt aus `data/launch-queue.csv` auf der Festplatte entfernt.
  * **Hot-Reload:** Änderungen an der Datei werden im laufenden Betrieb erkannt und sofort in den Bot übernommen.
* **Vorlage für GitHub (`examples/launch-queue.csv`):**
  * Enthält neutrale Dummy-Beispieldaten für GitHub und kann über den Button *„CSV-Vorlage herunterladen ↓“* in der UI als Template bezogen werden.

### 4. 🎯 Multi-Währungs-Unterstützung (ETH, SPCX, BABA, SKHY)
Der Bot unterstützt alle Handelspaare von Standard Reserve nativ:
* 🇺🇸 **USA (`us`):** `$SPCX` (`0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa`)
* ⚡ **Ethereum (`eth`):** `$WETH` / Native ETH (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`)
* 🇨🇳 **China (`cn`):** `$BABA` (`0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4`)
* 🇰🇷 **Südkorea (`kr`):** `$SKHY` (`0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8`)

### 5. 🚀 Paralleler Erstkauf (Snipe)
* Bis zu 10 Tresor-Wallets können beim Launch parallel als Erstkäufer einsteigen.
* **Währungsgerechte Beträge:** Für jedes Handelspaar (ETH, SPCX, BABA, SKHY) können eigene Beträge hinterlegt werden (z. B. 0.0042 ETH bzw. 0.05 SPCX).
* **Automatisches Approval:** Benötigte ERC-20-Freigaben für den Standard Reserve Router werden vollautomatisch vor dem Kauf erteilt.

### 6. 📈 Auto-Monitor & TP/SL Auto-Exit
* Unmittelbar nach dem Launch wird ein Live-Monitor für die Bonding-Curve erstellt.
* **Regeln:** Take-Profit (z. B. Market Cap $\ge$ \$5.000 oder Kursgewinn $\ge$ 50%), Stop-Loss (z. B. Drawdown $\ge$ 30%).
* **Auto-Sell / Exit:**
  * **Modus `all`:** Verkauft alle gesnipten Token auf der Bonding-Curve bei Trigger-Erreichung.
  * **Modus `n_minus_1` (Moonbag):** Behält die Wallet mit dem günstigsten Einstiegskurs als Moonbag und stößt die restlichen ab.
  * **Manueller Exit:** Mit dem Button *„⚡ Manuell verkaufen (Exit)“* kann jederzeit ein Sofort-Ausstieg für alle Wallets ausgelöst werden.
* **Exakte Erlöserfassung:** Liest den tatsächlichen Rückfluss in ETH oder SPCX direkt aus den On-Chain-Receipts aus.

### 7. 🎁 Referral / Punkte-Belohnungen
* **Eigene Ref-Adresse hinterlegen:** Trage im Tab **„Entwurfs-Queue“** unter **„🎯 Referral / Punkte-Adresse (Ref)“** einfach deine persönliche Wallet-Adresse ein (oder pro Zeile in der CSV-Datei).
* Der Bot gibt diese Adresse automatisch in allen Transaktionen on-chain mit:
  1. Token Launch (`params.referrer`)
  2. Snipe Kauf (`router.buyExactIn` Parameter 6)
  3. Exit Verkauf (`router.sellExactIn` Parameter 5)
* Dadurch werden alle Referral-Punkte für die Season-1-Ausschüttung automatisch auf deiner Wunsch-Wallet gesammelt. Bleibt das Feld leer, wird die Null-Adresse verwendet.

### 8. 📊 Dashboard, PnL & Punkte-Auswertung
* **Live-Punkte von Standard Reserve:** Bezieht die offiziellen Season-1-Punkte direkt von der Standard Reserve API (5,07 Punkte pro gehandeltem Dollar + Deployer-Anteile).
* **Dynamische Punktwert-Szenarien:**
  * 🛡️ **Garantiert (65% Incentives):** ~\$0,01703 / Punkt (Ausschüttung an alle Teilnehmer)
  * ⚖️ **100% Ø Pool:** ~\$0,02619 / Punkt (Gesamter Reward-Pool gemittelt)
  * 🏆 **Sieger-Team US:** ~\$0,03290 / Punkt (Jackpot-Bonus für das führende US-Team)
  * ✍️ **Manuell:** Beliebiger Schätzwert pro Punkt
* **Vollständiges PnL:** Verrechnet Launch-Gebühr, Snipe-Einsatz, Verkaufserlös, Creator-Gebühren und den Dollar-Gegenwert der gesammelten Pilotenpunkte zu einem **effektiven Netto-PnL**.
* **Saubere Creator-Fees:** Weist unbeanspruchte Gebühren exakt nach Währung aus (z. B. `0.0098 SPCX + 0.000346 ETH`) und ermöglicht das Claimen mit automatischer Konvertierung in ETH.

---

## 🛠️ CSV-Spaltenreferenz

Format für [`data/launch-queue.csv`](data/launch-queue.csv):

| Spalte | Pflicht | Beschreibung / Beispiel |
| --- | :---: | --- |
| `name` | Ja | Tokenname (z. B. `Space Kitty`) |
| `symbol` | Ja | Ticker (z. B. `SPKITTY`) |
| `country` | Ja | `us` (SPCX), `eth` (WETH), `cn` (BABA) oder `kr` (SKHY) |
| `description` | Nein | Beschreibungstext für Metadaten |
| `image_path` | Nein | Bilddatei im Ordner `assets/` (z. B. `assets/kitty1.jpg`) |
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

## ❓ Häufige Fragen & Troubleshooting

<details>
<summary><strong>1. Fehlermeldung: „Node.js ist nicht installiert oder nicht im PATH gefunden“</strong></summary>

Installiere Node.js v20+ von [nodejs.org](https://nodejs.org/). Stelle sicher, dass während der Windows-Installation der Haken bei **„Add to PATH“** gesetzt ist. Starte danach das Terminal oder deinen PC neu.
</details>

<details>
<summary><strong>2. Der Bot hält an mit: „Tresor ist gesperrt“</strong></summary>

Zur Sicherheit sperrt sich der Tresor nach 15 Minuten Inaktivität. Klicke in der oberen Menüleiste einfach auf **„🔒 Tresor gesperrt · Entsperren ➔“**, gib dein Master-Passwort ein und aktiviere die Queue wieder mit einem Klick auf **„Fortsetzen“**.
</details>

<details>
<summary><strong>3. Der Bot meldet: „Guthaben unzureichend“</strong></summary>

Prüfe, ob deine Deployer-Wallet genügend **ETH** für die Launch-Gebühr (0.0005 ETH) und Gas hat (~0.0001 ETH). Für Snipes muss die jeweilige Sniper-Wallet zudem die passende Währung besitzen (z. B. ETH für `eth`-Tokens oder SPCX für `us`-Tokens).
</details>

<details>
<summary><strong>4. Wie stoppe ich den Bot sauber?</strong></summary>

Führe einfach [`stop-bot.bat`](stop-bot.bat) aus oder drücke im Terminal-Fenster `Strg + C`.
</details>

---

## 🧪 Tests ausführen

Das Projekt verfügt über eine umfassende automatisierte Test-Suite (**49 Unit- & Integrationstests**) inklusive Mock-RPCs, Slippage-Validierung und Isolierung:

```bash
npm test
```

Alle Tests laufen isoliert in temporären Verzeichnissen ab und verändern weder deine echte SQLite-Datenbank noch deine Arbeits-Queue.

---

## 🔗 Blockchain- & Contract-Parameter

* **Netzwerk:** Robinhood Chain (`mainnet`)
* **Chain ID:** `4663`
* **RPC URL:** `https://rpc.mainnet.chain.robinhood.com`
* **Standard Factory (V3):** `0x3D69104Da2518f4833D71444D6611310F2D685f2`
* **Router (V3):** `0x3c7476e8Be0efd5b9667421448a99E217B806E80`
* **Explorer:** [Robinhood Chain Explorer](https://robin.etherscan.io)
