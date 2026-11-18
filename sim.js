/*
 * Everyone Makes Money — simulation engine.
 *
 * 100 entities. Each one is its own central bank: it issues its own fiat
 * currency, spends by minting it, and retires it when it is paid in it.
 * Each can also sell bonds (which pull its currency out of circulation now
 * and create more of it at maturity). All currencies trade against one
 * fixed-supply exchange currency, X, through a liquidity pool per currency.
 *
 * No DOM access here, so the engine runs the same in a browser and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SECTORS = ['Food', 'Goods', 'Services'];
  const NS = SECTORS.length;
  const TECH = [4.2, 3.2, 3.6];          // output per unit of effective labour
  const KEEP = [0.8, 0.97, 0.5];         // share of unsold stock that survives a tick
  const WANT = [1, 3, 3];                // units an entity would like per tick
  const POOL0 = 1000;                    // starting pool depth, both sides
  const X0 = 100;                        // starting X per entity
  const REFORM_AT = 1e-6;                // currency is redenominated below this rate
  const REFORM_F = 1e6;
  const MAX_STAFF = 14;
  const YIELD_WALK = 0.6;                // issuers stop selling bonds above this yield per term

  const SAVE_FORMAT = 'everyone-makes-money/save';
  const SAVE_VERSION = 1;

  /** mulberry32, with its state kept on `w.rs` so a save can carry it. */
  function rngOf(w) {
    return function () {
      let a = (w.rs | 0); a = (a + 0x6d2b79f5) | 0; w.rs = a;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SYL_A = ['Va', 'Ke', 'Mo', 'Ti', 'Su', 'Ra', 'Bel', 'Or', 'Zan', 'Li', 'Dre', 'Fa', 'Gu', 'Ha', 'Is', 'Jo', 'Nu', 'Pe', 'Qui', 'Wy', 'Yo', 'Cal', 'Em', 'Ash', 'Tor'];
  const SYL_B = ['ro', 'lm', 'ra', 'ven', 'ki', 'dor', 'la', 'mund', 'sa', 'th', 'rin', 'bo', 'nia', 'x', 'vi', 'gan', 'lo', 'mer', 'ta', 'wen', 'zu', 'pha', 'ne', 'dil', 'ko'];

  function gini(vals) {
    const a = Array.from(vals, v => Math.max(0, v)).sort((p, q) => p - q);
    const n = a.length; let sum = 0, acc = 0;
    for (let i = 0; i < n; i++) { sum += a[i]; acc += (i + 1) * a[i]; }
    if (sum <= 0) return 0;
    return (2 * acc) / (n * sum) - (n + 1) / n;
  }
  function quantile(sorted, q) {
    const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }

  class World {
    constructor(params) {
      this.P = Object.assign({ seed: 1, n: 100, fiatMult: 1, term: 30 }, params || {});
      this.model = this.modelName();
      const P = this.P, n = P.n;
      this.rs = (P.seed * 7919 + 13) | 0;
      this.rand = rngOf(this);
      this.n = n;
      this.t = 0;
      this.ents = [];
      this.pools = [];
      this.biz = [];            // all businesses ever; closed ones have alive=false
      this.live = [];           // live businesses
      this.bySector = [[], [], []];
      this.bondsDue = new Map();// due tick -> bonds
      this.bondCount = 0;
      this.events = [];
      this.voices = [];         // recent diary entries from anyone
      this.sectorPX = [1, 1, 1];      // sales-weighted price in X, smoothed
      this.sectorWageX = [1.2, 1.2, 1.2];
      this.unmet = [0, 0, 0];
      this.soldEMA = [1, 1, 1];
      this.unmetEMA = [0, 0, 0];
      this.reforms = 0;
      this.tk = null;           // per-tick counters
      this.hist = { stride: 1, t: [] };
      this.last = {};
      this.rec = newRec(P.snapEvery || 20);

      const used = new Set(), usedNames = new Set();
      for (let i = 0; i < n; i++) {
        let name;
        do { name = SYL_A[(this.rand() * SYL_A.length) | 0] + SYL_B[(this.rand() * SYL_B.length) | 0]; } while (usedNames.has(name));
        usedNames.add(name);
        const up = name.toUpperCase().replace(/[^A-Z]/g, '');
        let code = up.slice(0, 3), k = 0;
        while (used.has(code) || code.length < 3) {
          code = up[0] + (up[1 + (k % (up.length - 1))] || 'A') + String.fromCharCode(65 + ((k * 7 + i) % 26)); k++;
        }
        used.add(code);
        const r = this.rand;
        const skill = [0, 0, 0].map(() => 0.5 + 1.5 * Math.pow(r(), 1.4));
        const hawk = r();       // 0 = dove, 1 = hawk
        this.ents.push({
          id: i, name, code, skill, hawk,
          dove: 0.0001 + 0.004 * Math.pow(1 - hawk, 2.2) * (0.5 + r()),   // baseline money growth per tick
          tol: 0.00005 + 0.003 * Math.pow(1 - hawk, 2.5),                  // depreciation per tick it will tolerate
          bondPref: Math.min(1, Math.max(0, 0.15 + 0.7 * hawk + 0.3 * (r() - 0.5))),
          thrift: r(), entre: r(), appetite: 0.4 + 0.6 * r(), liq: 0.15 + 0.35 * r(),
          pref: 0.3 + 0.4 * r(),   // share of discretionary spend going to goods (rest services)
          x: X0, hold: new Float64Array(n), buffer: 0,
          supply: POOL0, stance: 0, tight: false, yield: 0.02 + 0.03 * r(), offer: 0, offerLeft: 0, offerSold: 0,
          employer: -1, biz: [], idle: 0,
          lastFx: 1, dep: 0, redenom: 1, reforms: 0,
          mintTick: 0, burnTick: 0, mintXTick: 0, mintEMA: 0, burnEMA: 0, seignX: 0, mintedTotalX: 0,
          incTick: 0, incEMA: 1, consTick: 0, consEMA: 0, welfare: 0.5, hungry: 0, ate: [0, 0, 0],
          bondsOut: 0, bondsHeldX: 0, interestPaid: 0,
          fxHist: new Float32Array(160).fill(1), supply0: POOL0, growth: 0, depLong: 0,
          feel: { fed: 0.6, comfort: 0.3, security: 0.6, purpose: 0.5, pride: 0.5, standing: 0.5 },
          level: 0.5, usedTo: 0.5, mood: 0.5, moodHist: [], diary: [], said: {}, wasHungry: 0, wasTight: false, hungerRun: 0,
        });
        this.ents[i].months = 10 + 30 * this.ents[i].thrift;   // ticks of spending it likes to hold in X
        this.ents[i].buffer = 2 * this.ents[i].months;
        this.ents[i].stance = this.ents[i].dove * P.fiatMult;
        this.pools.push({ c: POOL0, x: POOL0 });
      }
      this.totalX = n * (POOL0 + X0);

      this.seedFirms();
      this.record();
    }

    /* ---------- the firm model: these methods are what the cooperative world overrides ---------- */
    modelName() { return 'private'; }
    /** Seed economy: the most skilled entities in each sector open shop. */
    seedFirms() {
      for (const [g, e] of this.seedFounders()) this.found(e, g, true);
    }
    seedFounders() {
      const quota = [14, 9, 9], taken = new Set(), out = [];
      for (let g = 0; g < NS; g++) {
        const order = this.ents.slice().sort((a, b) => b.skill[g] - a.skill[g]);
        let q = quota[g];
        for (const e of order) { if (!q) break; if (taken.has(e.id)) continue; taken.add(e.id); out.push([g, e]); q--; }
      }
      return out;
    }
    /** Where an entity works: whether it has work, owns a firm, how many people it works with, and what that does for its sense of purpose. */
    workInfo(e) {
      const staff = e.biz.reduce((s, id) => s + this.biz[id].staff.length, 0);
      return {
        working: e.employer >= 0 || e.biz.length > 0, owner: e.biz.length > 0, staff,
        job: e.biz.length ? -1 : e.employer >= 0 ? this.biz[e.employer].owner : -2,
        purpose: e.biz.length ? (staff ? Math.min(1, 0.85 + 0.03 * staff) : 0.75) : e.employer >= 0 ? 0.6 : Math.max(0, 0.35 - 0.02 * e.idle),
      };
    }
    firmSize(b) { return b.staff.length; }
    /** Price in X of one unit. */
    fullPX(b) { return b.price * this.fx(b.owner); }
    /** Price in X as buyer j sees it when choosing a seller. */
    selPX(b, j) { const px = this.fullPX(b); return b.owner === j ? px * 0.7 : px; }
    /** Buyer j pays for q units from firm b. Returns [X value paid, units delivered], or null if j cannot pay. */
    payFor(j, b, q) {
      const px = this.fullPX(b);
      if (b.owner === j) return [q * px, q];                    // eating from your own shelf
      let paid = this.settle(j, b.owner, q * b.price);
      if (paid < 0) { q *= 0.4; if (q < 0.02) return null; paid = this.settle(j, b.owner, q * b.price); if (paid < 0) return null; }
      b.rev += q * b.price;
      return [paid, q];
    }
    payStaff(b) {
      const o = this.ents[b.owner], g = b.sector, fx = this.fx(o.id);
      for (const w of b.staff) {
        const we = this.ents[w], pay = b.wage * we.skill[g];
        we.hold[o.id] += pay; this.mint(o, pay); b.wages += pay;
        const v = pay * fx; we.incTick += v; this.tk.wagesX += v;
      }
    }
    firmRow(b) { return [b.id, b.owner, SECTORS[b.sector], b.born, b.alive ? null : (b.closed || null), b.alive ? b.staff.length : 0, r4(b.salesEMA)]; }
    bigFirms() {
      return this.ents.map(e => [e, this.workInfo(e).staff]).filter(x => x[1] && x[0].biz.length).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, s]) => `${e.name} (${e.code}) ${s} staff`);
    }

    /* ---------- money primitives ---------- */
    fx(i) { const p = this.pools[i]; return p.x / p.c; }
    mint(e, amt) { e.supply += amt; e.mintTick += amt; }
    burn(e, amt) { e.supply -= amt; e.burnTick += amt; }

    /** Entity j mints its own currency and sells it for xOut of X. Returns false if the pool can't bear it. */
    mintForX(j, xOut) {
      const e = this.ents[j], p = this.pools[j];
      if (e.mintXTick + xOut > 0.08 * p.x) return false;
      const amt = (p.c * xOut) / (p.x - xOut);
      p.c += amt; p.x -= xOut;
      this.mint(e, amt);
      e.mintXTick += xOut; e.seignX += xOut;
      this.tk.fxVol += xOut; this.tk.seign += xOut;
      return true;
    }

    /** Buyer j pays `amt` of seller s's currency to s. Returns X value paid, or -1 if j cannot pay. */
    settle(j, s, amt) {
      const b = this.ents[j], sl = this.ents[s], ps = this.pools[s];
      const use = Math.min(b.hold[s], amt), rem = amt - use;
      let xNeed = 0, direct = false;
      if (rem > 1e-12) {
        if (rem < 0.2 * ps.c) xNeed = (ps.x * rem) / (ps.c - rem);
        else { xNeed = rem * (ps.x / ps.c); direct = true; }   // pool too thin: seller takes X directly
        let fromRes = Math.min(Math.max(0, b.x - b.buffer), xNeed), mintX = xNeed - fromRes;
        if (mintX > 1e-12 && b.mintXTick + mintX > 0.08 * this.pools[j].x) {
          const extra = Math.min(b.x - fromRes, mintX); fromRes += extra; mintX -= extra;
          if (mintX > 1e-9) return -1;
          mintX = 0;
        }
        if (mintX > 1e-12 && !this.mintForX(j, mintX)) return -1;
        b.x -= fromRes;
        if (direct) { sl.x += xNeed; this.tk.dollar += xNeed; }
        else { ps.x += xNeed; ps.c -= rem; this.burn(sl, rem); this.tk.fxVol += xNeed; }
      }
      if (use > 0) { b.hold[s] -= use; this.burn(sl, use); }
      return use * (ps.x / ps.c) + xNeed;
    }

    /* ---------- businesses ---------- */
    found(e, g, seed) {
      const fx = this.fx(e.id);
      const b = {
        id: this.biz.length, owner: e.id, sector: g, alive: true, born: this.t,
        price: this.sectorPX[g] / fx, wage: (this.sectorWageX[g] * 0.9) / fx,
        staff: [], inv: 0, K: 0, setup: seed ? 0 : 3,
        q: 0, sold: 0, rev: 0, wages: 0, salesEMA: 0, revEMA: 0, so: 0.5, vacancy: 0, noSales: 0, profitEMA: 0,
      };
      this.biz.push(b); this.live.push(b); e.biz.push(b.id);
      if (e.employer >= 0) this.leave(e);
      this.act('found', e.id, g, b.id);
      if (!seed) {
        this.log('found', e.id, `${e.name} opened a ${SECTORS[g]} business priced in ${e.code}`);
        this.note(e, 1, `Opened a ${SECTORS[g].toLowerCase()} business. I set my prices in ${e.code}, money I make myself. Now I need people to want it.`);
      }
      return b;
    }
    leave(e) {
      const b = this.biz[e.employer];
      if (b) { const k = b.staff.indexOf(e.id); if (k >= 0) b.staff.splice(k, 1); }
      e.employer = -1;
    }
    close(b, why) {
      b.alive = false; b.closed = this.t;
      const o = this.ents[b.owner];
      this.act('close', o.id, b.sector, why);
      for (const w of b.staff) { this.ents[w].employer = -1; this.act('jobloss', w, o.id, b.id); this.note(this.ents[w], -1, `${o.name}'s business shut and took my job with it.`); }
      b.staff = [];
      this.note(o, why === 'owner took a job' ? 0 : -1, why === 'owner took a job' ? `Closed my ${SECTORS[b.sector].toLowerCase()} business. A wage from someone else pays better than being my own boss.` : `My ${SECTORS[b.sector].toLowerCase()} business is gone: ${why}.`);
      o.biz = o.biz.filter(id => id !== b.id);
      this.log('close', o.id, `${o.name}'s ${SECTORS[b.sector]} business closed (${why})`);
    }
    worksOwn(e) { return e.employer < 0 && e.biz.length > 0; }
    leff(b) {
      let L = 0; const g = b.sector;
      for (const w of b.staff) L += this.ents[w].skill[g];
      const o = this.ents[b.owner];
      if (o.employer < 0 && o.biz[0] === b.id) L += o.skill[g];
      return L;
    }
    /** X a worker would actually get by selling one tick's pay into the pool. */
    jobValue(b, w) {
      const amt = b.wage * w.skill[b.sector], p = this.pools[b.owner];
      return (p.x * amt) / (p.c + amt);
    }

    log(type, ent, text) {
      this.events.push({ t: this.t, type, ent, text });
      if (this.events.length > 300) this.events.splice(0, 100);
    }

    /* ---------- one tick ---------- */
    step() {
      const E = this.ents, n = this.n, r = this.rand;
      this.t++;
      this.tk = { gdp: 0, units: [0, 0, 0], val: [0, 0, 0], fxVol: 0, seign: 0, dollar: 0, bondSold: 0, interest: 0, wagesX: 0, intervene: 0 };
      this.unmet = [0, 0, 0];
      for (const e of E) { e.mintTick = 0; e.burnTick = 0; e.mintXTick = 0; e.incTick = 0; e.consTick = 0; e.ate = [0, 0, 0]; }

      this.policy();
      this.produce();
      this.consume();
      this.manage();
      this.labour();
      this.bonds();
      this.portfolio();
      this.reform();
      this.record();
    }

    policy() {
      for (const e of this.ents) {
        const p = this.pools[e.id], fx = p.x / p.c;
        const d = Math.log(fx / e.lastFx); e.lastFx = fx;
        e.dep = e.dep * 0.93 + d * 0.07;
        e.depLong = e.depLong * 0.99 + d * 0.01;
        const target = e.dove * this.P.fiatMult;
        if (e.dep < -e.tol) { e.stance *= 0.85; e.tight = true; }                       // sliding: tighten
        else if (e.dep > e.tol) { e.stance = Math.min(0.03, e.stance * 1.08 + 0.0002); e.tight = false; }  // too strong: ease
        else { e.stance += 0.05 * (target - e.stance); e.tight = false; }
        // Defend the currency with reserves when it is sliding.
        if (e.dep < -e.tol * 0.5 && e.x > e.buffer + 1) {
          const spend = 0.1 * (e.x - e.buffer);
          const got = (p.c * spend) / (p.x + spend);
          p.x += spend; p.c -= got; e.x -= spend; this.burn(e, got);
          this.tk.fxVol += spend; this.tk.intervene += spend;
        }
        // Bonds: sterilise a share of new money, more when tightening. Issuers walk away from ruinous yields.
        e.offer = e.yield > YIELD_WALK ? 0 : e.bondPref * e.mintEMA + (e.tight ? 0.003 * e.supply : 0);
        if (e.yield > YIELD_WALK) e.yield *= 0.995;
        e.offerLeft = e.offer; e.offerSold = 0;
      }
    }

    produce() {
      for (const b of this.live) {
        b.sold = 0; b.rev = 0; b.wages = 0; b.q = 0;
        if (b.setup > 0) { b.setup--; continue; }
        const L = this.leff(b), g = b.sector;
        b.q = L > 0 ? TECH[g] * Math.pow(L, 0.75) * Math.pow(1 + b.K, 0.2) : 0;
        b.inv += b.q;
        b.K *= 0.995;
        this.payStaff(b);
      }
      for (let g = 0; g < NS; g++) this.bySector[g] = this.live.filter(b => b.sector === g && b.inv > 0.01);
    }

    /** Entity j tries to buy up to qty of sector g with budget (in X). Returns X spent. */
    buy(j, g, qty, budget) {
      const e = this.ents[j], list = this.bySector[g], r = this.rand;
      let spent = 0, got = 0;
      for (let attempt = 0; attempt < 3 && qty > 0.02 && budget > 1e-6; attempt++) {
        let best = null, bestPx = Infinity;
        const m = Math.min(6, list.length);
        for (let k = 0; k < m; k++) {
          const b = list[(r() * list.length) | 0];
          if (b.inv < 0.02) continue;
          const px = this.selPX(b, j);
          if (px < bestPx) { bestPx = px; best = b; }
        }
        if (!best) break;
        const px = this.fullPX(best);
        let q = Math.min(qty, best.inv, budget / px);
        if (q < 0.02) break;
        const res = this.payFor(j, best, q);
        if (!res) break;
        const paid = res[0]; q = res[1];
        best.inv -= q; best.sold += q;
        qty -= q; got += q; budget -= paid; spent += paid;
        this.tk.gdp += q * px; this.tk.units[g] += q; this.tk.val[g] += q * px;
      }
      if (qty > 0.02 && budget > 1e-6) this.unmet[g] += qty;
      this._got = got;
      return spent;
    }

    consume() {
      const E = this.ents, n = this.n, r = this.rand;
      const order = E.map(e => e.id);
      for (let i = n - 1; i > 0; i--) { const k = (r() * (i + 1)) | 0; const t = order[i]; order[i] = order[k]; order[k] = t; }
      for (const id of order) {
        const e = E[id], fx = this.fx(id);
        // Spend income, plus fiat, plus (or minus) a step toward the X reserve it wants to hold.
        e.buffer = e.months * Math.max(0.5 * this.sectorPX[0], e.consEMA);
        let budget = Math.max(0, e.incEMA) + 0.1 * (e.x - e.buffer) + e.stance * e.supply * fx;
        budget = Math.max(budget, 1.3 * this.sectorPX[0]);   // will always try to eat
        let s = this.buy(id, 0, WANT[0], budget); e.ate[0] = this._got; budget -= s; e.consTick += s;
        if (budget > 0) {
          const bg = budget * e.pref;
          s = this.buy(id, 1, WANT[1] * e.appetite, bg); e.ate[1] = this._got; e.consTick += s;
          s = this.buy(id, 2, WANT[2] * e.appetite, budget - s); e.ate[2] = this._got; e.consTick += s;
        }
        const w = 0.5 * Math.min(1, e.ate[0]) + 0.25 * Math.min(1, e.ate[1] / (WANT[1] * e.appetite)) + 0.25 * Math.min(1, e.ate[2] / (WANT[2] * e.appetite));
        e.welfare = e.welfare * 0.9 + w * 0.1;
        e.hungry = e.ate[0] < 0.6 ? 1 : 0;
      }
    }

    manage() {
      for (const b of this.live.slice()) this.manageFirm(b);
      this.live = this.live.filter(b => b.alive);
      for (let g = 0; g < NS; g++) {
        if (this.tk.units[g] > 0.5) this.sectorPX[g] = this.sectorPX[g] * 0.9 + (this.tk.val[g] / this.tk.units[g]) * 0.1;
        this.soldEMA[g] = this.soldEMA[g] * 0.9 + this.tk.units[g] * 0.1;
        this.unmetEMA[g] = this.unmetEMA[g] * 0.9 + this.unmet[g] * 0.1;
      }
    }

    manageFirm(b) {
      const r = this.rand;
      {
        const o = this.ents[b.owner], g = b.sector, fx = this.fx(o.id);
        const profit = b.rev - b.wages;
        o.incTick += profit * fx;
        b.salesEMA = b.salesEMA * 0.85 + b.sold * 0.15;
        b.revEMA = b.revEMA * 0.85 + b.rev * 0.15;
        b.profitEMA = b.profitEMA * 0.9 + profit * fx * 0.1;
        if (b.setup > 0) return;
        const soldOut = b.inv < 0.1 * b.q + 0.02;
        b.so = b.so * 0.8 + (soldOut ? 0.2 : 0);
        b.noSales = b.sold > 0.02 ? 0 : b.noSales + 1;
        // price
        if (soldOut) b.price *= 1.03;
        else if (b.inv > 2 * (b.salesEMA + 0.2)) b.price *= 0.97;
        else if (b.inv > b.salesEMA + 0.2) b.price *= 0.99;
        if (b.staff.length && b.q > 0) b.price = Math.max(b.price, (0.7 * b.wages) / b.q);
        // labour demand
        const L = this.leff(b);
        const mv = L > 0 ? ((0.75 * b.q) / L) * b.price : TECH[g] * b.price;
        const filled = b.vacancy === 0;
        if (b.vacancy > 0) b.wage = Math.min(b.wage * 1.03, mv * 0.9);
        b.vacancy = 0;
        if (b.so > 0.5 && mv > b.wage * 1.15 && b.staff.length < MAX_STAFF) b.vacancy = 1;
        else if ((mv < b.wage * 0.9 || b.inv > 4 * b.salesEMA + 2) && b.staff.length) {
          if (r() < 0.25) { const w = b.staff.pop(); this.ents[w].employer = -1; this.act('layoff', w, o.id, b.id); this.note(this.ents[w], -1, `${o.name} let me go. Too much unsold stock, they said.`, 'fired', 60); }
          b.wage *= 0.99;
        }
        void filled;
        // invest in capital when demand outruns capacity
        if (b.so > 0.7 && r() < 0.08 && b.K < 12) {
          const budget = 3 * this.sectorPX[1];
          this.buy(o.id, 1, 1, budget);
          if (this._got > 0) b.K += this._got;
        }
        b.inv *= KEEP[g];
        if (b.noSales >= 30) this.close(b, 'no customers');
        else if (L === 0 && this.t - b.born > 10) this.close(b, 'nobody working there');
      }
    }

    labour() {
      const r = this.rand, open = this.live.filter(b => b.vacancy > 0);
      const wsum = [0, 0, 0], wn = [0, 0, 0];
      for (const b of this.live) if (b.staff.length) { wsum[b.sector] += b.wage * this.fx(b.owner); wn[b.sector]++; }
      for (let g = 0; g < NS; g++) if (wn[g]) this.sectorWageX[g] = this.sectorWageX[g] * 0.9 + (wsum[g] / wn[g]) * 0.1;

      for (const e of this.ents) {
        const employed = e.employer >= 0, own = this.worksOwn(e);
        e.idle = employed || own ? 0 : e.idle + 1;
        let cur = 0;
        if (employed) {
          cur = this.jobValue(this.biz[e.employer], e);
          if (cur < 0.15 * this.sectorPX[0]) {   // pay no longer buys anything
            this.act('quit', e.id, this.biz[e.employer].owner, r4(cur));
            this.note(e, -1, `My wages in ${this.ents[this.biz[e.employer].owner].code} no longer buy a meal. I walked out.`);
            this.leave(e); cur = 0;
          }
        } else if (own) {
          const b0 = this.biz[e.biz[0]];
          if (b0.staff.length || e.biz.length > 1 || this.t - b0.born < 25 || r() > 0.2) continue;
          cur = Math.max(0, b0.profitEMA) * 1.5;          // solo owners need a clearly better offer to give up
        }
        if ((employed && r() > 0.1) || !open.length) { if (!employed && !own) this.maybeFound(e); continue; }
        let best = null, bv = cur * 1.1;
        for (let k = 0; k < 4; k++) {
          const b = open[(r() * open.length) | 0];
          if (b.vacancy <= 0 || b.owner === e.id || b.id === e.employer) continue;
          const v = this.jobValue(b, e);
          if (v > bv) { bv = v; best = b; }
        }
        if (best && bv > 0.15 * this.sectorPX[0]) {
          if (employed) this.leave(e);
          if (own) this.close(this.biz[e.biz[0]], 'owner took a job');
          const boss = this.ents[best.owner];
          this.act(employed ? 'move' : 'hire', e.id, best.owner, r4(bv));
          this.note(e, 1, employed ? `Moved to ${boss.name}'s ${SECTORS[best.sector].toLowerCase()} business. The pay converts to more X.` : `${boss.name} hired me. I'm paid in ${boss.code}, which only exists because ${boss.name} says so.`, 'job', 60);
          best.staff.push(e.id); best.vacancy--; e.employer = best.id;
        } else if (!employed && !own) this.maybeFound(e);
      }
      // thriving owners sometimes open a second line
      for (const e of this.ents) {
        if (e.biz.length === 1 && r() < 0.002 * e.entre) {
          const b = this.biz[e.biz[0]];
          if (b.staff.length >= 3 && b.profitEMA > 0) {
            let g = (b.sector + 1 + ((r() * 2) | 0)) % NS;
            this.found(e, g, false);
          }
        }
      }
    }
    maybeFound(e) {
      if (e.idle < 4 || this.rand() > 0.03 * (0.3 + e.entre)) return;
      let bg = 0, bs = -1;
      for (let g = 0; g < NS; g++) {
        const s = e.skill[g] * this.sectorPX[g] * TECH[g] * (1 + Math.min(3, this.unmetEMA[g] / (this.soldEMA[g] + 1)));
        if (s > bs) { bs = s; bg = g; }
      }
      this.found(e, bg, false);
    }

    bonds() {
      const E = this.ents, r = this.rand, term = this.P.term;
      // redemptions: the issuer creates the money it owes
      const due = this.bondsDue.get(this.t);
      if (due) {
        for (const b of due) {
          const iss = E[b.issuer], h = E[b.holder];
          this.mint(iss, b.face); h.hold[b.issuer] += b.face;
          iss.bondsOut -= b.face; iss.interestPaid += b.face - b.paid;
          const intX = (b.face - b.paid) * this.fx(b.issuer);
          this.tk.interest += intX;
          this.bondCount--;
        }
        this.bondsDue.delete(this.t);
      }
      const sellers = E.filter(e => e.offerLeft > 1e-9);
      if (sellers.length) {
        for (const h of E) {
          let inv = 0.2 * Math.max(0, h.x - 0.5 * h.buffer);
          if (inv < 0.5) continue;
          let best = null, bR = 0.004 + 0.03 * (1 - h.thrift);
          for (let k = 0; k < 5; k++) {
            const s = sellers[(r() * sellers.length) | 0];
            if (s.id === h.id || s.offerLeft <= 1e-9) continue;
            const exp = Math.max(-0.2, Math.min(0.02, Math.min(s.dep, s.depLong)));
            const R = (1 + s.yield) * Math.exp(exp * term) - 1 - 0.01;
            if (R > bR) { bR = R; best = s; }
          }
          if (!best) continue;
          const p = this.pools[best.id];
          inv = Math.min(inv, 0.05 * p.x);
          let c = (p.c * inv) / (p.x + inv);
          if (c > best.offerLeft) { c = best.offerLeft; inv = (p.x * c) / (p.c - c); }
          p.x += inv; p.c -= c; h.x -= inv;
          this.burn(best, c);
          best.offerLeft -= c; best.offerSold += c;
          const face = c * (1 + best.yield);
          best.bondsOut += face;
          const bond = { issuer: best.id, holder: h.id, face, paid: c, due: this.t + term };
          let arr = this.bondsDue.get(bond.due); if (!arr) this.bondsDue.set(bond.due, arr = []);
          arr.push(bond); this.bondCount++;
          this.tk.fxVol += inv; this.tk.bondSold += inv;
        }
      }
      for (const e of E) {
        if (e.offer > 1e-9) {
          const fill = e.offerSold / e.offer;
          if (fill < 0.5) e.yield = Math.min(1, e.yield * 1.03 + 0.0005);
          else if (fill > 0.95) e.yield = Math.max(0.003, e.yield * 0.97);
        }
      }
    }

    portfolio() {
      const E = this.ents, n = this.n;
      for (const e of E) {
        const h = e.hold;
        for (let i = 0; i < n; i++) {
          const a = h[i];
          if (a <= 0) continue;
          const p = this.pools[i];
          if (a * (p.x / p.c) < 1e-7) continue;
          const amt = a * e.liq, out = (p.x * amt) / (p.c + amt);
          p.c += amt; p.x -= out; h[i] = a - amt; e.x += out;
          this.tk.fxVol += out;
        }
      }
    }

    reform() {
      for (const e of this.ents) {
        const p = this.pools[e.id];
        if (p.x / p.c >= REFORM_AT) continue;
        const F = REFORM_F, i = e.id;
        p.c /= F; e.supply /= F; e.bondsOut /= F; e.offer /= F; e.mintEMA /= F; e.burnEMA /= F; e.mintTick /= F; e.burnTick /= F;
        e.supply0 /= F; e.interestPaid /= F;
        for (const o of this.ents) o.hold[i] /= F;
        for (const arr of this.bondsDue.values()) for (const b of arr) if (b.issuer === i) { b.face /= F; b.paid /= F; }
        for (const id of e.biz) { const b = this.biz[id]; b.price /= F; b.wage /= F; b.revEMA /= F; }
        e.lastFx *= F; e.redenom *= F; e.reforms++; this.reforms++;
        this.act('reform', i, -1, e.reforms);
        this.log('reform', i, `${e.name} redenominated ${e.code}: 1,000,000 old = 1 new`);
        this.note(e, -1, `I struck six zeros off the ${e.code}. Nobody was fooled, least of all me.`);
      }
    }

    /* ---------- subjective experience ---------- */
    note(e, tone, text, topic, gap) {
      if (topic) { if (this.t - (e.said[topic] || -1e9) < (gap || 80)) return; e.said[topic] = this.t; }
      const n = { t: this.t, ent: e.id, tone, text };
      const R = this.rec; R.diary.push([this.t, e.id, tone, text]);
      if (R.diary.length > REC_DIARY_MAX) { R.diary.splice(0, 5000); R.diaryDropped = R.diary[0][0]; }
      e.diary.push(n); if (e.diary.length > 40) e.diary.shift();
      this.voices.push(n); if (this.voices.length > 300) this.voices.splice(0, 100);
    }
    /** How each entity feels: six feelings, a level, and a mood that adapts to whatever becomes normal. */
    feelings() {
      const E = this.ents, term = this.P.term, c01 = v => Math.max(0, Math.min(1, v));
      const med = quantile(E.map(e => e.consEMA).sort((a, b) => a - b), 0.5) || 1e-9;
      for (const e of E) {
        const f = e.feel, a = 0.15;
        const wi = this.workInfo(e), working = wi.working, purpose = wi.purpose;
        f.fed += a * (c01(e.ate[0]) - f.fed);
        f.comfort += a * (0.5 * c01(e.ate[1] / (WANT[1] * e.appetite)) + 0.5 * c01(e.ate[2] / (WANT[2] * e.appetite)) - f.comfort);
        f.security += a * (0.5 * c01(e.x / (e.buffer + 1e-9)) + (working ? 0.5 : 0) - f.security);
        f.purpose += a * (purpose - f.purpose);
        f.pride += a * (c01(0.5 + (e.dep * term) / 0.2) - f.pride);          // watching your own money hold or melt
        f.standing += a * (c01((0.5 * e.consEMA) / med) - f.standing);       // how you live next to everyone else
        e.level = 0.3 * f.fed + 0.2 * f.comfort + 0.15 * f.security + 0.15 * f.purpose + 0.1 * f.pride + 0.1 * f.standing;
        e.usedTo += 0.01 * (e.level - e.usedTo);                             // slow adaptation to circumstances
        e.mood = c01(e.level + 1.5 * (e.level - e.usedTo));                  // change is felt more sharply than level

        // diary
        const spell = e.hungerRun;
        e.hungerRun = e.hungry ? e.hungerRun + 1 : 0;
        if (e.hungry && !e.wasHungry) this.note(e, -1, e.incEMA < this.sectorPX[0] ? `Went hungry. I can print all the ${e.code} I like; it didn't buy a meal today.` : `Went hungry. The shelves were bare when I got there.`, 'hungry', 40);
        if (e.hungerRun === 12) this.note(e, -1, `Twelve ticks without a proper meal. Printing more only makes each note worth less.`, 'starve', 100);
        if (!e.hungry && e.wasHungry && f.fed < 0.6) this.note(e, 1, `Ate properly again.`, 'ate', 40);
        if (e.tight && !e.wasTight) this.note(e, -1, `The ${e.code} is sliding faster than I can stomach. No more printing; I'm selling bonds and buying my own money back.`, 'tight', 120);
        if (!e.tight && e.wasTight && e.dep > 0) this.note(e, 1, `The ${e.code} has steadied. I can loosen up.`, 'eased', 120);
        if (e.dep * term < -0.12) this.note(e, -1, `The ${e.code} lost ${Math.round(-e.dep * term * 100)}% in one bond term. People take it and sell it the same tick.`, 'slide', 150);
        if (e.dep * term > 0.1 && wi.owner) this.note(e, 1, `Customers keep buying ${e.code} to pay me. It's worth ${Math.round(e.dep * term * 100)}% more than a term ago.`, 'strong', 150);
        if (e.idle === 15) this.note(e, -1, `Fifteen ticks with nothing to do. I am a central bank with no economy.`, 'idle', 60);
        if (e.yield > 0.4 && e.offer > 0) this.note(e, -1, `Lenders want ${Math.round(e.yield * 100)}% a term to hold my bonds. Every one I sell is more money I'll have to print later.`, 'yield', 200);
        if (f.standing < 0.25 && f.fed > 0.8) this.note(e, 0, `I eat, but most of the others live better than I do.`, 'envy', 250);
        if (e.mood > 0.85 && e.level > 0.75) this.note(e, 1, `Fed, busy, and my money holds its value. Hard to ask for more.`, 'good', 300);
        if (e.mood < 0.2) this.note(e, -1, `Everything is harder than it was.`, 'low', 200);
        if (e.hungry && !e.wasHungry) this.act('hungry', e.id, -1, r4(e.ate[0]));
        if (!e.hungry && e.wasHungry) this.act('fed', e.id, -1, spell);
        if (e.tight && !e.wasTight) this.act('tighten', e.id, -1, r4(e.dep * term));
        if (!e.tight && e.wasTight) this.act('ease', e.id, -1, r4(e.dep * term));
        e.wasHungry = e.hungry; e.wasTight = e.tight;
      }
    }

    /* ---------- statistics ---------- */
    record() {
      const E = this.ents, n = this.n, tk = this.tk || { gdp: 0, units: [0, 0, 0], fxVol: 0, seign: 0, dollar: 0, bondSold: 0, interest: 0, wagesX: 0 };
      const hi = this.t % 160;
      let unemp = 0, hungry = 0, wel = 0, cap = 0, debt = 0, held = 0, poolX = 0, tight = 0, owners = 0;
      const vals = [], yields = [], deps = [], cons = [], assets = [];
      for (const e of E) e.bondsHeldX = 0;
      for (const arr of this.bondsDue.values()) for (const b of arr) E[b.holder].bondsHeldX += b.face * this.fx(b.issuer);
      for (const e of E) {
        const p = this.pools[e.id], fx = p.x / p.c;
        e.incEMA = e.incEMA * 0.9 + e.incTick * 0.1;
        e.consEMA = e.consEMA * 0.9 + e.consTick * 0.1;
        e.mintEMA = e.mintEMA * 0.9 + e.mintTick * 0.1;
        e.burnEMA = e.burnEMA * 0.9 + e.burnTick * 0.1;
        e.growth = e.growth * 0.97 + Math.log(e.supply / e.supply0) * 0.03; e.supply0 = e.supply;
        e.fxHist[hi] = fx / e.redenom;
        const wi = this.workInfo(e);
        if (!wi.working) unemp++;
        if (wi.owner) owners++;
        hungry += e.hungry; wel += e.welfare; if (e.tight) tight++;
        cap += e.supply * fx; debt += e.bondsOut * fx; poolX += p.x;
        let hv = 0; for (let i = 0; i < n; i++) if (e.hold[i] > 0) hv += e.hold[i] * this.fx(i);
        e.holdX = hv; e.assetsX = e.x + hv + e.bondsHeldX; held += hv;
        vals.push(fx / e.redenom); deps.push(e.dep); cons.push(e.consEMA); assets.push(e.assetsX);
        if (e.offer > 1e-9 || e.bondsOut > 1e-9) yields.push(e.yield);
      }
      vals.sort((a, b) => a - b); yields.sort((a, b) => a - b); deps.sort((a, b) => a - b);
      const bc = [0, 0, 0]; let staff = 0;
      for (const b of this.live) { bc[b.sector]++; staff += this.firmSize(b); }
      const term = this.P.term;
      this.feelings();
      const moods = E.map(e => e.mood).sort((a, b) => a - b);
      const L = this.last = {
        t: this.t, gdp: tk.gdp, units: tk.units[0] + tk.units[1] + tk.units[2],
        unemp: unemp / n, hungry: hungry / n, welfare: wel / n,
        cpi: (this.sectorPX[0] + this.sectorPX[1] + this.sectorPX[2]) / 3,
        pxFood: this.sectorPX[0], pxGoods: this.sectorPX[1], pxServ: this.sectorPX[2],
        bizFood: bc[0], bizGoods: bc[1], bizServ: bc[2], biz: this.live.length, staff, owners,
        cap, debt, fxP10: quantile(vals, 0.1), fxMed: quantile(vals, 0.5), fxP90: quantile(vals, 0.9),
        yieldMed: yields.length ? quantile(yields, 0.5) : 0,
        depMed: -quantile(deps, 0.5) * term, depP10: -quantile(deps, 0.1) * term,
        giniCons: gini(cons), giniAssets: gini(assets),
        moodP10: quantile(moods, 0.1), moodMed: quantile(moods, 0.5), moodP90: quantile(moods, 0.9), low: moods.filter(m => m < 0.35).length / n,
        fxVol: tk.fxVol, seign: tk.seign, dollar: tk.gdp > 0 ? tk.dollar / tk.gdp : 0, bondSold: tk.bondSold, interest: tk.interest,
        poolShare: poolX / this.totalX, tight: tight / n, reforms: this.reforms, bonds: this.bondCount, wageShare: tk.gdp > 0 ? tk.wagesX / tk.gdp : 0,
      };
      this.recTick(L);
      const H = this.hist;
      if (this.t % H.stride === 0) {
        for (const k in L) (H[k] || (H[k] = [])).push(L[k]);
        for (const e of E) e.moodHist.push(e.mood);
        if (H.t.length > 1600) {
          for (const k in H) if (Array.isArray(H[k])) H[k] = H[k].filter((_, i) => i % 2 === 0);
          for (const e of E) e.moodHist = e.moodHist.filter((_, i) => i % 2 === 0);
          H.stride *= 2;
        }
      }
    }

    /* ---------- recording, saving, loading ---------- */
    act(type, who, other, detail) {
      const R = this.rec; R.activity.push([this.t, type, who, other, detail]);
      R.counts[type] = (R.counts[type] || 0) + 1;
      if (R.activity.length > REC_ACT_MAX) { R.activity.splice(0, 20000); R.activityDropped = R.activity[0][0]; }
    }
    /** Change a setting mid-run. The change is kept in the save file's control log. */
    setParam(name, value) {
      if (this.P[name] === value) return;
      this.P[name] = value;
      const c = this.rec.controls, last = c[c.length - 1];
      if (last && last[0] === this.t && last[1] === name) last[2] = value; else c.push([this.t, name, value]);
    }
    recTick(L) {
      const R = this.rec, W = R.world;
      if (!W.cols) W.cols = Object.keys(L);
      if (this.t % W.every === 0) {
        W.rows.push(W.cols.map(k => r4(L[k])));
        if (W.rows.length > REC_WORLD_MAX) { W.rows = W.rows.filter((_, i) => i % 2 === 0); W.every *= 2; }
      }
      const S = R.snaps;
      if (this.t % S.every === 0) {
        S.ticks.push(this.t);
        S.rows.push(this.ents.map(e => {
          const fx = this.fx(e.id), f = e.feel;
          const wi = this.workInfo(e), job = wi.job, staff = wi.staff;
          return [e.mood, e.level, f.fed, f.comfort, f.security, f.purpose, f.pride, f.standing, fx / e.redenom, e.dep * this.P.term,
            e.supply * fx, e.bondsOut * fx, e.yield, e.stance * this.P.term, e.x, e.holdX, e.bondsHeldX, e.incEMA, e.consEMA, job, staff].map(r4);
        }));
        if (S.ticks.length > REC_SNAP_MAX) {
          S.ticks = S.ticks.filter((_, i) => i % 2 === 0); S.rows = S.rows.filter((_, i) => i % 2 === 0); S.every *= 2;
        }
      }
    }

    /** Exact simulation state. Display-only history is rounded; everything the next tick reads is exact. */
    state() {
      const S = {};
      for (const k of Object.keys(this)) if (!STATE_SKIP.has(k)) S[k] = this[k];
      S.bondsDue = [...this.bondsDue];
      S.ents = this.ents.map(e => {
        const o = Object.assign({}, e);
        delete o.diary;
        o.hold = Array.from(e.hold); o.fxHist = Array.from(e.fxHist);
        o.moodHist = e.moodHist.map(v => +v.toFixed(3));
        return o;
      });
      S.hist = {};
      for (const k in this.hist) S.hist[k] = Array.isArray(this.hist[k]) ? this.hist[k].map(r4) : this.hist[k];
      return S;
    }

    /**
     * Build a save. `full` (default) holds everything: every tick's world figures, regular snapshots of every
     * entity, the whole activity log and every diary entry, plus the exact state, so the run can be loaded and
     * continued. `full: false` gives a short summary sized to paste into a chat; it cannot be loaded back.
     */
    save(opts) {
      const full = !opts || opts.full !== false, R = this.rec;
      const thin = (arr, max) => { if (arr.length <= max) return arr; const k = Math.ceil(arr.length / max); return arr.filter((_, i) => i % k === 0 || i === arr.length - 1); };
      const out = {
        format: SAVE_FORMAT, version: SAVE_VERSION, kind: full ? 'full' : 'summary',
        savedAt: new Date().toISOString(),
        readme: README,
        run: { model: this.model, seed: this.P.seed, entities: this.n, tick: this.t, bondTerm: this.P.term, settings: Object.assign({}, this.P), controls: R.controls },
        digest: this.digest(),
        legend: LEGEND,
      };
      out.entities = full ? this.ents.map(e => this.entityCard(e)) : this.entityLines();
      const W = R.world, S = R.snaps;
      if (full) {
        out.world = { every: W.every, columns: W.cols, rows: W.rows };
        out.snapshots = { every: S.every, columns: SNAP_COLS, ticks: S.ticks, rows: S.rows };
        out.businesses = this.biz.map(b => this.firmRow(b));
        out.activity = { columns: ['t', 'type', 'who', 'other', 'detail'], droppedBefore: R.activityDropped || null, rows: R.activity };
        out.diaries = { columns: ['t', 'who', 'tone', 'text'], droppedBefore: R.diaryDropped || null, rows: R.diary };
        out.state = this.state();
      } else {
        const keep = ['t', 'gdp', 'unemp', 'hungry', 'cpi', 'biz', 'staff', 'cap', 'debt', 'fxP10', 'fxMed', 'fxP90', 'yieldMed', 'depMed', 'giniCons', 'moodP10', 'moodMed', 'moodP90', 'low', 'tight', 'reforms'];
        const ki = keep.map(k => W.cols.indexOf(k));
        out.world = { every: 'thinned to about 100 rows', columns: keep, rows: thin(W.rows, 100).map(r => ki.map(i => r[i])) };
        out.activity = { columns: ['t', 'type', 'who', 'other', 'detail'], note: 'Last 100 rows only. digest.activityByWindow counts every row.', rows: R.activity.slice(-100) };
        const per = {}; for (let i = R.diary.length - 1; i >= 0; i--) { const d = R.diary[i]; (per[d[1]] || (per[d[1]] = [])).length < 2 && per[d[1]].unshift(d); }
        out.diaries = { columns: ['t', 'who', 'tone', 'text'], note: 'Last 2 entries per entity only.', rows: Object.values(per).flat().sort((a, b) => a[0] - b[0]) };
      }
      return out;
    }

    /** One line per entity for summary saves, with an 8-point arc of mood and currency value over the run. */
    entityLines() {
      const S = this.rec.snaps, k = S.ticks.length, pts = [];
      for (let j = 0; j < 8 && k; j++) pts.push(Math.round((j * (k - 1)) / 7));
      const f2 = v => (Math.round(v * 100) / 100).toFixed(2);
      return {
        note: `id | name (code) | policy lean | role | mood now | feelings fed/comfort/security/purpose/pride/standing | currency X value, trend per term, redenominations | bonds owed X @ yield | net position X | mood arc | currency arc. Arcs sample ticks ${pts.map(j => S.ticks[j]).join(', ')}.`,
        lines: this.ents.map(e => {
          const c = this.entityCard(e), n = c.now, f = n.feelings;
          return `${e.id} | ${e.name} (${e.code}) | ${c.lean} | ${n.role} | ${n.mood} ${f2(e.mood)} | ${[f.fed, f.comfort, f.security, f.purpose, f.pride, f.standing].map(f2).join('/')} | ` +
            `${fmtD(n.currencyValueX)} X, ${(n.trendPerTerm * 100).toFixed(1)}%, ${n.redenominations} | ${fmtD(n.bondsOwedX)} X @ ${pc(n.bondYield)} | ${fmtD(n.netPositionX)} | ` +
            `${pts.map(j => f2(S.rows[j][e.id][0])).join(' ')} | ${pts.map(j => fmtD(S.rows[j][e.id][8])).join(' ')}`;
        }),
      };
    }

    entityCard(e) {
      const fx = this.fx(e.id), f = e.feel, staff = this.workInfo(e).staff;
      return {
        id: e.id, name: e.name, code: e.code,
        lean: e.hawk > 0.66 ? 'hawk' : e.hawk < 0.33 ? 'dove' : 'moderate',
        traits: { hawk: r4(e.hawk), printTarget: r4(e.dove * this.P.term), slideTolerance: r4(e.tol * this.P.term), bondPreference: r4(e.bondPref), thrift: r4(e.thrift), enterprise: r4(e.entre), skill: { food: r4(e.skill[0]), goods: r4(e.skill[1]), services: r4(e.skill[2]) } },
        now: {
          role: this.roleOf(e), mood: Sim_moodWord(e.mood), moodScore: r4(e.mood), usedTo: r4(e.usedTo),
          feelings: { fed: r4(f.fed), comfort: r4(f.comfort), security: r4(f.security), purpose: r4(f.purpose), pride: r4(f.pride), standing: r4(f.standing) },
          currencyValueX: r4(fx / e.redenom), trendPerTerm: r4(e.dep * this.P.term), redenominations: e.reforms, tightening: e.tight,
          moneyOutX: r4(e.supply * fx), bondsOwedX: r4(e.bondsOut * fx), bondYield: r4(e.yield),
          reservesX: r4(e.x), foreignCurrencyX: r4(e.holdX), bondsHeldX: r4(e.bondsHeldX), incomeX: r4(e.incEMA), spendingX: r4(e.consEMA),
          netPositionX: r4(e.assetsX - (e.supply + e.bondsOut) * fx), staff,
        },
      };
    }

    digest() {
      const R = this.rec, W = R.world, cols = W.cols || [], L = this.last, E = this.ents;
      const col = k => cols.indexOf(k), rows = W.rows;
      const stat = k => {
        const i = col(k); if (i < 0 || !rows.length) return null;
        let s = 0, lo = Infinity, hi = -Infinity, tl = 0, th = 0;
        for (const r of rows) { const v = r[i]; s += v; if (v < lo) { lo = v; tl = r[0]; } if (v > hi) { hi = v; th = r[0]; } }
        return { now: r4(L[k]), mean: r4(s / rows.length), min: lo, minAt: tl, max: hi, maxAt: th };
      };
      const win = Math.max(50, Math.ceil(this.t / 20 / 50) * 50), byWin = {};
      for (const a of R.activity) { const w0 = Math.floor((a[0] - 1) / win) * win + 1, key = `${w0}-${w0 + win - 1}`; (byWin[key] || (byWin[key] = {}))[a[1]] = (byWin[key][a[1]] || 0) + 1; }
      const pick = (f, k, dir) => E.slice().sort((a, b) => dir * (f(a) - f(b))).slice(0, k).map(e => `${e.name} (${e.code}) ${fmtD(f(e))}`);
      const fxNow = e => this.fx(e.id) / e.redenom;
      const moodN = {}; for (const e of E) { const w = Sim_moodWord(e.mood); moodN[w] = (moodN[w] || 0) + 1; }
      const first = rows[0], fi = k => first ? first[col(k)] : null;
      const lines = [
        `Tick ${this.t} of world seed ${this.P.seed}. ${E.length} entities, ${L.biz} open ${this.model === 'coop' ? 'cooperatives' : 'businesses'} (${L.bizFood} food, ${L.bizGoods} goods, ${L.bizServ} services), ${L.staff} ${this.model === 'coop' ? 'members' : 'employees'}.`,
        `Output is ${fmtD(L.gdp)} X per tick; ${pc(L.unemp)} have no job or business and ${pc(L.hungry)} went hungry this tick.`,
        `Median mood is ${Sim_moodWord(L.moodMed)} (${fmtD(L.moodMed)}); the unhappiest tenth sit at ${fmtD(L.moodP10)}. ${pc(L.low)} are uneasy or worse.`,
        `The median currency is worth ${fmtD(L.fxMed)} X per original unit (weakest tenth ${fmtD(L.fxP10)}, strongest tenth ${fmtD(L.fxP90)}). There have been ${L.reforms} redenominations.`,
        `Money outstanding is worth ${fmtD(L.cap)} X; bonds outstanding ${fmtD(L.debt)} X across ${L.bonds} bonds at a median yield of ${pc(L.yieldMed)} per term.`,
        first ? `Since the first recorded tick (${first[0]}), the price level went from ${fmtD(fi('cpi'))} to ${fmtD(L.cpi)} X and output from ${fmtD(fi('gdp'))} to ${fmtD(L.gdp)} X.` : '',
        R.controls.length ? `Settings were changed ${R.controls.length} time(s) during the run; see run.controls.` : 'Settings were not changed during the run.',
      ].filter(Boolean);
      return {
        headline: lines,
        overRun: Object.fromEntries(['gdp', 'unemp', 'hungry', 'moodMed', 'moodP10', 'cpi', 'fxMed', 'fxP10', 'cap', 'debt', 'yieldMed', 'biz', 'giniCons', 'giniAssets', 'tight'].map(k => [k, stat(k)])),
        moodCounts: moodN,
        activityTotals: R.counts,
        activityByWindow: byWin,
        happiest: pick(e => e.mood, 5, -1), unhappiest: pick(e => e.mood, 5, 1),
        strongestCurrencies: pick(fxNow, 5, -1), weakestCurrencies: pick(fxNow, 5, 1),
        mostRedenominated: E.filter(e => e.reforms).sort((a, b) => b.reforms - a.reforms).slice(0, 5).map(e => `${e.name} (${e.code}) ${e.reforms}`),
        [this.model === 'coop' ? 'largestCooperatives' : 'biggestEmployers']: this.bigFirms(),
        mostIndebted: pick(e => e.bondsOut * this.fx(e.id), 5, -1),
      };
    }

    /** Rebuild a world from a full save. The result continues exactly as the saved run would have. */
    static restore(save) {
      if (typeof save === 'string') save = JSON.parse(save);
      if (!save || save.format !== SAVE_FORMAT) throw new Error('This is not an Everyone Makes Money save file.');
      if (save.kind !== 'full' || !save.state) throw new Error('This is a summary save. Only a full save can be loaded back.');
      if (save.version !== SAVE_VERSION) throw new Error(`This save is format version ${save.version}; this page reads version ${SAVE_VERSION}.`);
      const S = save.state, w = Object.create((S.model === 'coop' ? CoopWorld : World).prototype);
      Object.assign(w, S);
      w.rand = rngOf(w);
      w.bondsDue = new Map(S.bondsDue);
      w.rec = newRec(save.snapshots.every);
      w.rec.world = { every: save.world.every, cols: save.world.columns, rows: save.world.rows };
      w.rec.snaps = { every: save.snapshots.every, ticks: save.snapshots.ticks, rows: save.snapshots.rows };
      w.rec.activity = save.activity.rows; w.rec.activityDropped = save.activity.droppedBefore;
      w.rec.diary = save.diaries.rows; w.rec.diaryDropped = save.diaries.droppedBefore;
      w.rec.controls = save.run.controls || [];
      for (const a of w.rec.activity) w.rec.counts[a[1]] = (w.rec.counts[a[1]] || 0) + 1;
      if (save.digest && save.digest.activityTotals) w.rec.counts = Object.assign({}, save.digest.activityTotals);
      w.ents = S.ents.map(o => Object.assign(o, { hold: Float64Array.from(o.hold), fxHist: Float32Array.from(o.fxHist), diary: [] }));
      w.voices = [];
      for (const d of w.rec.diary.slice(-2000)) {
        const n = { t: d[0], ent: d[1], tone: d[2], text: d[3] }, e = w.ents[d[1]];
        e.diary.push(n); if (e.diary.length > 40) e.diary.shift();
        w.voices.push(n);
      }
      w.voices = w.voices.slice(-250);
      w.live = w.biz.filter(b => b.alive);
      w.bySector = [[], [], []];
      const bad = w.audit();
      if (bad.length) throw new Error('The save file is damaged: ' + bad[0]);
      return w;
    }

    /** Short fingerprint of the exact state, for checking that a loaded run matches. */
    fingerprint() {
      let h = 2166136261 >>> 0;
      const mix = v => { const s = String(v); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; };
      mix(this.t); mix(this.rs);
      for (const p of this.pools) { mix(p.c); mix(p.x); }
      for (const e of this.ents) { mix(e.x); mix(e.supply); mix(e.mood); mix(e.employer); }
      return h.toString(16).padStart(8, '0');
    }

    /** Checks the accounting identities. Returns a list of violations (empty when sound). */
    audit() {
      const out = [], n = this.n;
      let x = 0;
      for (let i = 0; i < n; i++) x += this.pools[i].x + this.ents[i].x;
      if (Math.abs(x - this.totalX) > 1e-6 * this.totalX) out.push(`X not conserved: ${x} vs ${this.totalX}`);
      for (let i = 0; i < n; i++) {
        let s = this.pools[i].c;
        for (let j = 0; j < n; j++) s += this.ents[j].hold[i];
        const e = this.ents[i];
        if (Math.abs(s - e.supply) > 1e-6 * Math.max(1, e.supply)) out.push(`${e.code} supply ${e.supply} != holdings ${s}`);
        if (!(this.pools[i].x > 0) || !(this.pools[i].c > 0) || !isFinite(e.supply)) out.push(`${e.code} pool broken`);
        if (e.x < -1e-9) out.push(`${e.code} negative X`);
      }
      return out;
    }

    roleOf(e) {
      if (e.biz.length) {
        const b = this.biz[e.biz[0]];
        const staff = e.biz.reduce((s, id) => s + this.biz[id].staff.length, 0);
        return (e.biz.length > 1 ? e.biz.map(id => SECTORS[this.biz[id].sector]).join(' + ') : SECTORS[b.sector]) + ' owner' + (staff ? `, ${staff} staff` : '');
      }
      if (e.employer >= 0) { const b = this.biz[e.employer]; return `Works for ${this.ents[b.owner].name} (${SECTORS[b.sector]})`; }
      return 'Unemployed';
    }
    bondsOf(id) {
      const issued = [], heldB = [];
      for (const arr of this.bondsDue.values()) for (const b of arr) {
        if (b.issuer === id) issued.push(b); else if (b.holder === id) heldB.push(b);
      }
      return { issued, held: heldB };
    }
  }

  /*
   * The cooperative world. Same entities, central banks, bonds and exchange as World. What changes is the firm:
   * nobody employs anybody. A co-op is owned equally by the members who work in it. It sets its price in X, and a
   * customer pays each member an equal share in that member's own currency, which retires it. There are no wages;
   * members' income is their share of sales. Members vote new people in when they keep selling out and a newcomer
   * would not dilute their share too far. Co-ops never lay anyone off: when sales fall, everyone's share falls.
   */
  const SOLIDARITY = 0.6;      // admit a newcomer whose output would bring in at least this share of current income per member
  const MIN_SKILL = 0.55;      // turn away applicants below this share of the members' average skill in the sector

  class CoopWorld extends World {
    modelName() { return 'coop'; }
    seedFirms() {
      for (const e of this.ents) e.coop = -1;
      for (const [g, e] of this.seedFounders()) this.found([e], g, true);
    }
    coopName(b) { return `${this.ents[b.owner].name} ${SECTORS[b.sector]} Co-op`; }

    found(members, g, seed) {
      const b = {
        id: this.biz.length, owner: members[0].id, members: [], sector: g, alive: true, born: this.t,
        priceX: this.sectorPX[g], inv: 0, K: 0, setup: seed ? 0 : 3, open: 1,
        q: 0, sold: 0, rev: 0, revX: 0, wages: 0, salesEMA: 0, revEMA: 0, so: 0.5, noSales: 0, incomeEMA: 1.2 * this.sectorPX[0], profitEMA: 0,
      };
      this.biz.push(b); this.live.push(b);
      for (const e of members) this.join(e, b);
      this.act('found', b.owner, g, b.id);
      for (const e of members.slice(1)) this.act('join', e.id, b.owner, b.id);
      if (!seed) {
        const names = members.map(e => e.name).join(', ');
        this.log('found', b.owner, `${names} founded ${this.coopName(b)}`);
        for (const e of members) this.note(e, 1, members.length > 1
          ? `We started ${this.coopName(b)}: ${names}. One member, one vote, equal shares of whatever we sell.`
          : `I started ${this.coopName(b)}. It's only me for now; anyone who joins gets an equal share.`);
      }
      return b;
    }
    join(e, b) { if (e.coop >= 0) this.leaveCoop(e); e.coop = b.id; b.members.push(e.id); }
    leaveCoop(e) {
      const b = this.biz[e.coop];
      e.coop = -1;
      if (!b) return;
      const k = b.members.indexOf(e.id); if (k >= 0) b.members.splice(k, 1);
      if (b.alive && !b.members.length) this.close(b, 'every member left');
    }
    close(b, why) {
      if (!b.alive) return;
      b.alive = false; b.closed = this.t;
      this.act('close', b.owner, b.sector, why);
      for (const m of b.members) {
        const e = this.ents[m]; e.coop = -1; this.act('jobloss', m, b.owner, b.id);
        this.note(e, -1, `${this.coopName(b)} has wound up: ${why}. We voted on it together, for what that's worth.`);
      }
      b.members = [];
      this.log('close', b.owner, `${this.coopName(b)} wound up (${why})`);
    }

    workInfo(e) {
      if (e.coop < 0) return { working: false, owner: false, staff: 0, job: -2, purpose: Math.max(0, 0.35 - 0.02 * e.idle) };
      const k = this.biz[e.coop].members.length;
      return { working: true, owner: true, staff: k, job: e.coop, purpose: Math.min(0.9, 0.8 + 0.01 * (k - 1)) };
    }
    firmSize(b) { return b.members.length; }
    leff(b) { let L = 0; for (const m of b.members) L += this.ents[m].skill[b.sector]; return L; }
    fullPX(b) { return b.priceX; }
    selPX(b, j) { const k = b.members.length; return b.members.includes(j) ? (b.priceX * (k - 1)) / k : b.priceX; }
    /** Each member is paid an equal share in their own currency. If the buyer cannot pay everyone, it gets only the share it paid for. */
    payFor(j, b, q) {
      const k = b.members.length; if (!k) return null;
      const share = (q * b.priceX) / k, mine = b.members.includes(j);
      let paid = 0, done = 0;
      for (const m of b.members) {
        if (m === j) continue;
        const p = this.settle(j, m, share / this.fx(m));
        if (p < 0) break;
        paid += p; done++;
        this.ents[m].incTick += share; b.revX += share;
      }
      const got = done + (mine ? 1 : 0);
      if (!got) return null;
      return [paid + (mine ? share : 0), (q * got) / k];
    }
    payStaff() {}
    firmRow(b) { return [b.id, b.owner, SECTORS[b.sector], b.born, b.alive ? null : (b.closed || null), b.members.length, r4(b.salesEMA)]; }
    bigFirms() { return this.live.slice().sort((a, b) => b.members.length - a.members.length).slice(0, 5).map(b => `${this.coopName(b)} ${b.members.length} members`); }
    roleOf(e) {
      if (e.coop < 0) return 'Not in a co-op';
      const b = this.biz[e.coop], k = b.members.length;
      return `Member of ${this.coopName(b)}, ${k} member${k > 1 ? 's' : ''}`;
    }

    manageFirm(b) {
      const r = this.rand, g = b.sector, k = b.members.length;
      const per = k ? b.revX / k : 0;
      b.incomeEMA = b.incomeEMA * 0.9 + per * 0.1; b.profitEMA = b.incomeEMA;
      b.salesEMA = b.salesEMA * 0.85 + b.sold * 0.15;
      b.revEMA = b.revEMA * 0.85 + b.revX * 0.15;
      b.revX = 0;
      if (b.setup > 0) return;
      const soldOut = b.inv < 0.1 * b.q + 0.02;
      b.so = b.so * 0.8 + (soldOut ? 0.2 : 0);
      b.noSales = b.sold > 0.02 ? 0 : b.noSales + 1;
      if (soldOut) b.priceX *= 1.03;
      else if (b.inv > 2 * (b.salesEMA + 0.2)) b.priceX *= 0.97;
      else if (b.inv > b.salesEMA + 0.2) b.priceX *= 0.99;
      // Membership vote: open a seat when selling out and a typical newcomer would not dilute the members' share too far.
      const L = this.leff(b), avgSkill = k ? L / k : 1;
      const marginal = L > 0 ? ((0.75 * b.q) / L) * avgSkill * b.priceX : TECH[g] * b.priceX;
      b.open = b.so > 0.5 && k < MAX_STAFF && marginal >= SOLIDARITY * b.incomeEMA ? 1 : 0;
      // No layoffs. When stock piles up, every member's share shrinks instead.
      if (k > 1 && b.inv > 4 * b.salesEMA + 2)
        for (const m of b.members) this.note(this.ents[m], 0, `Sales are down at ${this.coopName(b)}. We all take a smaller share rather than vote anyone out.`, 'share', 200);
      if (b.so > 0.7 && r() < 0.08 && b.K < 12 && k) {
        this.buy(b.members[this.t % k], 1, 1, 3 * this.sectorPX[1]);   // members take turns buying equipment
        if (this._got > 0) b.K += this._got;
      }
      b.inv *= KEEP[g];
      if (b.noSales >= 30) this.close(b, 'no customers');
    }

    labour() {
      const r = this.rand, food = this.sectorPX[0];
      const open = this.live.filter(b => b.open > 0);
      for (const e of this.ents) {
        let inCo = e.coop >= 0, cur = 0;
        e.idle = inCo ? 0 : e.idle + 1;
        if (inCo) {
          const b0 = this.biz[e.coop];
          cur = b0.incomeEMA;
          if (this.t - b0.born > 20 && cur < 0.15 * food && r() < 0.1) {
            this.act('quit', e.id, b0.owner, r4(cur));
            this.note(e, -1, `My share of ${this.coopName(b0)}'s takings no longer buys a meal. I left.`);
            this.leaveCoop(e); inCo = false; cur = 0;
          } else if (r() > 0.05) continue;     // members rarely look elsewhere
        }
        if (!open.length) { if (!inCo) this.maybeFound(e); continue; }
        let best = null, bv = inCo ? cur * 1.25 : 0;
        for (let t = 0; t < 4; t++) {
          const b = open[(r() * open.length) | 0];
          if (!b.alive || b.open <= 0 || b.id === e.coop || b.members.length >= MAX_STAFF) continue;
          if (b.incomeEMA <= bv) continue;
          const avg = b.members.length ? this.leff(b) / b.members.length : 1;
          if (e.skill[b.sector] < MIN_SKILL * avg) {
            this.act('refused', e.id, b.owner, b.id);
            this.note(e, -1, `${this.coopName(b)} voted not to take me on. Not skilled enough at ${SECTORS[b.sector].toLowerCase()}, they said.`, 'refused', 100);
            continue;
          }
          bv = b.incomeEMA; best = b;
        }
        if (best && bv > 0.15 * food) {
          this.act(inCo ? 'move' : 'join', e.id, best.owner, r4(bv));
          this.note(e, 1, inCo ? `Moved to ${this.coopName(best)}. Their members take home more each tick.`
            : `Joined ${this.coopName(best)}. I own an equal share now, and customers pay my part in ${e.code}.`, 'job', 60);
          this.join(e, best); best.open--;
        } else if (!inCo) this.maybeFound(e);
      }
    }
    /** Idle entities team up: a founder picks a sector and brings up to two other idle entities along. */
    maybeFound(e) {
      if (e.coop >= 0 || e.idle < 4 || this.rand() > 0.03 * (0.3 + e.entre)) return;
      let bg = 0, bs = -1;
      for (let g = 0; g < NS; g++) {
        const s = e.skill[g] * this.sectorPX[g] * TECH[g] * (1 + Math.min(3, this.unmetEMA[g] / (this.soldEMA[g] + 1)));
        if (s > bs) { bs = s; bg = g; }
      }
      const team = [e];
      for (let t = 0; t < 8 && team.length < 3; t++) {
        const c = this.ents[(this.rand() * this.n) | 0];
        if (c.coop < 0 && c.idle >= 2 && !team.includes(c)) team.push(c);
      }
      this.found(team, bg, false);
    }
  }

  /* ---------- save file helpers ---------- */
  const REC_ACT_MAX = 250000, REC_DIARY_MAX = 60000, REC_WORLD_MAX = 20000, REC_SNAP_MAX = 400;
  const STATE_SKIP = new Set(['rand', 'live', 'bySector', 'rec', '_got', 'voices']);
  function newRec(every) {
    return { world: { every: 1, cols: null, rows: [] }, snaps: { every, ticks: [], rows: [] }, activity: [], counts: {}, diary: [], controls: [], activityDropped: null, diaryDropped: null };
  }
  function r4(v) { return typeof v === 'number' && isFinite(v) && v !== 0 ? +v.toPrecision(4) : v; }
  function fmtD(v) { return typeof v !== 'number' ? String(v) : Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : String(r4(v)); }
  function pc(v) { return (v * 100).toFixed(1) + '%'; }
  const SNAP_COLS = ['mood', 'level', 'fed', 'comfort', 'security', 'purpose', 'pride', 'standing', 'currencyValueX', 'trendPerTerm',
    'moneyOutX', 'bondsOwedX', 'bondYield', 'printRatePerTerm', 'reservesX', 'foreignCurrencyX', 'bondsHeldX', 'incomeX', 'spendingX', 'job', 'staff'];
  const README = [
    'Save file from Everyone Makes Money: 100 entities, each its own central bank, trading through one fixed-supply exchange currency, X.',
    'run.model says which world this is. "private": entities own businesses and employ each other for wages. "coop": entities form cooperatives owned equally by their members, with no wages and no employers.',
    'Read "digest" first: headline sentences, statistics over the whole run, top and bottom entities, and activity counts.',
    '"legend" explains every column. Money is valued in X at that moment\'s exchange rate unless a column says otherwise. A bond term is run.bondTerm ticks.',
    '"world" has one row of world statistics per world.every ticks. "snapshots" has, every snapshots.every ticks, one row per entity in id order.',
    '"activity" logs discrete events: hires, layoffs, quits, business openings and closings, redenominations, policy turns, hunger. "diaries" holds what entities wrote, in their own words.',
    'Entity ids index "entities". A full save also has "businesses" and "state"; "state" is the exact machine state used to load and continue the run, and is not meant for reading.',
  ];
  const LEGEND = {
    world: {
      t: 'tick', gdp: 'X spent on food, goods and services this tick', units: 'units sold this tick', unemp: 'share with no job and no business', hungry: 'share who went hungry this tick',
      welfare: 'mean material living standard 0-1', cpi: 'mean price of the three sectors, X per unit', pxFood: 'food price X', pxGoods: 'goods price X', pxServ: 'services price X',
      bizFood: 'open food businesses', bizGoods: 'open goods businesses', bizServ: 'open services businesses', biz: 'open businesses', staff: 'employees (owners not counted); in the co-op model, co-op members', owners: 'entities owning a business',
      cap: 'X value of all money in circulation', debt: 'X value of all bonds outstanding', fxP10: 'currency value, 10th percentile, X per original unit', fxMed: 'currency value, median', fxP90: 'currency value, 90th percentile',
      yieldMed: 'median bond yield per term', depMed: 'median currency slide per term (positive = losing value)', depP10: 'slide of the fastest-falling tenth per term',
      giniCons: 'Gini of spending', giniAssets: 'Gini of foreign assets', moodP10: 'mood of the unhappiest tenth', moodMed: 'median mood', moodP90: 'mood of the happiest tenth', low: 'share with mood below 0.35',
      fxVol: 'X traded on the exchange this tick', seign: 'X raised by printing and selling own money this tick', dollar: 'share of sales paid straight in X because a pool was too thin',
      bondSold: 'X paid for new bonds this tick', interest: 'X value of interest created at maturity this tick', poolShare: 'share of all X sitting in exchange pools', tight: 'share of central banks tightening',
      reforms: 'redenominations so far', bonds: 'bonds outstanding', wageShare: 'wages as a share of output',
    },
    snapshots: {
      mood: '0 desperate .. 1 thriving; level plus how it compares with what the entity is used to', level: 'weighted feelings 0-1', fed: 'feeling 0-1', comfort: 'feeling 0-1', security: 'feeling 0-1', purpose: 'feeling 0-1',
      pride: 'feeling about own currency 0-1', standing: 'feeling about living standard next to others 0-1', currencyValueX: 'X per original unit of own currency (redenominations undone)',
      trendPerTerm: 'smoothed change in own currency value per term', moneyOutX: 'X value of own money in circulation', bondsOwedX: 'X value of own bonds outstanding', bondYield: 'yield offered per term',
      printRatePerTerm: 'share of money supply printed for spending per term', reservesX: 'X held', foreignCurrencyX: 'X value of other currencies held', bondsHeldX: 'X value of others\' bonds held',
      incomeX: 'smoothed income per tick', spendingX: 'smoothed spending per tick', job: 'private model: -1 owns a business, -2 no work, otherwise the employer\'s id. Co-op model: the co-op id (see businesses), -2 none', staff: 'private model: employees across own businesses; co-op model: members of own co-op',
    },
    activity: {
      found: 'who opened a business; other = sector index (0 food, 1 goods, 2 services); detail = business id',
      close: 'who\'s business closed; other = sector index; detail = reason',
      hire: 'who was hired from no work; other = employer id; detail = X value of a tick\'s pay',
      move: 'who switched jobs; other = new employer id; detail = X value of a tick\'s pay',
      layoff: 'who was laid off; other = employer id; detail = business id',
      quit: 'who quit because the pay no longer bought food; other = employer id; detail = X value of a tick\'s pay',
      jobloss: 'who lost a job when the business closed; other = owner id; detail = business id',
      reform: 'who redenominated (1,000,000 old = 1 new); detail = how many times so far',
      tighten: 'who started tightening because the currency slid too fast; detail = slide per term',
      ease: 'who stopped tightening; detail = trend per term', hungry: 'who started going hungry; detail = food eaten this tick',
      fed: 'who ate properly again; detail = ticks the hungry spell lasted',
      join: 'co-op model: who joined a co-op (as a co-founder or later); other = founder id; detail = co-op id or X income per member it offered',
      refused: 'co-op model: who a co-op voted not to admit; other = founder id; detail = co-op id',
      note: 'In the co-op model, "found" and "close" refer to co-ops, "quit" means leaving a co-op whose share no longer bought food, "move" means switching co-ops, "jobloss" means the co-op wound up. There are no hires or layoffs.',
    },
    diaries: { tone: '1 good, 0 neutral, -1 bad' },
    businesses: ['id', 'owner id (co-op model: founder id)', 'sector', 'opened at tick', 'closed at tick (null if open)', 'staff now (co-op model: members now)', 'smoothed sales per tick'],
  };

  const MOODS = [[0.8, 'Thriving'], [0.65, 'Content'], [0.5, 'Getting by'], [0.35, 'Uneasy'], [0.2, 'Struggling'], [-1, 'Desperate']];
  const moodWord = m => MOODS.find(x => m >= x[0])[1];
  const Sim_moodWord = moodWord;
  return { World, CoopWorld, SECTORS, gini, quantile, moodWord };
});
