# Pitch video script (about 2:30)

Record the screen with the web app's simulator, or reuse [`media/simulator-demo.mp4`](media/simulator-demo.mp4)
(53 s, already captioned, same order as below) as the B-roll for 0:35–1:55 and narrate over it. Speak slowly; judges
watch many of these. Read the **bold** lines word for word; the rest is what is on screen.

---

**0:00–0:20 · The hook** (on screen: the StockPilot hero)

> **Stocks are coming onchain. They trade 24/7, settle in seconds, and nobody has time to watch them. AI could manage
> them for you, but to trade, an AI needs your keys. And an AI with your keys is one bug or one prompt injection away
> from emptying your account.**

**0:20–0:35 · The idea**

> **StockPilot is an AI autopilot for your tokenized stocks that can only trade inside the rules you sign. The AI does
> the work. A smart contract you own keeps it honest.**

**0:35–1:00 · Goal to mandate** (type a goal, click *Draft my mandate*, show the sliders)

> **You describe what you want in plain words. Claude turns it into a mandate: target weights, how far each position
> may drift, and how much may trade per trade and per day. You review it, adjust it if you like, and sign it into a
> vault that you own. Claude never touches your keys or your funds.**

**1:00–1:25 · The pilot works** (NVDA +15% three times, TSLA −15% twice, then *Run pilot*)

> **Markets move. NVIDIA rallies, Tesla drops, your portfolio drifts. The pilot notices and rebalances: it sells some
> NVIDIA and buys Tesla back toward target. Each trade's plain-English reason is hashed onchain, so its log can be
> checked against the chain.**

**1:25–1:55 · Try to break it** (click every *Attempt*, scroll to the red *Blocked* log)

> **Now assume the pilot is hacked. It tries to pile everything into one stock: blocked. Dump a whole position:
> blocked. Take a terrible price from a colluding market maker: blocked. Trade on a stale price, skip the cooldown,
> withdraw the money, rewrite the rules, swap in its own exchange: blocked, blocked, blocked. These checks run inside
> the vault contract, on every trade, against oracle prices. The worst a compromised pilot can do is trade inside your
> bands, under your daily cap, at a fair price.**

**1:55–2:10 · Proof** (cut to the terminal: `npm test` passing, then `npm run demo`)

> **This isn't a mockup. The vault is live on Robinhood Chain testnet. A hundred and nine tests, including six hundred random
> trades where our model of the rules and the real contract must agree exactly. Bring your own AI: any agent can fly a
> vault through our MCP server, under the same limits. And you can pause the pilot or withdraw everything, any time.**

(Only say "live on Robinhood Chain testnet" once it is deployed; otherwise say "deployable to Robinhood Chain".)

**2:10–2:30 · Why now, and the close** (back to the hero, or the *Live* tab with a real vault)

> **Tokenized stocks need the same thing every brokerage account has: someone minding the portfolio. StockPilot gives
> every holder an autopilot, for themselves or built into the wallets and apps they already use, without ever giving
> up custody. Your keys. Your rules. StockPilot.**

---

## Recording checklist

- [ ] Browser zoom 110–125% so text is readable on a phone.
- [ ] Hide bookmarks and extensions; close notifications.
- [ ] Start from a fresh page load (the simulator resets on reload).
- [ ] If deployed: show one real transaction on the Robinhood Chain testnet explorer for 2–3 seconds.
- [ ] Keep it under 3 minutes. Export 1080p MP4.

## One-paragraph description (for forms with a short field)

StockPilot is an AI autopilot for tokenized stock portfolios that can only trade inside the rules you sign. You
describe your goal in plain words; Claude drafts a mandate (target weights, drift bands, trade and daily limits); you
sign it into a vault you own. A pilot rebalances the portfolio, and the vault contract checks every trade against the
mandate at oracle prices, so even a compromised pilot cannot withdraw, change the rules, concentrate the portfolio or
take a bad price. A capped onchain fee pays a hosted pilot fleet; any AI agent can fly a vault through an MCP server;
Claude writes the owner's reports. Built on Robinhood Chain, with 176 tests including a randomized model-versus-contract
check, a no-wallet simulator, a backtest, and a live testnet app.

## One-liners

- An AI autopilot for tokenized stocks that can only trade inside the rules you sign.
- Give an AI your portfolio, not your keys.
- The AI does the work. The contract keeps it honest.
