# Standard Launch Console

Lokale Launch-Oberfläche für Standard Reserve auf Robinhood Chain. Mit Wallet-Profilen, Token-Entwürfen, einer echten Contract-Simulation und persistentem Alert-Monitoring.

## Starten

Voraussetzung: Node.js 24 oder neuer.

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

Danach **http://127.0.0.1:4317** in einem Browser öffnen. Für Launches benötigt der Browser eine EVM-Wallet-Erweiterung. Im Codex-Browser ist möglicherweise keine Wallet verfügbar; dann denselben Link in deinem normalen Browser öffnen.

`npm.cmd run dev` baut das Frontend und startet den Server. Nach Frontend-Änderungen erneut bauen und den Browser neu laden; kein Hot Reload.

## Launch-Ablauf

1. Wallet verbinden; optional unter **Wallets** einen Namen und die öffentliche Adresse speichern.
2. Name, Symbol und Stock-Paar (SPCX, BABA oder SKHY) setzen. Entwürfe können gespeichert und geladen werden.
3. Optional ein Bild für die lokale Vorschau auswählen. PNG/JPG/WebP, maximal 2 MB. Die Datei bleibt lokal und wird nicht automatisch veröffentlicht oder im Entwurf gespeichert.
4. **Metadata-URL darf leer bleiben.** Dann wird automatisch die on-chain verifizierte URL des Referenz-Tokens `0xf54da332441779178c84553e9d98019a46867c02` verwendet: `https://img.standardreserve.xyz/m/d4c2ac8cf9708493ab310a2cfbd5cd56.json`. Diese JSON enthält ausschließlich einen Bildverweis. Du übernimmst damit dessen Bild; lokale Vorschau, Bild-URL und Beschreibung verändern diese fremde JSON nicht. Eine eigene eingetragene Metadata-URL hat Vorrang. Für eigene Metadaten: Bild öffentlich hosten, JSON exportieren und ebenfalls hosten. Prüfe, dass deine URL das gewünschte JSON liefert.
5. Die gewählte Deployer-Adresse in der Browser-Wallet aktivieren. **Zu Robinhood wechseln** beim Launch öffnet die Netzwerkanfrage; falls nötig wird Robinhood Chain (Chain ID **4663**) zum Hinzufügen angeboten. **Launch prüfen** fragt den Wechsel ebenfalls an, wenn du noch im falschen Netzwerk bist. Ein Chain-Wechsel erhält die Kontoverbindung und verwirft nur eine bereits geprüfte Transaktion. Ein tatsächliches `accountsChanged([])` oder Disconnect trennt den Kontostatus. Bereits freigegebene Konten werden nach Reload ohne neue Berechtigungsanfrage eingelesen.
6. **Launch prüfen** liest die aktuellen Vertragsparameter, prüft die Byte-Limits, simuliert die Transaktion und schätzt Gas und Guthabenbedarf. Die Vorschau gilt 30 Sekunden.
7. **Signatur & Launch:** Wenn eine Wallet aus dem Tresor gewählt wurde, kann die Transaktion direkt über **Mit Tresor signieren & absenden** on-chain gesendet werden. Bei externen Adressen öffnet **In Browser-Wallet bestätigen** wie bisher deine Browser-Extension. Die App wartet auf die Receipt und liest das `Launched`-Event.

Die Console setzt zusätzliche Creator-Tax auf 0, Launch-Schutz auf aktiv, Charter-Drop auf 0 und tätigt keinen Eröffnungskauf. Creator-Gebühren gehen zunächst an die Deployer-Wallet.

## Verschlüsselter Wallet-Tresor (Vault)

Unter **Wallets** findest du den verschlüsselten Tresor:

- **Sicherheit at Rest:** Private Keys werden mit **AES-256-GCM** verschlüsselt in der lokalen SQLite-Datenbank abgelegt. Die Schlüsselableitung erfolgt über `scrypt` mit eindeutigem Salt und starkem Master-Passwort (mindestens 8 Zeichen). Ein Private Key wird **niemals unverschlüsselt** auf der Festplatte gespeichert.
- **Zustände:**
  - *Nicht initialisiert:* Master-Passwort einmalig vergeben.
  - *Gesperrt:* Adressen und Labels bleiben sichtbar, Private Keys können nicht entschlüsselt oder zum Signieren verwendet werden.
  - *Entsperrt:* Temporäre Entschlüsselung im flüchtigen RAM mit automatischer Sperrung (Auto-Lock nach 15 Minuten Inaktivität) oder sofort per Klick auf **Tresor sperren**.
- **Funktionen:**
  - Neue Zufalls-Wallets direkt im Tresor generieren.
  - Bestehende Wallets über 64-stelligen Hex-Private-Key verschlüsselt importieren.
  - Guthabenanzeige (ETH) auf Robinhood Chain in Echtzeit.
  - Private Key nach erneuter Passworteingabe im Klartext einsehen und kopieren.
  - Gespeicherte Beobachtungs-Adressen (ohne Key) bleiben weiterhin für die Browser-Wallet verfügbar.

## Entwurfs-Queue und Automatischer Launch-Runner

Unter **Entwurfs-Queue** findest du Import und Download der Vorlage `examples/launch-queue.csv`. UTF-8 (auch mit BOM), Komma oder Semikolon, maximal 60 KB und 200 Queue-Einträge.

| Spalte | Bedeutung |
| --- | --- |
| `name`, `symbol` | Pflichtfelder für Tokenname und Symbol |
| `country` | `us`, `cn` oder `kr` |
| `description` | Optionaler Beschreibungstext im Entwurf |
| `image_path` | Lokale Vorschau: `assets/dein-token.png` oder absoluter Pfad im Ordner `assets` |
| `image_url` | Optionaler öffentlicher Bildverweis für den JSON-Export |
| `metadata_uri` | Leer = verifizierte Standard-Metadaten; sonst eigene HTTPS-/IPFS-URL |
| `website` | Optionaler Projektlink |
| `wallet` | Optionale Deployer-Adresse (0x...) oder Name/Label einer Wallet aus dem Tresor |
| `monitor_enabled` | Optional: `true` / `false` (schaltet Monitoring für diese Zeile ein/aus) |
| `monitor_rules` | Optionale Regeln: z. B. `marketCapUsd>=200000;gain>=50;drawdown>=25` |
| `monitor_mcap_gte` | Optional: Schwellenwert für Market Cap (USD), z. B. `150000` |
| `monitor_price_change_gte` | Optional: Kursgewinn in % seit Launch, z. B. `50` |
| `monitor_drawdown_gte` | Optional: Rückgang vom Höchstkurs in %, z. B. `30` |
| `monitor_mode` | Optional: `any` (ODER, Standard) oder `all` (UND) |
| `monitor_hold_seconds` | Optional: Haltezeit in Sekunden (Standard: `10`) |
| `monitor_cooldown_seconds` | Optional: Cooldown in Sekunden (Standard: `60`) |
| `monitor_once` | Optional: `true` (nach erstem Alert pausieren) oder `false` |

### Automatisches Monitoring unmittelbar bei Launch:
- **Sofortiger Start:** Sobald ein Token auf der Blockchain bestätigt ist (manuell oder über die Queue), wird der Monitor mit den konfigurierten Trigger-Regeln auf dem Server angelegt und sofort aktiv abgefragt. Die Baseline-Kurse und das Token-Alter werden ohne Zeitverzögerung direkt erfasst.
- **Wählbar im Launch-Formular:** Unter Abschnitt 05 kann das automatische Monitoring mit eigenen Regeln, Operatoren und Schwellenwerten (z. B. Market Cap $\ge$ 150k, Kursanstieg $\ge$ 50%, Drawdown $\ge$ 30%) konfiguriert oder deaktiviert werden.
- **Konfigurierbar in der Queue:** Standardmäßig ist Auto-Monitoring auch für alle Queue-Launches aktiv. Pro CSV-Zeile können über die Spalten `monitor_rules`, `monitor_mcap_gte` etc. individuelle Regeln hinterlegt oder über `monitor_enabled=false` gezielt abgeschaltet werden.

### Automatischer Intervall-Launch:
- **Aktivierung:** Im Queue-Panel kann der automatische Start aktiviert werden.
- **Intervall:** Alle X Minuten (konfigurierbar von 1 bis 1440 Minuten) führt der Server den obersten Eintrag der Queue aus.
- **Wallet-Strategie:**
  - **Feste Wallet (immer dieselbe):** Es wird eine feste Standard-Tresor-Wallet ausgewählt. Diese dient als Deployer für alle Queue-Launches (sofern in der CSV keine explizite Wallet angegeben ist).
  - **Automatisch rotieren (reihum durch alle gewählten):** Es können beliebig viele Tresor-Wallets ausgewählt werden. Bei jedem Launch aus der Queue rotiert der Server automatisch reihum (Round-Robin) zur nächsten Wallet (Wallet 1 → Wallet 2 → Wallet 3 → Wallet 1 ...). Die Benutzeroberfläche zeigt jederzeit an, welche Wallet als Nächste an der Reihe ist.
- **Ausführung:** Der Server prüft die Konditionen, signiert die Transaktion im Hintergrund mit dem entsperrten Tresor, sendet sie an die Robinhood Chain und überwacht die Quittung. Nach erfolgreichem Launch wird der Eintrag aus der Queue entfernt, in **Bestätigte Launches** aufgenommen und ein Alert generiert.
- **Sofortstart:** Über **Jetzt nächsten Launch ausführen ⚡** kann der nächste Eintrag ohne Wartezeit getestet werden.

## Erstkauf unmittelbar nach Launch (Snipe)

Optional kann bei jedem Launch (sowohl manuell über die Launch-Konsole als auch vollautomatisch über den Queue-Runner) unmittelbar nach dem Token-Start ein Erstkauf über die Bonding-Curve ausgeführt werden:

- **Bis zu 10 Wallets:** Es können bis zu 10 Wallets aus dem entsperrten Tresor frei ausgewählt werden.
- **Währung nach Handelspaar:** Die Kaufwährung richtet sich automatisch nach dem gewählten Stock-Paar:
  - **USA (`us`):** `$SPCX` (`0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa`)
  - **China (`cn`):** `$BABA` (`0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4`)
  - **Südkorea (`kr`):** `$SKHY` (`0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8`)
- **Individuelle Beträge:** Jeder Wallet kann ein eigener Kaufbetrag zugewiesen werden (z. B. 10 $SPCX, 2.5 $SPCX etc.). Ein Standardbetrag kann mit einem Klick auf alle gewählten Wallets angewendet werden.
- **Automatisches ERC-20 Approval:** Vor dem Kauf prüft das System die Freigabe (Allowance) für den Standard Reserve Router (`0x190B452D16e12e3bEeDd76a030EA991fE3856c33`). Fehlt die Freigabe, sendet das Modul automatisch eine `approve(router, maxUint256)` Transaktion.
- **Parallele On-Chain-Ausführung:** Sobald das `Launched`-Event mit der Bonding-Curve-Adresse (`curve`) bestätigt ist, feuert das Modul die `buyExactIn`-Transaktionen aller ausgewählten Wallets parallel über `Promise.all` direkt an den Reserve Router, um als Allererster auf der Curve einzusteigen.
- **Transparente Ergebnisse:** Die Transaktions-Hashes jedes Erstkaufs werden im Launch-Feedback und im Ereignisprotokoll mit Link zum Explorer dokumentiert.

**Gesendete Transaktionen:** Der Hash wird im Browser gespeichert und nach einem Reload erneut geprüft. Bei einer beschleunigten/ersetzten oder dauerhaft ausstehenden Transaktion erst im Explorer und in der Wallet klären, ob der Launch ausgeführt wurde.

## Monitoring und Alerts

Bis zu 30 Monitore mit je 1–10 Regeln. Der Server fragt die öffentliche Markets API ungefähr alle fünf Sekunden ab; langsame Antworten oder viele Tokens verlängern den tatsächlichen Zyklus. Ein Token wird pro Zyklus nur einmal abgefragt. Unterstützt:

- Market Cap, Liquidität und Tokenpreis in USD.
- Volumen und Anzahl Trades in **rollierenden 24 Stunden**; kein kumuliertes Volumen seit Start des Monitors.
- Kursänderung gegenüber dem ersten gültigen Kurs nach Aktivierung.
- Rückgang vom höchsten seit Aktivierung beobachteten Kurs.
- Token-Alter, berechnet aus Launchzeit und Datenzeitstempel der API.
- ODER-/UND-Verknüpfung, ≥/≤-Vergleich, Haltezeit, Cooldown, einmaliges Auslösen.

Die API-Daten sind aggregierte Indexer-Daten, keine Mempool- oder Tick-Daten. Es gibt keine Erkennung „externer Bots“, keine Unterscheidung zwischen eigenem und fremdem Volumen und keine Holder-Zählung.

Fehlende Kennzahlen zählen nicht als null. Daten älter als 60 Sekunden, explizit veraltete Daten und rückläufige/ungültige Zeitstempel lösen keine Alerts aus. Ein Datenfehler oder Server-Neustart setzt eine laufende Haltezeit zurück. Kursbasis und beobachtetes Hoch bleiben bei einem Neustart erhalten. Ausfallzeiten werden nicht nachträglich rekonstruiert. Ein Cooldown allein löst keinen wiederholten Alert aus: Dafür muss die Bedingung zwischenzeitlich falsch gewesen sein. **Neu scharfstellen** setzt auch Kursbasis, Hoch und bisherigen Auslösezustand zurück. Beim Bearbeiten und Speichern gilt dasselbe.

Alerts erscheinen in der App und optional als Browser-Benachrichtigung. Es werden die letzten 1.000 Alerts lokal gespeichert. **Rechner und Node-Server müssen eingeschaltet bleiben.** Bei geschlossenem Browser läuft die Prüfung weiter, sofern der Server läuft. Desktop-Benachrichtigungen benötigen einen geöffneten Tab und erteilte Browser-Berechtigung; ohne Tab bleiben Alerts im Protokoll. Kein externer E-Mail-/Telegram-Dienst ist eingerichtet.

## Daten und Zugriff

- SQLite-Datei: `data/console.sqlite`, mit WAL-Sidecar-Dateien während des Betriebs. Zum Kopieren/Backup den Server zuvor beenden oder eine SQLite-konforme Sicherung verwenden.
- Gespeichert werden verschlüsselte Private Keys (AES-256-GCM), öffentliche Adressen, Entwürfe, Monitore, Alerts und bestätigte Launches.
- Listener ausschließlich auf `127.0.0.1:4317`; Origin-/Host-Prüfung für die lokale API. Nicht über einen Reverse Proxy öffentlich freigeben: Benutzer-Authentifizierung ist nicht implementiert.
- Die Datenbank nutzt das mit Node 24 gelieferte `node:sqlite`; bestimmte Node-24-Versionen geben dafür einen Experimental-Hinweis aus.

## Quellen und Vertragskonfiguration

Verifiziert am **19. Oktober 2026** anhand der öffentlich ausgelieferten [Standard-Launch-Seite](https://www.standardreserve.xyz/liquidity/) und ihres JavaScript-Bundles sowie per RPC.

- Chain: 4663; RPC: `https://rpc.mainnet.chain.robinhood.com`
- [Factory](https://robin.etherscan.io/address/0x3D6Ea4e97B8AB9E1A1B4943fEBfFe22D8c920091): `0x3D6Ea4e97B8AB9E1A1B4943fEBfFe22D8c920091`
- Markt-API: `https://markets.standardreserve.xyz/v1/tokens/{address}`
- Deployment-Adressen: `shared/deployment.mjs`; veröffentlichte ABI-Signaturen: `shared/abi.json`.
- Aktuelle Launch-Gebühr und Limits werden aus dem Vertrag gelesen, nicht fest einprogrammiert. Legacy- und Charter-Drop-ABI werden unterschieden. Änderungen der Factory oder API können ein Update erfordern.

## Tests

```powershell
npm.cmd test
npm.cmd run check:live
npx.cmd playwright install chromium
npm.cmd run test:browser
```

Unit-/Integrationstests decken Trigger, fehlende/veraltete Daten, Cooldown, Speicherung, Validierung, ABI-Encoding, Metadata-Fallback, CSV-Parsing, Bildpfad-Grenzen und Netzwerkwechsel ab. Der Browsertest nutzt eine eigene temporäre Datenbank, kontrollierte Marktdaten und eine simulierte Browser-Wallet; er prüft Formulare, Export, Alerts, Speicherung, Bearbeiten, CSV-Queue, Netzwechsel samt Add-Chain-Fallback, Ablehnung und erhaltene Wallet-Verbindung sowie explizite Signaturbestätigung. Kein echter Kauf, Verkauf oder Launch wird durch die Tests gesendet.

Die Live-Prüfung liest echte Vertrags- und Marktdaten. Zusätzlich wurde bei der Implementierung ein Launch via `eth_call` mit temporärem Guthaben-Override simuliert; das verändert keinen Blockchain-Zustand. Ein tatsächlich signierter Mainnet-Launch ist noch nicht getestet.

## Projektstruktur

`web/` enthält die deutsche Oberfläche, `server/` die lokale API, Persistenz und Chain-Anbindung, `shared/` die Vertragskonfiguration und Trigger-Logik. `tests/` enthält automatisierte Prüfungen. Forschungs-Downloads, Build-Ausgaben, Datenbanken und Testergebnisse sind aus Git ausgeschlossen.
