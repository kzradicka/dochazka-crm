# Docházkový systém pro ostrahu objektů

Telefonní hlášení příchodů a odchodů přes Twilio s automatickým záznamem do CRM
a webovým přehledem pro dispečink.

- **Telefon:** zaměstnanec zavolá na jedno číslo a zadá osobní číslo s křížkem. Tím se přihlásí do služby.
- **Automatické odhlášení:** zaměstnanec se neodhlašuje ručně — systém ho po 12 hodinách (nastavitelné přes `SHIFT_HOURS`) automaticky považuje za odhlášeného a z přehledu zmizí.
- **Záznam:** uloží se čas, zaměstnanec, osobní číslo, telefon volajícího, ověření čísla a objekt.
- **CRM (web):** živý přehled „kdo je ve službě" (včetně času automatického odhlášení), historie s filtrem a exportem do Excelu, správa zaměstnanců a objektů, hlídání nenahlášených směn s upozorněním e-mailem/SMS.

---

## Architektura

Jedna aplikace (Node.js) obsluhuje současně:
- **Twilio webhooky** (`/voice`, `/voice/code`, `/voice/event`) – hlasové menu a zápis docházky,
- **REST API** (`/api/...`) – data pro CRM, chráněné přihlášením,
- **frontend** (React, statické soubory) – webové rozhraní dispečinku.

Data jsou v PostgreSQL. Na Railway běží aplikace jako jedna služba + databáze Postgres
(vejde se do Hobby plánu).

```
Zaměstnanec → Twilio → /voice (webhook) → Node.js → PostgreSQL → CRM (web)
```

---

## Část A — Nahrání na GitHub

1. Na GitHubu vytvořte nový **prázdný** repozitář (např. `dochazka-crm`), bez README.
2. V tomto adresáři spusťte:

   ```bash
   git init
   git add .
   git commit -m "Docházkové CRM – první verze"
   git branch -M main
   git remote add origin https://github.com/VAS-UCET/dochazka-crm.git
   git push -u origin main
   ```

   (`VAS-UCET` nahraďte svým jménem na GitHubu.)

---

## Část B — Nasazení na Railway

1. Přihlaste se na **railway.com** přes GitHub.
2. **New Project → Deploy from GitHub repo** → vyberte `dochazka-crm`.
   Railway si projekt stáhne a podle `railway.json` ho sestaví (`npm install && npm run build`)
   a spustí (`npm start`).
3. Ve stejném projektu klikněte **New → Database → Add PostgreSQL**.
   Railway databázi vytvoří a do aplikace automaticky doplní proměnnou `DATABASE_URL`.
4. V aplikaci otevřete záložku **Variables** a přidejte:

   | Proměnná | Hodnota |
   |---|---|
   | `ADMIN_PASSWORD` | heslo pro přihlášení do CRM |
   | `JWT_SECRET` | dlouhý náhodný řetězec |
   | `TWILIO_ACCOUNT_SID` | z Twilio konzole |
   | `TWILIO_AUTH_TOKEN` | z Twilio konzole |
   | `TWILIO_NUMBER` | vaše Twilio číslo, např. `+420…` |

   Volitelně pro notifikace o nenahlášení (e-mail / SMS) – viz `.env.example`.

5. V záložce **Settings → Networking → Generate Domain** vytvořte veřejnou doménu.
   Dostanete adresu typu `dochazka-crm-production.up.railway.app`.

> Po každém `git push` se aplikace na Railway sama znovu sestaví a nasadí.

---

## Část C — Nastavení Twilia

1. V [Twilio konzoli](https://console.twilio.com) kupte české číslo (Phone Numbers → Buy a number).
2. U čísla v sekci **Voice Configuration → A call comes in** nastavte:
   - **Webhook**, **HTTP POST**
   - URL: `https://VASE-RAILWAY-DOMENA/voice`
3. Uložte. Hotovo — zavolejte na číslo a otestujte.

---

## Část D — Vlastní doména (crm.ostrahaobjektupraha.cz)

Až budete chtít přejít z dočasné domény na vlastní:

1. V Railway **Settings → Networking → Custom Domain** zadejte `crm.ostrahaobjektupraha.cz`.
   Railway zobrazí cílovou hodnotu pro **CNAME** záznam.
2. U své domény přidejte **CNAME** záznam `crm` → (hodnota z Railway). HTTPS certifikát
   Railway vystaví automaticky.
3. V Twiliu přepište webhook na `https://crm.ostrahaobjektupraha.cz/voice`.

Žádný kód se nemění — frontend volá API přes relativní cesty, takže funguje na jakékoli doméně.

---

## První kroky v aplikaci

1. Otevřete doménu, přihlaste se heslem z `ADMIN_PASSWORD`.
2. **Zaměstnanci a objekty** → přidejte zaměstnance (jméno, telefon, osobní číslo) a objekty.
3. **Směny a hlídání** → volitelně naplánujte směny pro upozornění na nenahlášení.
4. Zavolejte na Twilio číslo a otestujte příchod/odchod — objeví se v **Kdo je ve službě**.

---

## Lokální vývoj

```bash
cp .env.example .env      # vyplňte DATABASE_URL na lokální Postgres, TWILIO_VALIDATE=false
npm install
npm run build             # sestaví frontend
npm start                 # server na http://localhost:3000
```

Pro odladění telefonní části lokálně použijte [ngrok](https://ngrok.com)
(`ngrok http 3000`) a vzniklou https adresu zadejte do Twilia.

---

## Poznámky k bezpečnosti

- Osobní čísla (PIN) jsou v této verzi uložena v čitelné podobě — pro produkci doporučujeme hašování.
- Přístup do CRM je chráněn jedním heslem + tokenem (JWT). Pro více uživatelů s rolemi je vhodné rozšíření.
- Veškerá komunikace běží přes HTTPS; webhooky z Twilia se ověřují podpisem (`TWILIO_AUTH_TOKEN`).
```
