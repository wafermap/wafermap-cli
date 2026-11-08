# wafermap

The CLI, SDK and MCP server behind [Wafermap](https://wafermap.xyz): an x402 wallet for AI agents. One local, encrypted key that can:

- **call** Wafermap's pay-per-call resources (LLMs, image and audio models, web reading, on-chain data, tokenized stocks, prediction markets)
- **discover** third-party x402 services in the open x402 index and **pay** them
- **swap** tokens through the KyberSwap aggregator

Every payment is checked against a per-payment cap and a daily cap before anything is signed. Swaps have their own per-swap cap. Payments settle in USDG on Robinhood Chain or USDC on Solana, Base, Arbitrum, Polygon, Arc or Soneium and are gasless; swaps need a little ETH for gas.

## Install

```bash
npm i -g @wafermapxyz/cli
wafermap init
```

The command is `wafermap`. The package is **`@wafermapxyz/cli`** on npm (the `wafermapxyz` scope, after the wafermap.xyz domain), the same build as https://wafermap.xyz/cli/wafermap.tgz and this repository. The bare name `wafermap` on npm is **not** this package: the registry refuses it for everyone. Coming from the tarball install? Run `npm rm -g wafermap` first; your wallet in `~/.wafermap` stays.

`init` creates a key and encrypts it with your password (scrypt + AES-256-GCM) in `~/.wafermap/keystore.json`. Back it up with `wafermap export-key`. Then send a few dollars of USDC on Solana to the Solana address it prints, or USDG (Robinhood Chain) or USDC (Base, Arbitrum, Polygon) to its EVM address.

The Solana address comes from the same key (derived with HMAC-SHA256), so one backup covers both. `wafermap export-key --solana` prints the Solana secret key in the form Phantom and Solflare import. `wafermap address` shows both addresses.

## CLI

```bash
wafermap balance
wafermap limits --per-payment 0.1 --per-day 1 --per-swap 25 --network robinhood
wafermap resources stock
wafermap call prediction-markets query="fed rates"
wafermap call flux-2-dev prompt="a glossy silicon wafer" --out wafer.png
wafermap discover weather
wafermap pay https://x402.agentindex.world/weather city=Jakarta
wafermap swap 0.01 ETH USDG
wafermap history
```

Add `--yes` to skip the confirmation prompt (caps still apply), `--network base`, `arbitrum`, `polygon`, `arc`, `soneium` or `solana` to pay in USDC on that network (swaps run on `robinhood` or `base`). Set `WAFERMAP_PASSWORD` to avoid the password prompt in scripts. `wafermap limits --endpoint-check on` has `pay` ask an independent x402 index about a third-party service before signing for it (see [Where the limits live](#where-the-limits-live)).

## MCP server

Give Claude Desktop, Cursor or any MCP client the same wallet. First put the wallet password in your operating system's keychain, once, in a terminal:

```bash
wafermap keychain on
```

Then the client config holds no secret:

```json
{
  "mcpServers": {
    "wafermap": {
      "command": "wafermap",
      "args": ["mcp"]
    }
  }
}
```

`wafermap keychain on` stores the password with Windows DPAPI (a file only your Windows user can decrypt), in the macOS Keychain, or in the Secret Service on Linux (GNOME Keyring, KWallet, through `secret-tool`). `wafermap keychain` shows whether it is set and still unlocks the wallet; `wafermap keychain off` removes it. This keeps the password out of config files, backups and screenshots. It does not stop a program already running as you, which could also ask the OS for it. Setting `WAFERMAP_PASSWORD` in the client's `env` still works, but the password then sits in plain text in that config file, and the server says so when it starts.

Tools: `wafermap_wallet`, `wafermap_resources`, `wafermap_call`, `wafermap_discover`, `wafermap_pay`, `wafermap_swap_quote`, `wafermap_swap`, `wafermap_history`. Swaps from MCP are off until you run `wafermap limits --mcp-swaps on`.

To approve every payment yourself, run `wafermap limits --mcp-confirm on` and restart the MCP server. Each payment and swap then waits for you in the client, showing the amount, asset, recipient, network and resource, before the wallet signs. It uses MCP elicitation; a client that cannot show the prompt gets a refusal and nothing is paid. The caps still apply first.

## SDK

```ts
import { Wafermap } from "@wafermapxyz/cli";

const wm = new Wafermap({ privateKey: process.env.AGENT_KEY as `0x${string}`, limits: { perPayment: 0.05, perDay: 2 } });

const { result, receipt } = await wm.call("stock-signal", { symbol: "TSLA" });
const services = await wm.discover("token price");
const paid = await wm.pay(services[0].url, { method: "POST", input: { symbol: "ETH" }, network: "base" });
const quote = await wm.swapQuote("ETH", "USDG", "0.01");
await wm.swap(quote);
```

Pass `approve: (a) => boolean` to confirm each payment or swap yourself, and `ledger` to persist spending for the daily cap. `endpointCheck: { provider: "settled" }` has `pay()` ask Settled about a third-party endpoint before signing (`refuse` lists the recommendations that stop it, default `["avoid"]`; `onError: "refuse"` fails closed when the index cannot answer); the result then carries `endpointCheck` with the recommendation and its reasons. Lower level: `x402fetch(url, init, { signer })` pays any x402 v1 or v2 endpoint.

## $WAFERMAP holder discount

A wallet that holds at least 100,000 $WAFERMAP on Robinhood Chain pays 50% less for Wafermap's own resources when it pays on an EVM network (Robinhood Chain, Base, Arbitrum, Polygon, Arc, Soneium). Nothing to set up: `wafermap call` names the wallet to Wafermap and the quote comes back discounted; the server re-checks the balance of the wallet that signs. Marketplace listings and Solana payments keep the regular price. Check a wallet: https://wafermap.xyz/api/holder?address=0x…, or run `wafermap holder`.

LLM resources can **stream**: `wafermap call gemma-4 prompt="hi" --stream` prints the answer as it arrives, and the payment settles only once the model finishes.

Wafermap's own resources can also be **paid in $WAFERMAP at 50% off, and the tokens are burned**: `wafermap approve-wafermap` once (a Permit2 approval, one Robinhood Chain transaction), then `wafermap call <id> --pay wafermap`. Each payment is a Permit2 signature for one exact amount, usable for two minutes only by Wafermap's relayer (fixed in the client), checked against a market price the client reads itself.

With 1,000,000 $WAFERMAP the wallet is **Pro**: 10 free calls a day (UTC) to resources listed at $0.01 or less. `wafermap call` sends a holder pass (a signed message, no transaction, valid 24 hours) to Wafermap only; when a call is free, nothing is signed for payment and it prints `✓ Free call`. Holders of 100,000 also unlock x402 Tracker Pro: `wafermap pass` prints a pass for its API. Details: https://wafermap.xyz/docs#holders

## Where the limits live

The caps sit with the key, on your machine. Before the wallet signs anything it reads the 402 quote and refuses when the price is above the per-payment cap or would take today's spend past the daily cap, so nothing is signed and nothing can be charged. With `--mcp-confirm on`, you also approve each MCP payment yourself before it is signed. A budget written in a prompt is an instruction, not a limit: set it with `wafermap limits`. More: https://wafermap.xyz/docs#limits

**The daily cap counts what the wallet signed, not what a server says it charged.** Every payment is written to `spend.jsonl` at its full signed amount the moment it is signed, before it is sent, and stays counted whatever the server answers: an error, a receipt saying $0, no receipt, or no answer at all. Check, sign and record run one payment at a time within a process, so calls started together cannot share the same remaining budget. Across processes on the same wallet (two MCP clients, or the CLI next to the MCP server), the wallet re-reads the shared log right after recording a signed payment and, if the cap is now passed, drops that payment before it is sent. (Before 0.3.3 the cap trusted the server's receipt; see [CHANGELOG.md](CHANGELOG.md).)

**What the wallet cannot enforce.** An x402 `exact` payment is a signed authorization (EIP-3009 on EVM chains, a partially signed transaction on Solana). Whoever receives it can execute it once until it expires. The wallet signs EVM authorizations for at most 90 seconds, or less when the server asks for less (300 before 0.4.0). "A failed call costs $0" is therefore a promise of the server you pay: Wafermap's server settles only after the resource worked and otherwise lets the authorization expire unused. You do not have to take that on trust: `wafermap history --verify` asks each token contract (`authorizationState`) whether every signed payment was executed, and shows the ones that expired unused (`error` means the RPC did not answer). Because `authorizationState` is also true after `cancelAuthorization`, a payment only shows as `used` once the contract's `AuthorizationUsed` event for that nonce is found (in the settlement transaction, or in the blocks between signing and expiry); a nonce that is spent but never executed shows as `cancelled`. The search needs `eth_getLogs`, which Base's public RPC refuses; set `WAFERMAP_RPC_BASE` to your own RPC if a Base payment without a transaction on record shows `error`. Solana payments are checked too, on the public Solana RPC by default (`WAFERMAP_RPC_SOLANA` to use another), not on Wafermap's: from 0.4.7 the wallet logs its own signature, the memo, the blockhash and its slot for each Solana payment. The check anchors the payment to the block its blockhash names (verified on-chain), and shows `used` when a transaction carrying the wallet's signature landed and succeeded, `unused` when the chain is past the blockhash's last valid height and the wallet's USDC history back to that block has no such transaction, and `pending` otherwise. Anything the RPC cannot establish for sure shows `error`, never `unused`. Solana payments logged before 0.4.7 can only be confirmed through the transaction the server named; otherwise they show `unknown`. The caps bound the worst case either way.

**Endpoint check (off by default).** The caps say how much may leave the wallet; they cannot say whether the service at the other end has ever delivered anything for the money, or whether the payTo in the 402 it just sent is the one it is normally paid at. `wafermap limits --endpoint-check on` has `pay` (third-party services; never Wafermap's own resources) ask [Settled](https://settled.tools), an independent index that probes x402 endpoints and buys from them with real USDC, right before the signature. Its recommendation is `pay`, `caution`, `avoid` or `unknown`: `avoid` (a sanctioned or clone-farm payee, a real purchase that came back without content, a listing with honeypot text, paying agents reporting non-delivery) refuses the payment and nothing is signed; `caution` and `unknown` go through (the SDK's `refuse` option can stop them too). A quote whose payTo is not the one Settled's own probe of the same URL is paid at, on the same network, is refused whatever the recommendation: that is how a spoofed endpoint or a man in the middle gets paid. Only the URL's origin and path are sent to Settled, never the input, the quote, the wallet or a key; a URL Settled has not seen before is probed by it and listed in its public index. The check is free for 25 URLs a day per address; past that, or when Settled does not answer, the payment goes ahead as before (the SDK's `onError: "refuse"` fails closed instead). The code is in [`shared/settled.ts`](shared/settled.ts); [`test/endpoint-check.test.mjs`](test/endpoint-check.test.mjs) runs it against a local double.

**Time limits.** Requests to paid resources and services, to Wafermap's API, to the swap API and to Solana RPC give up after 60 seconds (`timeoutMs` in the SDK); EVM RPC calls keep viem's own time-outs. `wafermap resources` uses the same limit. Set `WAFERMAP_TIMEOUT_MS` to change it for the CLI and the MCP server. A paid call that times out after the payment was signed says so: the payment stays counted, and for EVM payments the message says until when it can be executed.

**Swaps.** The wallet builds the swap, checks it, and only then approves and sends. The swap must go to KyberSwap's router (`0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` on Robinhood Chain and Base). The calldata itself is decoded and must trade the quoted tokens, spend exactly the quoted amount, send the output to this wallet, take no fee, and carry an on-chain minimum output of the built output less your slippage, where the built output must be within your slippage of the quote. ETH is sent only when selling ETH, and an ERC-20 approval is for exactly the amount, to that router, and only when the allowance is lower. The router and the route it executes are KyberSwap's: the wallet checks what the call asks for, not what the router contract does.

The checks are in [`src/core.ts`](src/core.ts) (`gate`, `paidFetch`, `checkPayment`), the keystore in [`src/store.ts`](src/store.ts), payment signing in [`shared/x402client.ts`](shared/x402client.ts) and [`shared/solana.ts`](shared/solana.ts). The tests in [`test/caps.test.mjs`](test/caps.test.mjs) run the caps against a local server that lies; [`test/hardening.test.mjs`](test/hardening.test.mjs) covers expiry, time limits, swap checks and the keychain (real DPAPI on Windows; on macOS and Linux the `security` and `secret-tool` calls run against a stub, not a real keychain). CI runs them on Linux, Windows and macOS.

## Build from source

```bash
git clone https://github.com/wafermap/wafermap-cli.git && cd wafermap-cli
npm ci
npm run build          # dist/cli.js, dist/index.js and type declarations (strict tsc)
npm test               # the caps against a mock server that misbehaves
node dist/cli.js --help
npm i -g .             # optional: install this build as `wafermap`
```

Layout: `src/` is the CLI, SDK and MCP server; `shared/` is the x402 client, the Solana payment builder, the swap helpers and the resource catalog, the same files the Wafermap site uses.

## Files

`~/.wafermap/keystore.json` (encrypted key), `config.json` (caps, network), `spend.jsonl` (history). Override the folder with `WAFERMAP_HOME`, the RPCs with `WAFERMAP_RPC_ROBINHOOD` / `WAFERMAP_RPC_BASE`.

Docs: https://wafermap.xyz/docs#cli · Security: [SECURITY.md](SECURITY.md) · License: [MIT](LICENSE)
