# Everyone Makes Money

A simulation of 100 entities that start businesses, buy from each other and work for each other. Each entity is its own central bank: it issues its own fiat currency, sells bonds, and sets its own monetary policy. All 100 currencies float against one shared exchange currency, X.

## Run it

Open `index.html` in a browser. There is nothing to build or install.

- **Play / Step / Speed** drive the clock.
- **Printing appetite** multiplies how much every central bank wants to print. Push it up to watch currencies slide, yields climb and redenominations start.
- **World seed** plus **New world** gives a different, reproducible world.

The page shows headline figures, nine charts over time, a board of all 100 currencies, a scatter of money growth against currency value, the full books of any issuer you pick, and sortable tables of every central bank and business.

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

- `sim.js` is the engine. It has no DOM access and runs in a browser or in Node.
- `index.html` is the page: controls, charts and tables.
- `test/run.js` runs several worlds headless and checks two accounting identities on every tick: X is conserved, and each currency's supply equals the sum of everything held in it.

```bash
node test/run.js 5000 3
```
