// Save-file check: a world saved at tick A, written to JSON, read back and run
// on must match the original run tick for tick. Also checks summary saves.
//   node test/save.js [seeds]
const { World, CoopWorld } = require('../sim.js');

const seeds = +process.argv[2] || 3;
let failed = false;
const fail = msg => { console.error('FAIL', msg); failed = true; };

for (const [model, Ctor] of [['private', World], ['coop', CoopWorld]]) for (let seed = 1; seed <= seeds; seed++) {
  const a = new Ctor({ seed });
  for (let i = 0; i < 400; i++) a.step();
  a.setParam('fiatMult', 3);                 // a mid-run change must survive the round trip
  for (let i = 0; i < 200; i++) a.step();

  const t0 = Date.now();
  const text = JSON.stringify(a.save());
  const b = World.restore(text);
  if (b.model !== model || !(b instanceof Ctor)) fail(`${model} seed ${seed}: loaded as ${b.model}`);
  const ms = Date.now() - t0;
  if (b.fingerprint() !== a.fingerprint()) fail(`${model} seed ${seed}: fingerprint differs right after loading`);

  for (let i = 0; i < 500; i++) {
    if (i === 150) { a.setParam('fiatMult', 0.5); b.setParam('fiatMult', 0.5); }
    a.step(); b.step();
    if (a.fingerprint() !== b.fingerprint()) { fail(`${model} seed ${seed}: runs diverge at tick ${a.t}`); break; }
    const bad = b.audit();
    if (bad.length) { fail(`${model} seed ${seed}: loaded world breaks accounting at tick ${b.t}: ${bad[0]}`); break; }
  }
  // A save of the loaded run carries on the original's history.
  const sa = a.save(), sb = b.save();
  if (sa.world.rows.length !== sb.world.rows.length || sa.activity.rows.length !== sb.activity.rows.length || sa.diaries.rows.length !== sb.diaries.rows.length)
    fail(`${model} seed ${seed}: history lengths differ after loading (${sa.world.rows.length}/${sb.world.rows.length} world rows)`);
  if (JSON.stringify(sa.digest) !== JSON.stringify(sb.digest)) fail(`${model} seed ${seed}: digests differ after loading`);
  if (JSON.stringify(sa.run.controls) !== JSON.stringify([[400, 'fiatMult', 3], [750, 'fiatMult', 0.5]])) fail(`${model} seed ${seed}: control log is ${JSON.stringify(sa.run.controls)}`);

  const summary = JSON.stringify(a.save({ full: false }));
  let refused = false;
  try { World.restore(summary); } catch (e) { refused = /summary/.test(e.message); }
  if (!refused) fail(`${model} seed ${seed}: a summary save was not refused on load`);

  console.log(`${model} seed ${seed}: tick ${a.t}, full save ${(text.length / 1e6).toFixed(2)} MB (write + load ${ms} ms), summary ${(summary.length / 1e3).toFixed(0)} kB, ` +
    `${sa.activity.rows.length} activity rows, ${sa.diaries.rows.length} diary entries, fingerprint ${a.fingerprint()}`);
}
if (failed) process.exit(1);
console.log('loaded runs matched the originals on every tick');
