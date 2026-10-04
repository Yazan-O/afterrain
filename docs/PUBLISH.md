# Publishing Sayr

Publishing takes four steps, run from the repository root: scan, create the repository, turn on Pages, push.
No secrets are needed. The workflows deploy with GitHub's built-in Pages token.
The push builds the site on GitHub, and a daily run keeps its forecast and its FHIR risk resources current through judging (1 to 15 October).
The scan must print `prepublish_scan: clean` every time. It fails on any restricted source file (MWRA, MassDEP), any file of the OneAquaHealth FHIR guide, any FHIR resource that is not one of Sayr's own served resources, the ENORA Earth Observation API hostname, the word pass-word (spelled without the hyphen), the OAuth grant parameter, and common key and token formats. This file names them that way so it passes its own scan.

The site will live at https://yazan-o.github.io/sayr/ (account `Yazan-O`, repository `sayr`).

## How the build stays whole on GitHub

The app's FHIR x-ray shows Sayr's own resources: Warleigh Weir, its samples and results, the 106 OneAquaHealth site Locations, one risk Observation per site (`Observation/oah-risk-dog-owners-<code>`) and the alert. The full FHIR build (`fhir/fhir-static/`) also holds the guide's 468 examples, which carry no stated licence, so it is never committed.

- **`fhir/served/` is tracked.** It holds only Sayr's own 872 served resources, the validator summary and an index: the x-ray's resources and their dependency closure, including the backtest dataset `Library/warleigh-backtest` with its `Binary` and all 322 E. coli results and samples it lists. `npm run fhir` (in `fhir/`) writes it after a build that validates with 0 errors. Every build of the site copies it into `web/public/data/fhir`. A local snapshot build (`npm run build` in `web/`, from the committed `data/out/` and `fhir/served/`) therefore needs no Java, validator or guide. The Pages build is a refresh-and-validation build: it refetches the forecast and rebuilds `fhir/served/` from it, so it installs Java 17, downloads the HL7 validator and fetches the guide on the runner (next two points).
- **The build refuses drift.** `web/scripts/sync-fhir.mjs` compares each site's risk Observation with `data/out/nowcast_<city>.json`: the value, the fog, the hour and the forecast fetch time. If one differs, `npm run build` stops with "Run `npm run fhir` in sayr/fhir". So the x-ray can never show another forecast than the map. `npm run dev` only warns.
- **The daily run rebuilds both from one forecast.** The `nowcast` workflow refetches the forecast, then runs the full FHIR build on the runner: it fetches the guide at its pinned commit, builds it and Sayr's resources with SUSHI, runs the HL7 validator 6.10.4 on Java 17, and exports `fhir/served/`. Since 2026-10-02 every build, a push included, runs the same refresh first. The build and deploy jobs each run one at a time (concurrency groups `pages-build` and `pages-deploy`), but GitHub does not promise that queued runs start in order, so the deploy job enforces freshness itself (`docs/freshness_gate.py`): it reads `forecast_fetched_utc` from the live `data/nowcast_<city>.json` of all five cities and skips the deploy when any live city is newer than the build. An older build that starts late therefore never replaces a newer forecast in any city. A failed lookup of the live site (a network error, another status than 200, a missing city file, unreadable JSON) fails the run; only a 404 at the site root, a first deployment, deploys without the comparison. The build writes the validation date (`validated_utc`) and the validator version into the summary the x-ray quotes, so the live summary always dates the validation of the resources beside it. The committed summary gains the date at the next `npm run fhir` or the first daily run.
- **A failed day changes nothing.** If the forecast download, the guide fetch or the validator fails, any resource has a validation error, or any test fails (pytest for the pipeline and the FHIR layer, Vitest for the app), the run stops before deploying. The deploy never falls back to a cached forecast: the cache fallback exists only behind `--allow-cache` for local builds. The site keeps the previous day's forecast and resources, which match each other. GitHub emails the owner about the failed run.

Why this design: the alternative, committing `fhir-static/`, would publish the guide's examples. Validating only on the owner's machine would leave the live x-ray a forecast behind the map after the first daily refresh. The build job may run 90 minutes. The first `nowcast` run measures the time on GitHub's runner.

## 1. Before publishing

```
python docs/prepublish_scan.py
```

- If anyone re-ran `python -m pipeline nowcast` since the last FHIR build, rebuild the FHIR resources so `fhir/served/` matches (needs Java 17 and `validator_cli.jar`, see `fhir/README.md`):

```
cd fhir
npm run fhir
cd ..
```

- Replace `[LIVE_LINK]` and `[VIDEO_URL]` in `README.md` with the final demo and film links. This must print nothing: `python -c "import sys; sys.exit(any(p in open('README.md', encoding='utf-8').read() for p in ('[LIVE_LINK]', '[VIDEO_URL]')))" || echo placeholder left`.
- Build the site as Pages will serve it, then scan the build. In PowerShell:

```
cd web
$env:SAYR_BASE = '/sayr/'; npm run build; Remove-Item Env:SAYR_BASE
cd ..
python docs/prepublish_scan.py --site web/dist
```

In Git Bash, prefix the build with `MSYS_NO_PATHCONV=1`. Otherwise Git Bash rewrites `/sayr/` into a Windows path.

- Open every route the README names in the built site (`#/story`, `#/dark-hours`, `#/replay`, `#/city/CO`, the FHIR x-ray tap). Cut any README line whose feature does not open.

## 2. Create the repository (no push yet)

```
git init -b main
git add .gitignore LICENSE README.md requirements.txt pytest.ini .github docs data pipeline tests web fhir
python docs/prepublish_scan.py
git commit -m "Sayr: a One Health view of the storm hours on city streams"
gh repo create Yazan-O/sayr --public --source . --remote origin
```

Inside a git repository, the scan reads the files git will commit, including anything force-added. `git ls-files fhir/served | wc -l` must print 874 (872 resources, the summary and the index).

## 3. Turn on Pages from GitHub Actions

```
gh api -X POST repos/Yazan-O/sayr/pages -f build_type=workflow
```

The same setting is in Settings, Pages, Source: "GitHub Actions". Secrets: none.

## 4. Push, then check the live site

```
git push -u origin main
gh run watch
gh workflow run nowcast.yml
gh run watch
```

The push starts the `pages` workflow: Pillow for the stream build, install with npm 11, build with `SAYR_BASE=/sayr/`, scan the repository and `web/dist`, deploy. The manual `nowcast` run proves the daily refresh works. It then runs by itself at 04:00 UTC (23:00 CDT) and commits nothing.

After each run, in Git Bash:

```
S=https://yazan-o.github.io/sayr
curl -s -o /dev/null -w "%{http_code}\n" $S/                                  # 200
curl -s -o /dev/null -w "%{http_code}\n" $S/data/numbers.json                 # 200
curl -s -o /dev/null -w "%{http_code}\n" $S/data/fhir/index.json              # 200
curl -sI -H "Accept-Encoding: gzip" $S/data/numbers.json | grep -i content-encoding           # content-encoding: gzip
JS=$(curl -s $S/ | grep -o 'assets/index-[^"]*\.js' | head -1)
curl -sI -H "Accept-Encoding: gzip" $S/$JS | grep -i content-encoding                         # content-encoding: gzip
curl -s $S/data/fhir/sayr.summary.json | python -c "import json,sys; d=json.load(sys.stdin); print(d['counts'], d.get('validated_utc'))"
curl -s $S/data/nowcast_CO.json | python -c "import json,sys; print(json.load(sys.stdin)['forecast_fetched_utc'])"
curl -s $S/data/fhir/Observation/oah-risk-dog-owners-C1.json | python -c "import json,sys; print(json.load(sys.stdin)['note'][1]['text'][:37])"
```

- The counts line must show 0 errors and 0 fatal. After a `nowcast` run, `validated_utc` is that run's date.
- The last two lines must show the same fetch time: the map and the x-ray use one forecast.
- Open `#/story`, `#/city/CO`, `#/replay` and `#/dark-hours` in a browser with the console open: 0 errors.

**Compression.** The two `curl -sI` checks above inspect the deployed JSON and JavaScript response headers. Fonts use compressed WOFF/WOFF2 formats.

**If a daily run fails.** Read it with `gh run view --log-failed`. A failed run deploys nothing, so the site stays whole on the previous day. Rerun with `gh run rerun <id> --failed` or `gh workflow run nowcast.yml`.

**After judging closes on 15 October:** `gh workflow disable nowcast.yml`. The site then stays on its last forecast. `gh workflow list` shows it as `disabled_manually`.

## What is published

**The repository:** the code (`pipeline/`, `web/`, `fhir/sayr_fhir/`, `fhir/sayr-ig/`, tests), `fhir/served/` (Sayr's own served FHIR resources and the validator summary), `data/raw/` without `restricted/` and without the raw OneAquaHealth API responses (`oah_*.json`), `data/out/`, `docs/`, `.github/`, `README.md`, `LICENSE`, `data/LICENSE-DATA.md`.

**The site (`web/dist`):** `index.html`; the app's scripts, styles and fonts; the replay's terrain and waterways; the 26 JSON files of `data/out/`; one stream pack per city; and `data/fhir/`, a copy of `fhir/served/`.

**Never published** (git-ignored, and the scan fails if one appears):
- `data/raw/restricted/`: the MWRA and MassDEP files. Only counts and medians derived from them reach `data/out/transfer.json` and `numbers.json`.
- `data/raw/oah_*.json`: the raw OneAquaHealth API responses, whose licence is not stated. Only derived data (the city packs, site lists, counts in `numbers.json`) is published. The build fetches them again from the API.
- `fhir/ig-src/`, `fhir/build/` and `fhir/fhir-static/`: the OneAquaHealth guide, its package and its 468 examples. The daily run builds them on the runner and discards them.
- `node_modules/`, `web/dist/`, `web/public/data/`, `web/screens/`, `web/test-results/`, `fhir/tools.local.json`, `.env` files.
