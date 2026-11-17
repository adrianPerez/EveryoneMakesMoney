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

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
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
      const P = this.P, n = P.n;
      this.rand = mulberry32(P.seed * 7919 + 13);
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
      this.sectorPX = [1, 1, 1];      // sales-weighted price in X, smoothed
      this.sectorWageX = [1.2, 1.2, 1.2];
      this.unmet = [0, 0, 0];
      this.soldEMA = [1, 1, 1];
      this.unmetEMA = [0, 0, 0];
      this.reforms = 0;
      this.tk = null;           // per-tick counters
      this.hist = { stride: 1, t: [] };
      this.last = {};

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
        });
        this.ents[i].months = 10 + 30 * this.ents[i].thrift;   // ticks of spending it likes to hold in X
        this.ents[i].buffer = 2 * this.ents[i].months;
        this.ents[i].stance = this.ents[i].dove * P.fiatMult;
        this.pools.push({ c: POOL0, x: POOL0 });
      }
      this.totalX = n * (POOL0 + X0);

      // Seed economy: the most skilled entities in each sector open shop.
      const quota = [14, 9, 9], taken = new Set();
      for (let g = 0; g < NS; g++) {
        const order = this.ents.slice().sort((a, b) => b.skill[g] - a.skill[g]);
        let q = quota[g];
        for (const e of order) { if (!q) break; if (taken.has(e.id)) continue; taken.add(e.id); this.found(e, g, true); q--; }
      }
      this.record();
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
      if (!seed) this.log('found', e.id, `${e.name} opened a ${SECTORS[g]} business priced in ${e.code}`);
      return b;
    }
    leave(e) {
      const b = this.biz[e.employer];
      if (b) { const k = b.staff.indexOf(e.id); if (k >= 0) b.staff.splice(k, 1); }
      e.employer = -1;
    }
    close(b, why) {
      b.alive = false;
      for (const w of b.staff) this.ents[w].employer = -1;
      b.staff = [];
      const o = this.ents[b.owner];
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
        const L = this.leff(b), o = this.ents[b.owner], g = b.sector;
        b.q = L > 0 ? TECH[g] * Math.pow(L, 0.75) * Math.pow(1 + b.K, 0.2) : 0;
        b.inv += b.q;
        b.K *= 0.995;
        const fx = this.fx(o.id);
        for (const w of b.staff) {
          const we = this.ents[w], pay = b.wage * we.skill[g];
          we.hold[o.id] += pay; this.mint(o, pay); b.wages += pay;
          const v = pay * fx; we.incTick += v; this.tk.wagesX += v;
        }
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
          let px = b.price * this.fx(b.owner);
          if (b.owner === j) px *= 0.7;
          if (px < bestPx) { bestPx = px; best = b; }
        }
        if (!best) break;
        const px = best.price * this.fx(best.owner);
        let q = Math.min(qty, best.inv, budget / px);
        if (q < 0.02) break;
        let paid;
        if (best.owner === j) paid = q * px;                       // eating from your own shelf
        else {
          paid = this.settle(j, best.owner, q * best.price);
          if (paid < 0) { q *= 0.4; if (q < 0.02) break; paid = this.settle(j, best.owner, q * best.price); if (paid < 0) break; }
          best.rev += q * best.price;
        }
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
      const r = this.rand;
      for (const b of this.live.slice()) {
        const o = this.ents[b.owner], g = b.sector, fx = this.fx(o.id);
        const profit = b.rev - b.wages;
        o.incTick += profit * fx;
        b.salesEMA = b.salesEMA * 0.85 + b.sold * 0.15;
        b.revEMA = b.revEMA * 0.85 + b.rev * 0.15;
        b.profitEMA = b.profitEMA * 0.9 + profit * fx * 0.1;
        if (b.setup > 0) continue;
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
          if (r() < 0.25) { const w = b.staff.pop(); this.ents[w].employer = -1; }
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
      this.live = this.live.filter(b => b.alive);
      for (let g = 0; g < NS; g++) {
        if (this.tk.units[g] > 0.5) this.sectorPX[g] = this.sectorPX[g] * 0.9 + (this.tk.val[g] / this.tk.units[g]) * 0.1;
        this.soldEMA[g] = this.soldEMA[g] * 0.9 + this.tk.units[g] * 0.1;
        this.unmetEMA[g] = this.unmetEMA[g] * 0.9 + this.unmet[g] * 0.1;
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
          if (cur < 0.15 * this.sectorPX[0]) { this.leave(e); cur = 0; }   // pay no longer buys anything
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
        this.log('reform', i, `${e.name} redenominated ${e.code}: 1,000,000 old = 1 new`);
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
        if (e.employer < 0 && !e.biz.length) unemp++;
        if (e.biz.length) owners++;
        hungry += e.hungry; wel += e.welfare; if (e.tight) tight++;
        cap += e.supply * fx; debt += e.bondsOut * fx; poolX += p.x;
        let hv = 0; for (let i = 0; i < n; i++) if (e.hold[i] > 0) hv += e.hold[i] * this.fx(i);
        e.holdX = hv; e.assetsX = e.x + hv + e.bondsHeldX; held += hv;
        vals.push(fx / e.redenom); deps.push(e.dep); cons.push(e.consEMA); assets.push(e.assetsX);
        if (e.offer > 1e-9 || e.bondsOut > 1e-9) yields.push(e.yield);
      }
      vals.sort((a, b) => a - b); yields.sort((a, b) => a - b); deps.sort((a, b) => a - b);
      const bc = [0, 0, 0]; let staff = 0;
      for (const b of this.live) { bc[b.sector]++; staff += b.staff.length; }
      const term = this.P.term;
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
        fxVol: tk.fxVol, seign: tk.seign, dollar: tk.gdp > 0 ? tk.dollar / tk.gdp : 0, bondSold: tk.bondSold, interest: tk.interest,
        poolShare: poolX / this.totalX, tight: tight / n, reforms: this.reforms, bonds: this.bondCount, wageShare: tk.gdp > 0 ? tk.wagesX / tk.gdp : 0,
      };
      const H = this.hist;
      if (this.t % H.stride === 0) {
        for (const k in L) (H[k] || (H[k] = [])).push(L[k]);
        if (H.t.length > 1600) {
          for (const k in H) if (Array.isArray(H[k])) H[k] = H[k].filter((_, i) => i % 2 === 0);
          H.stride *= 2;
        }
      }
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

  return { World, SECTORS, gini, quantile };
});
