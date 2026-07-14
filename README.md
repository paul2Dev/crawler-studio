# Crawler Studio

Crawler Studio este un tool web pentru export local de website-uri (HTML + asset-uri), construit cu Node.js, Express si Playwright.

Proiectul are UI simplu pentru rulare, monitorizare job-uri, dry run, oprire job activ si management al arhivelor generate.

## Features

- Crawl cu browser real (Playwright) pentru pagini cu JS dinamic.
- Export local in `output-runs/` (HTML + CSS/JS/images/fonts/files/video/audio).
- Rescriere linkuri pentru navigare locala intre paginile exportate.
- Mod `Single Page` (doar URL-ul introdus, fara urmarire linkuri).
- Login optional inainte de crawl (user/parola + selectori CSS pentru formular login).
- Dry run pentru estimare pagini si depth (fara crawl complet).
- Respect `robots.txt` (configurabil din UI).
- Delay control cu validari stricte in frontend + backend.
- Buton `Stop job activ`.
- Lista arhive salvate + `Delete` cu confirmare.

## Cerinte

- Node.js 18+
- npm
- Playwright Chromium

## Instalare

```bash
cd crawler-studio
npm install
npx playwright install chromium
```

## Pornire

```bash
npm start
```

UI disponibil la:

`http://localhost:3010`

Daca portul 3010 este ocupat:

```powershell
$env:PORT=3011; npm start
```

## Cum se foloseste

1. Introdu URL-ul tinta.
2. Configureaza `Max pagini`, `Max depth`, delay-uri.
3. Optional: bifeaza `Doar pagina curenta` pentru export single-page.
4. Optional: bifeaza `Login inainte de crawl` si completeaza datele de autentificare.
5. Apasa `Start Crawl`.
6. Monitorizeaza progresul in log.
7. Deschide arhiva din `Arhive salvate`.

## Delay rules

Pentru crawl normal, pragurile minime obligatorii sunt:

- `Delay minim >= 700 ms`
- `Delay maxim >= 1500 ms`
- `Delay maxim >= Delay minim`

Daca valorile nu respecta regulile, jobul NU porneste.

## Dry Run

`Dry Run Statistici` ruleaza o analiza rapida a structurii site-ului:

- pagini vizitate
- pagini descoperite
- depth maxim observat
- distributie pe nivele
- recomandari pentru `Max pages` si `Max depth`

## Note importante

- Varianta `http://localhost:PORT/runs/...` este recomandata pentru randare corecta.
- Deschiderea directa prin `file://` poate avea limitari de securitate in browser (in special pe JS/module/CORS).
- Pentru site-uri complexe, exportul poate necesita ajustari per site.

## API endpoints

- `GET /api/status` - status job curent
- `POST /api/crawl` - pornire crawl
- `POST /api/dry-run` - pornire dry run
- `POST /api/stop` - oprire job activ
- `GET /api/runs` - lista arhive
- `DELETE /api/runs/:runName` - stergere arhiva

### `POST /api/crawl` - campuri de autentificare optionale

- `authEnabled`: `true/false`
- `authLoginUrl`: URL pagina login (default: `targetUrl`)
- Daca login-ul este in modal pe pagina principala, `authLoginUrl` poate ramane gol (se foloseste automat `targetUrl`)
- `authOpenModalSelector`: selector CSS optional pentru buton/link care deschide modalul de login
- `authConfirmSelector`: selector CSS optional pentru un al doilea click (ex: GDPR "Sunt de acord")
- `authUsername`: user/email
- `authPassword`: parola
- `authUsernameSelector`: selector CSS pentru campul user
- `authPasswordSelector`: selector CSS pentru campul parola
- `authSubmitSelector`: selector CSS pentru buton submit
- `authSuccessUrlContains`: verificare optionala dupa login (substring in URL)
- `authWaitAfterLoginMs`: asteptare dupa click login (default 1200)

## Structura proiect

- `app.js` - server Express + API + static runs
- `public/index.html` - interfata web
- `src/job-manager.js` - lifecycle job-uri
- `src/crawler/playwright-crawler.js` - motor crawl/export
- `src/crawler/site-profiler.js` - dry run
- `src/crawler/robots.js` - parsing/policy robots
- `src/crawler/url-utils.js` - utilitare URL/path
- `output-runs/` - output arhive

## Disclaimer

Foloseste tool-ul responsabil, respecta termenii site-ului tinta si legislatia aplicabila.
