// Headless check: runs several seeds of both worlds (private and co-op), asserts the accounting identities hold
// every tick, and prints a summary of each world.
//   node test/run.js [ticks] [seeds]
const { World, CoopWorld, CentralBankWorld, moodWord } = require('../sim.js');

const ticks = +process.argv[2] || 1500;
const seeds = +process.argv[3] || 3;
let failed = false;

for (const [model, Ctor] of [['private', World], ['coop', CoopWorld], ['cb', CentralBankWorld]]) for (let seed = 1; seed <= seeds; seed++) {
  const w = new Ctor({ seed });
  const t0 = Date.now();
  for (let i = 0; i < ticks; i++) {
    w.step();
    const bad = w.audit();
    // The mood shares must count exactly the entities whose mood word says so.
    const words = w.ents.map(e => moodWord(e.mood)), share = list => words.filter(x => list.includes(x)).length / w.n;
    if (Math.abs(w.last.uneasy - share(['Uneasy', 'Struggling', 'Desperate'])) > 1e-12) bad.push(`uneasy share ${w.last.uneasy} does not match mood words`);
    if (Math.abs(w.last.low - share(['Struggling', 'Desperate'])) > 1e-12) bad.push(`struggling share ${w.last.low} does not match mood words`);
    if (bad.length) { console.error(`${model} seed ${seed} tick ${w.t}:`, bad.slice(0, 3)); failed = true; break; }
    if (i % Math.ceil(ticks / 6) === 0 || i === ticks - 1) {
      const L = w.last, f = (v, d = 2) => v.toFixed(d);
      console.log(
        `${model.padEnd(7)} s${seed} t${String(L.t).padStart(5)} gdp ${f(L.gdp, 0).padStart(5)} unemp ${f(L.unemp * 100, 0).padStart(3)}% hungry ${f(L.hungry * 100, 0).padStart(3)}%` +
        ` biz ${L.bizFood}/${L.bizGoods}/${L.bizServ} staff ${L.staff} px ${f(L.pxFood)}/${f(L.pxGoods)}/${f(L.pxServ)}` +
        ` fx ${L.fxP10.toExponential(1)}|${f(L.fxMed, 3)}|${f(L.fxP90, 2)} cap ${f(L.cap, 0)} debt ${f(L.debt, 0)} yld ${f(L.yieldMed * 100, 1)}%` +
        ` bonds ${L.bonds} pool ${f(L.poolShare * 100, 0)}% $ize ${f(L.dollar * 100, 0)}% ref ${L.reforms} gini ${f(L.giniCons)}`
      );
    }
  }
  console.log(`${model} seed ${seed}: ${ticks} ticks in ${Date.now() - t0} ms\n`);
}
if (failed) process.exit(1);
console.log('accounting identities held on every tick');
