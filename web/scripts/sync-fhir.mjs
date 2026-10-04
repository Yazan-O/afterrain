// Sayr's served FHIR resources: the ones the app's x-ray shows, with the validator's summary and an index.
//
//   node scripts/sync-fhir.mjs --export   (run by `npm run fhir` in sayr/fhir) selects Sayr's own resources from
//                                         sayr/fhir/fhir-static into the tracked folder sayr/fhir/served, then syncs
//   node scripts/sync-fhir.mjs            (npm run data) checks sayr/fhir/served against sayr/data/out and copies it
//                                         to public/data/fhir; the build needs no fhir-static, Java or validator
//   --warn-drift                          (npm run dev) reports a served folder built from another nowcast instead
//                                         of stopping
//
// Export selection: only Sayr's own resources. A resource must be in Sayr's transaction Bundle and must not be in
// the guide's (the guide's examples carry no confirmed licence and are never copied). Which resources: the Warleigh
// E. coli Observation and its Specimen for every replay sample, Warleigh Weir, every OneAquaHealth site Location,
// any ObservationHealthMeasureOah whose subject is such a site, and the proposed AlertOah Communication; then their
// dependency closure: every resource a selected one references ("Type/id"), and every resource those reference, so
// the published set is reusable on its own (its cohorts, model devices, organisations, datasets and the alert's
// supporting observation); attachment urls count as references, so the dataset Library brings its Binary and
// records. A reference into the guide's examples stops the export.
// index.json's siteRisk maps each OneAquaHealth site code to its risk Observation (one per site).
//
// The check (both modes): every file the index lists is present and nothing else is; every relative reference in a
// served resource resolves to a served resource; the validator summary has 0 errors and 0 fatal; and each site's
// risk Observation carries the value, fog, hour and forecast fetch time that data/out/nowcast_<city>.json gives for
// that site, so the x-ray cannot drift from the map.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fhir = resolve(here, '..', '..', 'fhir');
const out = resolve(here, '..', '..', 'data', 'out');
const served = join(fhir, 'served');
const dst = resolve(here, '..', 'public', 'data', 'fhir');
const args = new Set(process.argv.slice(2));

const fail = (msg) => {
  console.error(`sync-fhir: ${msg}`);
  process.exit(1);
};
const read = (p) => JSON.parse(readFileSync(p, 'utf-8'));
/** Every relative literal reference ("Type/id") anywhere in a resource: Reference.reference and Attachment.url (a
 * Library's content attachments point at its Binary and records this way). Absolute (canonical) urls never match. */
const REF = /^[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/;
function refsOf(node, out = new Set()) {
  if (Array.isArray(node)) for (const v of node) refsOf(v, out);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'reference' || k === 'url') && typeof v === 'string' && REF.test(v)) out.add(v);
      else refsOf(v, out);
    }
  return out;
}
const write = (p, obj) => writeFileSync(p, `${JSON.stringify(obj, null, 1)}\n`);

function exportServed() {
  const src = join(fhir, 'fhir-static');
  const summary = join(fhir, 'build', 'validate', 'sayr.summary.json');
  for (const p of [src, summary, join(src, '_bundles', 'sayr-transaction.json'), join(src, '_bundles', 'oah-transaction.json')])
    if (!existsSync(p)) fail(`${p} not found. Run \`npm run fhir\` in sayr/fhir first.`);

  const refsIn = (bundle) => new Set(read(join(src, '_bundles', bundle)).entry.map((e) => `${e.resource.resourceType}/${e.resource.id}`));
  const sayr = refsIn('sayr-transaction.json');
  const guide = refsIn('oah-transaction.json');

  const HEALTH = 'http://hl7.eu/fhir/ig/oah/StructureDefinition/observation-health-measure-oah';
  const SITE_CODE = 'https://yazan-o.github.io/sayr/fhir/sid/oah-site-code';
  const ALERT = 'https://yazan-o.github.io/sayr/fhir/StructureDefinition/alert-oah';
  const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/00Z$/, 'Z'); // 2024-09-24T08:10:00Z -> 20240924T0810Z

  const want = new Set(['Location/warleigh-weir']);
  for (const f of readdirSync(out).filter((n) => /^replay_.*\.json$/.test(n)))
    for (const s of read(join(out, f)).samples) {
      want.add(`Observation/warleigh-ecoli-${stamp(s.time_utc)}`);
      want.add(`Specimen/warleigh-water-${stamp(s.time_utc)}`);
    }
  for (const ref of sayr) if (ref.startsWith('Location/oah-site-')) want.add(ref);
  const healthMeasures = {};
  for (const ref of sayr) {
    const [type, id] = ref.split('/');
    if (type !== 'Observation' && type !== 'Communication') continue;
    const r = read(join(src, type, `${id}.json`));
    const profiles = r.meta?.profile ?? [];
    const subject = r.subject?.reference ?? '';
    if (type === 'Observation' && profiles.includes(HEALTH) && subject.startsWith('Location/oah-site-')) {
      want.add(ref);
      (healthMeasures[subject] ??= []).push(ref);
    }
    if (type === 'Communication' && profiles.includes(ALERT)) want.add(ref);
  }

  // the dependency closure of the selection, inside Sayr's own Bundle
  const queue = [...want].filter((r) => sayr.has(r));
  while (queue.length) {
    const ref = queue.pop();
    const [type, id] = ref.split('/');
    for (const dep of refsOf(read(join(src, type, `${id}.json`)))) {
      if (want.has(dep)) continue;
      if (guide.has(dep)) fail(`${ref} references ${dep}, one of the guide's examples; it must not be copied`);
      if (!sayr.has(dep)) fail(`${ref} references ${dep}, which is not in Sayr's Bundle`);
      want.add(dep);
      queue.push(dep);
    }
  }

  rmSync(served, { recursive: true, force: true });
  const copied = [];
  for (const ref of [...want].sort()) {
    if (guide.has(ref)) fail(`${ref} is one of the guide's examples; it must not be copied`);
    if (!sayr.has(ref)) continue; // a replay sample outside the backtest has no resource
    const [type, id] = ref.split('/');
    const from = join(src, type, `${id}.json`);
    if (!existsSync(from)) fail(`${from} is in Sayr's Bundle but not in fhir-static`);
    mkdirSync(join(served, type), { recursive: true });
    copyFileSync(from, join(served, type, `${id}.json`));
    copied.push(ref);
  }
  copyFileSync(summary, join(served, 'sayr.summary.json'));
  const alerts = copied.filter((r) => r.startsWith('Communication/'));
  const siteRisk = {};
  for (const [subject, refs] of Object.entries(healthMeasures)) {
    const code = read(join(src, `${subject}.json`)).identifier?.find((i) => i.system === SITE_CODE)?.value;
    if (!code) fail(`${subject} has no OneAquaHealth site code`);
    if (refs.length !== 1) fail(`${subject} has ${refs.length} risk resources; the index expects one`);
    siteRisk[code] = refs[0];
  }
  write(join(served, 'index.json'), { source: 'sayr/fhir/served', validation: 'sayr.summary.json', resources: copied, healthMeasures, siteRisk, alerts });
  console.log(`sync-fhir: exported ${copied.length} of Sayr's resources and the validator summary -> ${served}`);
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile())
    .map((p) => relative(dir, p).split('\\').join('/'))
    .sort();
}

function check() {
  const indexPath = join(served, 'index.json');
  if (!existsSync(indexPath)) fail(`${indexPath} not found. Run \`npm run fhir\` in sayr/fhir, which exports it.`);
  const index = read(indexPath);
  const expected = [...index.resources.map((r) => `${r}.json`), 'index.json', 'sayr.summary.json'].sort();
  const actual = listFiles(served);
  const missing = expected.filter((f) => !actual.includes(f));
  const extra = actual.filter((f) => !expected.includes(f));
  if (missing.length || extra.length) fail(`fhir/served does not match its index: missing ${missing.slice(0, 5)}; not indexed ${extra.slice(0, 5)}`);
  const summary = read(join(served, 'sayr.summary.json'));
  if (summary.counts?.error !== 0 || summary.counts?.fatal !== 0) fail('the validator summary in fhir/served reports errors');
  if (!index.resources.includes('Location/warleigh-weir') || index.alerts.length === 0) fail('Warleigh Weir or the alert is missing from fhir/served');
  // a published resource never points at one that is not published
  const have = new Set(index.resources);
  const dangling = [];
  for (const ref of index.resources) for (const dep of refsOf(read(join(served, `${ref}.json`)))) if (!have.has(dep)) dangling.push(`${ref} -> ${dep}`);
  if (dangling.length) fail(`fhir/served has ${dangling.length} references to resources it does not serve (first: ${dangling[0]}). Run \`npm run fhir\` in sayr/fhir.`);

  // Drift: each site's risk Observation against the nowcast the map draws (generate.py's rule: the first hour of the
  // highest median, its fog, and the forecast fetch time in the note).
  const drift = [];
  let sites = 0;
  for (const f of readdirSync(out).filter((n) => /^nowcast_[A-Z]+\.json$/.test(n)).sort()) {
    const pk = read(join(out, f));
    for (const site of pk.sites) {
      sites += 1;
      const ref = index.siteRisk[site.code];
      if (!ref) {
        drift.push(`${site.code}: no risk Observation`);
        continue;
      }
      const obs = read(join(served, `${ref}.json`));
      let i = -1;
      site.p50.forEach((x, k) => {
        if (x !== null && (i < 0 || x > site.p50[i])) i = k;
      });
      const fog = obs.component?.find((c) => c.code.coding.some((x) => x.code === 'fog'))?.valueQuantity?.value;
      const note = (obs.note ?? []).map((n) => n.text).join(' ');
      if (i < 0) drift.push(`${site.code}: no forecast hour in ${f}`);
      else if (!(Math.abs(obs.valueQuantity?.value - site.p50[i]) <= 1e-9)) drift.push(`${site.code}: value ${obs.valueQuantity.value}, nowcast ${site.p50[i]}`);
      else if (!(Math.abs(fog - site.fog[i]) <= 1e-9)) drift.push(`${site.code}: fog ${fog}, nowcast ${site.fog[i]}`);
      else if (Date.parse(obs.effectiveDateTime) !== Date.parse(pk.hours_utc[i])) drift.push(`${site.code}: hour ${obs.effectiveDateTime}, nowcast ${pk.hours_utc[i]}`);
      else if (!note.includes(`Forecast fetched ${pk.forecast_fetched_utc};`)) drift.push(`${site.code}: fetched ${note.match(/Forecast fetched (\S+);/)?.[1]}, nowcast ${pk.forecast_fetched_utc}`);
    }
  }
  if (Object.keys(index.siteRisk).length !== sites) drift.push(`${Object.keys(index.siteRisk).length} site risk resources for ${sites} nowcast sites`);
  if (drift.length) {
    const msg = `fhir/served was built from another nowcast than data/out (${drift.length} sites differ; first: ${drift[0]}). Run \`npm run fhir\` in sayr/fhir.`;
    if (!args.has('--warn-drift')) fail(msg);
    console.warn(`sync-fhir: WARNING ${msg}`);
  }
  return { index, sites, drift: drift.length };
}

if (args.has('--export')) exportServed();
const { index, sites, drift } = check();
rmSync(dst, { recursive: true, force: true });
cpSync(served, dst, { recursive: true });
console.log(`sync-fhir: ${index.resources.length} resources, the validator summary and ${sites} site risks ${drift ? `(${drift} drifted)` : 'matching the nowcast'} -> ${dst}`);
