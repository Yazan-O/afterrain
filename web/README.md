# Web app

The browser app for Sayr: Vite and strict TypeScript, no UI framework. It serves the pipeline's outputs from `sayr/data/out`, checks every file against its schema when it loads, and runs the engine in the browser.

## Run it in a browser

The pipeline's outputs (`sayr/data/out`) are in the repository, so the app runs without a pipeline build. Node 22 or later; Python with Pillow (`pip install -r ../requirements.txt`) builds the stream packs, and the first run fetches terrain tiles.

```
npx npm@11 ci     # npm 10.9 crashes resolving Vitest's optional peers
npm run dev       # copies data/out into the app, builds the stream packs, starts Vite on http://localhost:5173/
```

The link opens on story mode; `#/city/CO` goes straight to Coimbra's map.

## Commands

```
npx npm@11 ci                    # install the pinned versions from package-lock.json
npx playwright install chromium  # once, for the e2e run
npm run data                     # copy sayr/data/out/*.json to public/data/ (removes stale copies), build the stream packs, check and copy the served FHIR resources (sayr/fhir/served) to public/data/fhir
npm run streams                  # only the stream packs: python scripts/build_streams.py -> public/data/streams/<city>.json
npm run dev                      # data + Vite dev server
npm run build                    # data + typecheck + production build in dist/
npm test                         # Vitest: schemas, model, replay, transport, fog, time zones, number format
npm run e2e                      # build, then Playwright on the build and on the harness fixtures
```

`SAYR_APP_PORT`, `SAYR_FIXTURE_PORT` and `SAYR_DIST` move the e2e servers and the build they serve (defaults 4173, 5174, `dist`), so two runs can share a machine.

Screenshots from `npm run e2e` land in `screens/` (1440x900 and 390x844, with and without reduced motion); story mode and the x-ray write theirs to the folder their spec names (`SHOTS`). `STORY_FILM=1 npx playwright test story.film` renders the story's 85-second film there, frame by frame. The two scenes have their own commands: `npx playwright test -c tests/e2e/replay` (the replay and the dark hours through the real shell, on a private build; `SCENE_SCREENS=<folder>` adds every beat of both scenes at both sizes, night and day; `REPLAY_FRAMES=1` renders `replay_45s.mp4`) and `npx playwright test -c tests/e2e/darkhours` (`DARKHOURS_FRAMES=1 DARKHOURS_URL=/#/dark-hours` renders the dark hours' film through the shell); `FILM_RUN=<output folder>` picks where films land.

## Layout

| Path | What it holds |
|---|---|
| `src/main.ts` | The shell: clock, theme, chrome (wordmark, city switcher, hour, day/night, credits, the links to the other scenes, "Now see Coimbra"), hash routing with cross-fades, the one frame loop |
| `src/app/` | `clock.ts` the film clock; `router.ts` hash routes; `theme.ts` night/day; `story.ts` the story's pure sequencer; `narration.ts` its lines; `storyShell.ts` story mode's scenes, narration and keys; `xray.ts` the FHIR x-ray |
| `src/fhir/xrayMap.ts` | Which OAH-FHIR resource sits behind a thing on screen, and the key lines its card shows |
| `scripts/sync-fhir.mjs` | `--export` (run by `npm run fhir` in `sayr/fhir`) selects the resources the x-ray shows from `sayr/fhir/fhir-static` into the tracked `sayr/fhir/served`: only Sayr's own (never the guide's examples), with the validator summary and an index (`siteRisk`: site code to its risk resource). Without it (`npm run data`) it checks `sayr/fhir/served` against `sayr/data/out` and copies it to `public/data/fhir`, so the build needs no Java or validator; the Pages workflow runs `npm run fhir` before it |
| `src/scenes/types.ts` | The `Scene` and `SceneContext` contract every scene implements |
| `src/city/` | The hero scene: `scene.ts` (rest, unroll, strip, figures, quest, fog lift), `cityData.ts` (ways, streams, the field of forecast hours, up to 168), `figures.ts` (the four lives), `mapStyle.ts` (basemap and palettes) |
| `src/model/` | `alongStream.ts` the along-stream rule; `cityState.ts` sites hour by hour and test samples; `humanSentence.ts` the open stream's first line, for a person; `sentence.ts` the scrubbed hour's line and the test result's line; `quest.ts` the quest's ask; `names.ts` the names on screen |
| `scripts/build_streams.py` | Chains the named streams per city, exports the ensemble rain the browser needs, and bakes each vertex's ground elevation from the terrain tiles (cached in `sayr/data/raw/terrarium/`; see its header) |
| `src/data/` | `decode.ts` path-aware decoders; `schemas.ts` one schema per output file; `loaders.ts` typed loaders |
| `src/engine/model.ts` | The Warleigh and portable logistic models, exactly as `pipeline/model.py` exports them |
| `src/engine/replay.ts` | A storm replay as a timeline: overflow on/off events, samples, daily flow and rain |
| `src/engine/transport.ts` | Pulses from each spilling overflow travelling to the weir; the assumptions and their sources are in the file header |
| `src/engine/fog.ts` | The citizen-sample update and the fog, reproduced from `update_spec.json` |
| `src/engine/timefmt.ts` | Every display time in the place's own zone |
| `src/format/numfmt.ts` | The one way a `numbers.json` value becomes text |
| `src/format/canvasText.ts` | `window.__sayrCanvasWords`: words drawn on a canvas, registered for the checks |
| `tests/e2e/harness/` | The quality checks every screen must pass |
| `tests/e2e/fixtures/` | Tiny pages that show each check passing and failing |

## Rules the harness enforces on every screen

Use `test` from `tests/e2e/harness/test.ts` and call `expectScreenQuality(page, state)` in each state.

- **No errors.** Any console error, uncaught error, unhandled rejection, failed request or HTTP status of 400 or more fails the test.
- **No horizontal scroll** at 1440x900 or 390x844.
- **Word budget.** Visible words: at rest 8 or fewer, with the strip open 44 or fewer (the person's sentence leads it), on the opening comparison 32 or fewer, on a narrated story beat 38 or fewer (one sentence of up to 22 words over the scene's own few), with the map's key on demand 32 or fewer (`WORD_BUDGETS` in `tests/e2e/harness/checks.ts`). Visible means a box larger than 1x1 px, visibility `visible`, combined opacity above 0.1, and no clipping ancestor of 1 px or less. Words drawn on a canvas count too: register them with `registerCanvasText(id, { text })` and clear them with `clearCanvasText(id)`.
- **Code is exempt from the word budget, not from provenance.** Text inside a `[data-code]` region (the x-ray's typeset resource) is not counted as words; every digit in it still needs its source.
- **Number provenance.** Every visible digit sits in one of these:
  - an element with `data-num="<numbers.json key>"` whose whole text equals `formatNumber(value, data-fmt)`, where `data-fmt` is absent or `int`, `fixed:N`, `pct:N`, or `raw` (the number as JSON writes it, for code);
  - an element marked `data-time`;
  - a `data-unit` element whose text is on the unit allowlist in `checks.ts` (for example "per 100 ml", or the name "HL7").

  Canvas numbers register `{ text, num, fmt }`.
- **Banned word.** `/\bsafe\b/i` anywhere on the page, shown or hidden, including `aria-label`, `alt` and `title`, fails. "unsafe" does not match.
- **Reduced motion.** Under `prefers-reduced-motion: reduce` no CSS or Web Animation may be running.

## Routes and scenes

| Hash | Scene |
|---|---|
| `#/story` | Story mode, the default when the hash is empty (below); `#/story/<beat>` opens at a beat |
| `#/city/<id>` | The city at rest (`CO`, `BE`, `GH`, `OS`, `TO`; Coimbra when the hash is unknown) |
| `#/city/<id>/stream/<slug>` | That city with a stream unrolled (the slug is the stream name in lower case with dashes) |
| `#/<name>[/...]` | Any scene in `src/scenes/<name>/index.ts`, found automatically (`#/replay`, `#/dark-hours`) |

A scene exports `default function createScene(): Scene` and receives a `SceneContext` (`src/scenes/types.ts`): the data loaders, the clock, the theme, `registerCanvasWords`, `reducedMotion`, the current city, the route params, `navigate`, and `story` (true while story mode drives it). A scene may offer `cue(name)`, a named moment of its own script that story mode plays (the city: `key`, `human`, `opening`, `kit`, `test`, `record`, `fold`), `narrate(beat)`, the lines a scene says from its own data (the city: `human`, `ask`), and `route(params)`, which the shell calls instead of mounting the scene again when the hash moves to another route of the same scene (a link, back or forward): the replay follows `#/replay[/2023-07-10][/timetable]` in place and writes its fold into the hash; the dark hours moves to the start of `#/dark-hours/<beat>` (`fall`, `line`, `cities`, `storm`, `end`), and back after its hand-off to the city lands on `storm`. The contract only grows.

A route change never passes through a dark screen: the new scene mounts in its own layer under the old one, which keeps its pictures (not its words) until the new one is ready, then the two cross-fade. The first visit to a city shows the tagline until its streams start to draw. The shell corrects a link it cannot show (an unknown city, scene segment or stream) in place, without a history entry; a malformed escape or a bad `?t`, `?rate` or `?theme` opens the app with defaults (a warning in the console, never a blank page). Titles follow the route ("Sayr: Coimbra, Ribeira das Eiras"). Escape or a tap elsewhere closes the city menu and the credits. In free exploration the city carries two quiet links near its name ("dark hours", "storm"), and a "tap a stream" cue beside the quest's lamp (right, left, above or below it, whichever fits; never on it) until the first tap. It takes the hour's place, so rest stays within 8 words; when the corner is a dated forecast ("forecast 26 Sep") the corner stays and the two links give way instead. The replay's proof leads on with "Now see Coimbra" once the storm has played to its end: the proof stays, and the line fades in beneath it, at the replay's empty line `.rp-proof`.

## Story mode (`#/story`)

The link's first screen: a narrated story, one sentence on screen at a time (`src/app/narration.ts` holds the lines, `src/app/story.ts` the script; about 80 seconds), then free exploration. Every number in the narration is bound to its source (`data-num`, `data-src`, `data-time`). The page's first paint (`scripts/first-paint.ts`) is the first line, so the story starts on words before any script has run.

| Chapter | Beats (`#/story/<beat>`) | What plays |
|---|---|---|
| storm | `weir`, `rain`, `spill`, `still`, `sample`, `proof` | the Avon replay (logged spills, modelled travel); each beat holds or moves through its own stretch of the 2024 storm (`stormKeysOf` in `storyShell.ts`): Warleigh Weir in the rain's morning; the rain to Freshford's spill (10:28, 30 hours, from the replay file); the night dimmed to the morning; the 31,000 landing; the 43 of 44 proof over the dimmed storm. The replay's own words give way to the narration (its key, dated name and reading stay) |
| dark | `cities`, `gap` | the dark hours: OneAquaHealth's samples fall to the dry side ("80 of 96 ... after dry days"); the wet side stays dark |
| city | `forecast`, `key`, `human`, `ask`, `test`, `kit`, `answer`, `changes`, `close` | Coimbra: "Sayr forecasts them."; the map at the example test reading's hour with its key on the map itself (`key` cue); the camera at Eiras with the person's sentence (`human` cue, `Scene.narrate`); the sampling request from the nowcast; the example test reading's comparison (cues `opening`, `kit`, `test`); "One sample changes the answer."; the close, while the comparison folds into the map at the next sampling site (`fold`) |

The story plays at night, and a visit that opened on the story stays at night afterwards until the viewer switches (a link straight to a city or a scene follows the sun there). The link follows the beat on screen (`#/story/<beat>`, no history entry), so a reload resumes there; an unknown beat starts from the top. At the hand-over the city gets its own history entry, and the story's entry becomes the first beat of the chapter it handed over from (`#/story/forecast` at the end of the story): Back replays that chapter, inside the app. A link to `changes` or `close` builds the comparison with its test already taken.

- **Time.** `src/app/story.ts` is a pure sequencer (unit-tested). Each chapter has a local script time that advances with the clock's animation seconds and holds while a cue plays, while an x-ray card is open, and at a chapter's end if the next scene is still loading. The next scene mounts underneath early (at the chapter's preload beat), so chapters cross-fade through the ground colour for a moment, never a wait on a dark screen. The dark hours reads the story's local time as its clock; the replay is driven by `setTime` through the storm chapter's moments; the city by its cues. The narration fades in on the clock (at once under reduced motion); the quiet beats (`still`, `proof`) dim the replay and hide its words.
- **Keys.** Space, the right arrow or Page Down (or the arrow at the bottom right, whose word shows on hover) skip to the next beat; Escape leaves for the city (the tagline holds the screen while it loads; in Coimbra the city is handed over as it is).
- **Film.** Under `?clock=manual`, `window.__sayrClock.step(ms)` moves the story frame by frame and `window.__sayrStory` reports it (`chapter`, `beat`, `t`, `local`, `waiting`, `beats`); the same point draws the same frame on every load (the e2e checks three).

## The FHIR x-ray

A number or estimate that has an OAH-FHIR resource turns over, in place, to that resource: the key lines typeset in JetBrains Mono (the profile first), the value the front showed picked out, and a mark bound to the HL7 validator's summary (`0 errors`, by `data-src` to `fhir/sayr.summary.json`). Alt+click, a long press, or the X key (the element in focus, else the largest on screen) turn it; a folded corner appears on hover; Escape, X or a tap outside turn it back. The scene recedes while a card is open and is held (`Scene.hold`: the replay stops where it is and plays on after), and story mode holds.

| On screen | Resource (`src/fhir/xrayMap.ts`) |
|---|---|
| a replay sample (the 31,000 and every other) | its `ObservationIndicatorsOah` and `SpecimenOah` (id from the sample's time) |
| Warleigh Weir | `LocationOah` `warleigh-weir` |
| a city stream's line at its place and selected hour | a record made in the browser from the state on screen (`src/fhir/liveRecords.ts`): "Forecast at <site>" (every number read from `nowcast_<city>.json`), or after a test reading "Test estimate at <site>" (marked as a test, status preliminary, with the reading's flag, the time it is assumed collected, the hour the estimate is for, and the model revision). Neither carries the validator's mark; each links to the site's published forecast peak (`siteRisk` in `fhir/index.json`) when there is one |
| the proposed alert (`data-fhir="alert"`) | the proposed `AlertOah` Communication, labelled "proposed extension, issued at Warleigh Weir" |

Elements opt in with `data-fhir` (`site:<code>`, `alert`, `Type/id` references, or a browser-made record's `forecast:` or `test:` key); the replay's elements are recognised by their class and `data-src`, so the replay's files stay untouched. An Observation's card shows what its code means beside the code (`code.text`, else the coding's display). The validator's mark is read from the served summary each time a card opens: its error count (and any fatal findings), with a tick when both are 0 and a cross otherwise. A scene that plays on its own clock is paused behind an open card through `pause()` and `resume()` when it offers them.

## The film clock

One clock drives everything (`src/app/clock.ts`); scene code never reads `Date.now()`, `performance.now()` or rAF timestamps.

| URL | Data time (the hour shown) | Animation |
|---|---|---|
| no `t` | the real time | real time |
| `?t=2026-09-28T06:00:00Z` | pinned there (a time without a zone is UTC) | real time |
| `?t=...&rate=3600` | runs from `t`, one hour per second | real time |
| `?clock=manual` | moves only with `window.__sayrClock.set(date)` or `.step(ms)` | moves only with `.step(ms)` |

`step(ms)` advances animation by `ms` and data time by `ms * rate`, so a film can be rendered frame by frame. The strip starts at the clock's hour.

**A dated forecast.** While the nowcast covers the clock, the strip starts at the clock's hour and ends where the forecast ends (a week at most). When the nowcast no longer covers the clock (the daily refresh has not run), or the clock is before it, the city shows the forecast as what it was: the corner reads "forecast 26 Sep" where the hour was, the strip's first row is labelled with its own day and hour instead of "now", and the sentence names days ("Tuesday morning") instead of "tonight" or "tomorrow" (`forecastNow` in `src/city/cityData.ts`).

**The frame loop.** Each part of a frame, and each scene's frame listener, runs on its own: one that throws is reported once (a console error, which fails every e2e test) and the loop carries on.

## What the colours, fog and sentence mean

Every value comes from the nowcast's model through `CityState` (`src/model/cityState.ts`), which recomputes each site's hours from the same ensemble rain the nowcast used (the unit tests check it reproduces `nowcast_<id>.json` at every site and hour to 6e-5).

**The along-stream rule** (`src/model/alongStream.ts`). At a point x km along a stream and an hour h:
- the chance of over 900 E. coli per 100 ml (a single-sample flag) comes from the nearest OneAquaHealth site upstream of or at x; between two sites it is interpolated linearly by position at the same hour; above the first site the first site downstream gives it;
- beyond the sites the water carries the nearest site's state at 0.5 m/s (the storm replay's median-flow assumption): below the last site it arrives later, above the first it passed earlier, so a storm arrives upstream first and leaves the mouth last;
- the fog is the site fog (interpolated the same way) rising with the along-stream distance d to the nearest site: `fog = 1 - (1 - fog_site) * exp(-d / 3 km)`;
- the state is "unknown" when the fog is at or above the nowcast's `unknown_fog` threshold, otherwise high, higher or usual by the chance against its thresholds;
- the best guess is the chance classified without the fog test: it is the colour drawn through the mist.

The strip opens on the forecast curve: the chance at one place on the stream (its tested site, else its quest's site, else its middle site) hour by hour from the strip's first row, with 0% and 100% on its scale, the dates at both ends of its time axis, and the fog as stipple along it. "Hours" switches to the field of every hour along the stream. In the field the hours run from its first row to the forecast's end, at most a week (the quests may lie days ahead), as one continuous field: every hour and 1/240 of the stream is a cell, drawn smoothed, with a hairline at each midnight and the day's name beside it (every other day on a strip longer than four days). Calm water is a quiet deep colour; a storm is a band of amber and orange whose colour follows the chance itself, fading in from 40% of a threshold to the threshold and out the same way, so it has an onset and a clearing in time, and a slant along the stream only beyond the sites (the along-stream rule's travel); above the high threshold it runs hotter where the chance is higher. Inside the fade the chance is read through a slow texture of 6% of itself, so the band's edges are soft and uneven, never a ruled line. Water streaks move downstream, faster where the chance is higher. The mist is soft drifting banks (two veils at different scales and speeds), dense where the fog is at or above the unknown threshold and thinner as it falls, thinned over the band so the band always reads through it; by day the mist is paper-white, the water pales toward the paper before it warms (amber, never brown), and "higher" keeps 3:1 or more against the paper under the mist (the e2e check reads it in a screenshot).

**Scrub the storm.** Dragging over the strip with a mouse or a finger (the strip's canvas has `touch-action: none`), or the arrow keys, Home and End on the strip in focus (a slider: `aria-valuenow` is the hour, `aria-valuetext` its day and time), sets its hour; a drag is read once per frame and the four lives are redrawn only when their pose changes: the line under the strip takes that hour's colours, the four lives stand where that hour puts them, and the sentence becomes that hour's line in the stream's voice ("Wednesday 12:00. Rain is running through me. Keep dogs out."; "Thursday 06:00. I'm clearing. Probably my usual self again."). A tap on the line brings back the stream's own sentence. Only a tap on the map around the strip, the arrow and name at the top left (the way back), or Escape fold it.

**The rest view** opens on the city's close framing (Coimbra's approved camera) and, two seconds after the basemap is complete, glides once (4.2 s, eased, clock-driven) at the same bearing and pitch to the closest framing that also holds quest #1's lamp; under reduced motion it opens there, and the viewer's own drag or wheel ends the glide. The viewer pans and zooms within the city (mouse and touch); every other quest is on its stream's strip, and a strip folds back to where the camera was. A tap on a line opens that stream; a site's dot wins only when it is nearer than every line.

**Loading.** The streams draw as soon as the city's pack is in: every vertex carries its ground elevation, so they need neither the basemap nor the terrain. The basemap fades in under them; the terrain starts flat and rises once its tiles have loaded (`data-map="idle"` on the city marks the basemap and terrain complete, and e2e screenshots wait for it).
Waterways that are not a chained stream take their network-nearest site, with the network distance as d.

**The quest.** One lamp that breathes on the map (warm light at night, an ink ring by day): the city's quest #1 (the nowcast ranks its quests by the expected fog reduction from one sample, counted over the warning hours whose result is back in time). One tap on it opens its stream straight onto the quest. The line asks "Sample <site> after rain" ("after rain" only when the quest's hour follows the forecast rain), with the sampling window from the nowcast in the place's zone and "Try a test reading"; a dated forecast says "Forecast of 2 Oct: " first. The rest view frames quest #1's lamp away from the screen's edges; a resize or a rotation goes straight to that framing, and a glide cut short by an early drag brings the lamp back once the viewer lets go, if it is off the screen.

**Names.** A site is shown by a readable name (`src/model/names.ts`): a trailing code in brackets is dropped ("Zwalm3 (Zw3)"), and a place joined to a sampling number names the place on its stream ("Zwalmbeek in Zwalm"; "Torrente Serretelle" when the stream's name holds the place); any other name is shown as the site record gives it. A stream title joined from several ways ("Ribeira de Bruscos - Ribeira de Condeixa") is shortened to the part its sites name ("Ribeira de Condeixa"), else the first; links keep the full name's slug.

**Test readings.** "Try a test reading" opens the kit: "Test reading at <site>", the hour it is assumed collected (the selected hour, with the place's zone), two answers ("900 or less", "Over 900") and the unit with "single-sample flag" once. An answer applies the reading to the site through the engine's update (`src/engine/fog.ts`). For 3 s the change spreads out from the sampled place and hour (the new chance and fog behind the front, the old ones ahead of it), and once it has passed the site the line on the curve says the reading itself ("Test reading · 900 or less · Fri 2 16:00 UTC+1"). The curve then shows "Before" (dashed) and "With test", with ticks for "Sample" and "Result +24 h" (the nowcast's lab turnaround). "Hold before" shows the state before the test while pressed; "Reset" takes the reading back. The reading stays in the model when the strip closes: its site's quest is done, opening that stream again shows the reading with "Hold before" and "Reset", and every other open quest can still be sampled. Nothing is a lab result.

**The person's sentence** (`src/model/humanSentence.ts`) is the open stream's first line, at its place (the tested site, else the quest's, else the middle one): the place, the day, the chance in words from the nowcast's thresholds ("usual", "higher", "high"; never "safe"), the reason ("after rain" when the 48-hour rain forecast before it reaches 1 mm, else "even without rain") and an action with a time: "Keep dogs out until <the first hour the chance is back at or under the higher threshold>" ("until the forecast ends <date>" when it never is), or "Usual chance today." when the forecast holds no raised hour. "Nobody has measured here after rain." follows when OneAquaHealth never sampled the place after rain (`oah_sampled_after_rain`). Example: "Eiras, from Monday 17:00: high chance after rain. Keep dogs out until Thursday 18:00." It is unit-tested on every real nowcast row. The curve and the strip under it are the why; the scrubbed hour's line and the test result's line stay in `sentence.ts`.

**The map's key** stands on the map itself, beside real places: "Each line is a stream." at a stream, "Brighter orange: higher chance the water is over the line." at the brightest line on screen, "Dots: nobody has measured here after rain." at the densest fog. Story mode shows it once (its `key` beat, with the map at the example reading's hour; the corner names that hour); in free exploration the quiet "?" at the top right ("What am I looking at?") brings it back, and it fades after nine seconds or when the map moves.

**Type.** Archivo (500 and 700, no italics) for every word and number people read; JetBrains Mono only for small chart labels and the x-ray's code; both self-hosted (`@fontsource`), with "Helvetica Neue", Helvetica, sans-serif as the fallback.

**The four lives** (`src/city/figures.ts`): child, adult, dog and heron in one ink silhouette style, each with three poses: at the water's edge engaged with it (usual), a step back upright (higher), far back and turned away (high). "Unknown" draws the figure crisp at its best-guess pose with mist around its feet and lower legs (the state word is in its label). The bank is one line, the water's edge, with footprints from the edge to where each figure stepped back to; the state colour is only the contact shadow and the footprints. The e2e suite checks in greyscale pixels that the three distances are distinct.

## Checks added for the app

- **Number provenance by data file.** An element with `data-src="<file>#<json pointer>"` (for example `streams/CO.json#/streams/2/length_km`, `nowcast_CO.json#/quests/2/name`) must show exactly that value: a number through `formatNumber` and `data-fmt`, a string as is. Canvas entries take `src` the same way.
- **Contrast.** `expectContrastAA(page)` checks every visible DOM text run against the theme ground (WCAG AA: 4.5:1, 3:1 for large text); a word mid-fade is marked `data-fading` and measured at full strength.
- **Cancelled tiles.** The map cancels tile requests that leave the view (`net::ERR_ABORTED`); those two tile hosts' cancellations are not errors, every other failed request still is.
- The e2e browser uses the GPU where there is one (`--use-angle=d3d11`); Chromium falls back to software GL elsewhere.
