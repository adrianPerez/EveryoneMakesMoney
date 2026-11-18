# Everyone Makes Money

A simulation of 100 entities that start businesses, buy from each other and work for each other. Each entity is its own central bank: it issues its own fiat currency, sells bonds, and sets its own monetary policy. All 100 currencies float against one shared exchange currency, X.

## Two worlds

The page has a tab for each of two worlds and a third to compare them. Both start from the same seed, so they have the same 100 entities with the same skills and policy leanings, and they run side by side.

- **Private enterprise**: entities open businesses, set prices and wages in their own currency, and hire each other.
- **Cooperatives**: nobody employs anybody. Entities form co-ops owned in equal shares by the members who work in them. A co-op sets its price in X, and each sale is split equally among the members, each paid in their own currency. Members vote newcomers in when the co-op keeps selling out and a newcomer would not cut their share by much, and turn away applicants with much less skill. Nobody is laid off; when sales fall, every member's share falls. Idle entities team up in twos and threes to found new co-ops.
- **Compare**: a table of key figures for both worlds right now, and charts of output, mood, hunger, inequality, currency value, prices and firm counts with both worlds on the same axes.

The selected entity stays selected across tabs, so you can follow one entity through both worlds. Printing appetite, Step, Play and New world act on both worlds at once.

## Run it

Open `index.html` in a browser. There is nothing to build or install.

- **Play / Step / Speed** drive the clock.
- **Printing appetite** multiplies how much every central bank wants to print. Push it up to watch currencies slide, yields climb and redenominations start.
- **World seed** plus **New world** gives a different, reproducible pair of worlds.

The page shows headline figures, nine charts over time, a board of all 100 currencies, a scatter of money growth against currency value, the full books of any issuer you pick, and sortable tables of every central bank and business.

## Save files

**Save run** on the page offers two kinds of file:

- **Full save**: world figures for every tick, a snapshot of every entity every 20 ticks, the whole activity log (hires, layoffs, quits, openings, closings, redenominations, policy turns, hunger), every diary entry, every settings change, and the exact simulation state. **Load run** reads it back and the run continues exactly where it was saved.
- **Summary for a chat**: a digest of the run, the world's trend, one line per entity with its mood and currency over the run, and the latest diary entries. It is about 60 kB, so it can be pasted into a conversation.

Both start with a `readme` and a `legend` that explain every section and column, so whoever reads the file (you or Claude) knows what each number means.

The same files can be made from the command line:

```bash
node tools/save.js --seed 7 --ticks 2000
```

```bash
node tools/save.js --model coop --seed 7 --ticks 2000
```

```bash
node tools/save.js --seed 7 --ticks 3000 --schedule 1000:4,1600:1
```

```bash
node tools/save.js --from saves/private-seed-7-t2000.json --ticks 500 --summary
```

`--schedule` changes the printing appetite at the given ticks, `--from` continues a full save, and `--summary` writes the short kind. Files go to `saves/` unless `--out` says otherwise.

To hand a run to Claude, paste a summary into the chat, or put a full save in `saves/` and commit it.

## How the world works

| Piece | Rule |
|---|---|
| Fiat money | Paying a wage or buying something mints new units of the payer's currency. Money paid to a business in its owner's currency is retired. |
| Exchange currency | X has a fixed supply. Each currency has a constant-product pool against X. A shopper sells their own money for X and buys the seller's money with it. |
| Businesses | Food, goods or services. Output depends on staff skill and capital. Prices rise when stock sells out and fall when it piles up. Businesses hire, lay off, invest and close. |
| Work | Workers take the job whose pay converts to the most X, and quit when the pay stops buying anything. The unemployed sometimes open their own business. |
| Bonds | Sold for the issuer's own currency, which removes that money from circulation. At maturity (30 ticks) the issuer prints principal plus interest. Yields move with demand. |
| Policy | Each issuer sits between hawk and dove. Sliding too fast: stop printing, sell more bonds, buy the currency back with X reserves. Rising too fast: print more. |
| Feelings | Each entity has six feelings (fed, comfort, security, purpose, pride in its currency, standing) and a mood that adapts to what it is used to. Each keeps a first-person diary. |
| Redenomination | A currency worth less than a millionth of an X is replaced at 1,000,000 old for 1 new. |

## Files

- `sim.js` is the engine. `World` is the private-enterprise world and `CoopWorld` the cooperative one; `CoopWorld` overrides only how firms are seeded, priced, paid, managed and staffed. It has no DOM access and runs in a browser or in Node.
- `index.html` is the page: controls, charts and tables.
- `tools/save.js` runs or continues a world headless and writes a save file.
- `test/save.js` saves worlds mid-run, loads them back, and checks that the loaded run matches the original on every tick.
- `test/run.js` runs several worlds headless and checks two accounting identities on every tick: X is conserved, and each currency's supply equals the sum of everything held in it.

```bash
node test/run.js 5000 3
```

```bash
node test/save.js 3
```
