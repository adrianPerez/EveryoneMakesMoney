#!/usr/bin/env node
// Run a world headless and write a save file, or continue one from a save.
//
//   node tools/save.js --seed 7 --ticks 2000
//   node tools/save.js --seed 7 --ticks 3000 --fiat 1 --schedule 1000:4,1600:1
//   node tools/save.js --from saves/seed-7-t2000.json --ticks 500 --summary
//
// Options
//   --seed N        world seed (default 1); ignored with --from
//   --ticks N       ticks to run (default 2000; with --from, ticks to add)
//   --fiat X        printing appetite from the start (default 1)
//   --schedule L    settings changes as tick:value pairs for printing appetite, e.g. 800:4,1200:1
//   --every N       ticks between entity snapshots (default 20)
//   --from FILE     load a full save and continue it
//   --summary       write the short summary instead of a full save
//   --out FILE      where to write (default saves/seed-<seed>-t<tick>[-summary].json)
const fs = require('fs');
const path = require('path');
const { World } = require('../sim.js');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) { console.error(`Unexpected argument: ${a}`); process.exit(2); }
  const k = a.slice(2), next = process.argv[i + 1];
  if (k === 'summary') args.summary = true;
  else if (next === undefined || next.startsWith('--')) { console.error(`--${k} needs a value`); process.exit(2); }
  else { args[k] = next; i++; }
}

let w;
if (args.from) {
  w = World.restore(fs.readFileSync(args.from, 'utf8'));
  console.log(`Loaded ${args.from} at tick ${w.t} (seed ${w.P.seed}).`);
} else {
  w = new World({ seed: +(args.seed || 1), fiatMult: +(args.fiat || 1), snapEvery: +(args.every || 20) });
}

const schedule = new Map();
for (const part of (args.schedule || '').split(',').filter(Boolean)) {
  const [t, v] = part.split(':').map(Number);
  if (!isFinite(t) || !isFinite(v)) { console.error(`Bad --schedule entry: ${part}`); process.exit(2); }
  schedule.set(t, v);
}

const ticks = +(args.ticks || 2000), end = w.t + ticks, t0 = Date.now();
while (w.t < end) {
  if (schedule.has(w.t)) w.setParam('fiatMult', schedule.get(w.t));
  w.step();
}
const bad = w.audit();
if (bad.length) console.warn('Accounting check failed:', bad[0]);

const save = w.save({ full: !args.summary });
const out = args.out || path.join('saves', `seed-${w.P.seed}-t${w.t}${args.summary ? '-summary' : ''}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const text = JSON.stringify(save);
fs.writeFileSync(out, text);

console.log(`Ran ${ticks} ticks in ${((Date.now() - t0) / 1000).toFixed(1)} s. Wrote ${out} (${(text.length / 1e6).toFixed(2)} MB, ${save.kind}).`);
console.log('');
for (const line of save.digest.headline) console.log('  ' + line);
