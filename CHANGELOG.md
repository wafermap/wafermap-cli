# Changelog

## 0.4.10 (12 Nov 2026)

**`wafermap discover` shows the price on every network a service accepts.**

- Under each result, a `pays on:` line lists each network the service takes and its price there, for example `Base $0.002 · Polygon $0.002 · Solana $0.002`. Networks this wallet cannot pay on are marked `(not supported)`. Use the network you hold funds on with `wafermap pay <url> --network <net>`.
- SDK: `discover()` results carry `prices` (`network`, `chain`, `name`, `priceUsd`); `chain` is `null` for a network the wallet does not support. The MCP tool `wafermap_discover` returns the same field.
- `wafermap init` ends with a link to https://wafermap.xyz/start, the first paid call step by step.

## 0.4.9 (7 Nov 2026)

**`wafermap call <llm> --stream`: watch the answer arrive.**

- With `--stream`, an LLM resource answers as server-sent events and the CLI prints each piece as it comes. The payment is the same signature as before; Wafermap settles it only after the last piece, so a model that stops halfway charges nothing (the CLI then exits with `stream_broken`).
- Free calls ($WAFERMAP Pro) and `--pay wafermap` still answer in one JSON body; `--stream` prints that the usual way.
- `Wafermap.call()` takes `onDelta(text)` for the same thing from code.

## 0.4.8 (5 Nov 2026)

**Two more payment networks: Arc and Soneium.**

- `--network arc` pays in USDC on Arc (eip155:5042, the ERC-20 face of Arc's native USDC at `0x3600…0000`, 6 decimals) and `--network soneium` in bridged USDC.e on Soneium (eip155:1868). Both are EIP-3009 transfers, gasless for you; Wafermap settles them through the Elsa facilitator. The EIP-712 domains (`"USDC", "2"` and `"Bridged USDC (Soneium)", "2"`) were checked against each token's `DOMAIN_SEPARATOR()`.
- `balance`, `withdraw` and `history --verify` cover both. RPCs: `WAFERMAP_RPC_ARC`, `WAFERMAP_RPC_SONEIUM` (public ones by default). On Arc the gas token is USDC itself; on Soneium it is ETH.
- The MCP server's `network` option takes `arc` and `soneium`.
- LLM resources can stream: pass `accept: text/event-stream` to `x402fetch` and read `delta`, `receipt` and `done` events (https://wafermap.xyz/docs#streaming). Payment works as before and settles once the model finished.

## 0.4.7 (4 Nov 2026)

**`history --verify` checks Solana payments.** Until now they showed `unknown`.

- Each Solana payment now logs what it can be found by later: the wallet's own signature (the second one in the transaction; the first, which names it on explorers, is the facilitator's), the memo, the blockhash and the slot it was read at.
- `wafermap history --verify` reads a Solana RPC, the public one by default (`WAFERMAP_RPC_SOLANA` for another), never Wafermap's, and takes no number from the server that was paid:
  - The payment is anchored to the block its blockhash names: the block at the logged slot must carry exactly that hash, or the check stops with `error`. The payment can land only after that block, and only until the chain is 150 blocks past it.
  - `used`: a transaction carrying our signature landed and succeeded (the one the server named, or one found in the wallet's USDC account history).
  - `unused`: the finalized chain is past the blockhash's last valid height (read first), and the history, read from a node at least that far along and back to the blockhash's block, has no transaction with our signature. Such a payment can never execute. A transaction that landed with our signature and failed moved nothing: also `unused`.
  - `pending`: not found, and still able to land.
  - `error`: anything the RPC could not establish for sure (a block or history it cannot return, a time-out). Never `unused` on a doubtful read.
  - Solana lines logged before 0.4.7 have no signature: they are `used` when the server's transaction shows this wallet signing and its USDC going down by exactly the signed amount (and no other line was given the same transaction), otherwise `unknown`.
- Reviewed adversarially twice before release. The fixes that came out of it: the expiry is read before the search; the cut-off is a block checked on-chain, not the local clock or a slot from Wafermap's RPC; a fresh blockhash the finalized chain has not reached yet reads `pending`, not `unused`.
- Solana RPC reads have a 15-second limit and back off on rate limits.
- SDK: `checkSolanaPayment()` and `SOLANA_PUBLIC_RPC` are exported; `checkPayment()` routes Solana lines to it. `SolanaPayer` gains an optional `blockhashInfo()`; `blockhash()` still returns a string.

## 0.4.6 (3 Nov 2026)

**`history --verify` tells an executed payment from a cancelled one.** Thank you @GBLIN_Protocol for the catch.

- EIP-3009 `authorizationState` is true both after a payment is executed and after its nonce is cancelled (`cancelAuthorization`), so a cancelled nonce used to read as `used`. The wallet never cancels on its own, but a nonce cancelled by hand would have been shown as paid.
- A `true` is now confirmed by the token contract's `AuthorizationUsed` event for that payer and nonce: first in the receipt of the settlement transaction the server named, otherwise in the blocks between signing and expiry, the only time the payment could have executed. Found: `used`. Not found: `cancelled` (spent nonce, no transfer). If the RPC cannot answer, the result is `error`, never a guess. Base's public RPC refuses log searches, so a Base payment with no settlement transaction on record needs `WAFERMAP_RPC_BASE` set to another RPC.
- `history --verify` checks four payments at a time instead of all at once, so public RPCs stop refusing long histories.
- SDK: `checkPayment()` returns the new `"cancelled"` state and takes the entry's `at` and `tx` when given.

## 0.4.5 (2 Nov 2026)

**Pay Wafermap in $WAFERMAP, at 50% off. The tokens are burned.**

- `wafermap call <id> --pay wafermap` (MCP `wafermap_call` with `payIn: "wafermap"`, SDK `call(id, input, { payIn: "wafermap" })`) pays one of Wafermap's own resources in $WAFERMAP instead of USDG/USDC. $WAFERMAP has no EIP-3009, so the payment is a Uniswap Permit2 signature for one exact amount, spendable for two minutes only by Wafermap's relayer, which sends it to the dead address once the call succeeded. A failed call moves nothing.
- `wafermap approve-wafermap`: the one-time Permit2 approval (one Robinhood Chain transaction, paid in ETH).
- What the client checks before it signs, trusting the server for none of it: the spender is Wafermap's relayer as fixed in this release (`WAFERMAP_RELAYERS`); the option names the canonical Permit2, the $WAFERMAP token and the dead address; the amount is valued at a price this client reads itself (GeckoTerminal) and refused when it is worth more than the quote states. The caps count the higher of the two values.
- Only `call()` to Wafermap ever signs a $WAFERMAP permit. `pay()` to third-party services never does, whatever they offer, because a Permit2 spender chooses where the tokens go.

## 0.4.4 (2 Nov 2026)

**$WAFERMAP holder tiers.**

- **Pro free calls.** A wallet holding 1,000,000 $WAFERMAP on Robinhood Chain gets 10 free calls a day (UTC) to Wafermap resources listed at $0.01 or less. `call()` (CLI `wafermap call`, MCP `wafermap_call`) sends a **holder pass** to Wafermap with each call; when the call is free, the result comes back with `receipt: null` and `free: {left, perDay}`, no payment is signed and nothing is recorded as spending. Otherwise the call is quoted and paid as before.
- **Holder pass.** A message the wallet signs (`personal_sign`: no transaction, no cost) that proves it holds the wallet, valid for 24 hours and reused until its last 10 minutes (`Wafermap.holderPass()`). It goes to Wafermap only: never with `pay()` to third-party services, and never to marketplace listings (`m/...`). The SDK exports `PASS_HEADER`, `passMessage`, `encodePass`, `decodePass`, `makePass`.
- **`wafermap holder`** shows what the wallet's $WAFERMAP unlocks: holder price, tier, free calls left today, x402 Tracker Pro. Needs no password (`holderInfo()` in the SDK).
- **`wafermap pass`** prints a pass for scripts, e.g. the x402 Tracker Pro API (`/api/x402/pro/movers`, `/api/x402/pro/export`, for wallets holding 100,000 $WAFERMAP).

## 0.4.3 (2 Nov 2026)

The two open points from the third public review by @whoiskn0why (8/10), thank you.

- **`wafermap resources` has a time limit.** It was the one command that still used a bare `fetch` and could wait forever on a server that never answered. It now gives up after 60 seconds with `timeout`, like every other request, and reports `network_error` instead of printing nothing when the catalog cannot be read. The SDK exports the same function as `listResources(baseUrl?, timeoutMs?)`; `Wafermap.resources()` uses it. `WAFERMAP_TIMEOUT_MS` sets the limit for the CLI and the MCP server.
- **npm provenance.** From this version the package is published by GitHub Actions (`.github/workflows/publish.yml`) through npm trusted publishing, with a signed provenance statement that ties the tarball on npm to the commit and workflow run that built it. Check it on the npm page ("Provenance") or with `npm audit signatures`. CI holds no npm token: npm trusts this one workflow file in this repo, and nothing else.

## 0.4.2 (2 Nov 2026)

**$WAFERMAP holder discount.** `call()` (CLI `wafermap call`, MCP `wafermap_call`) now names the paying wallet to Wafermap in an `X-Wafermap-Payer` header, so a wallet holding at least 100,000 $WAFERMAP on Robinhood Chain is quoted 50% less for Wafermap's own resources, on EVM networks. Wafermap checks the balance again against the signer of the payment, so the header only ever lowers the price for the wallet that actually holds. The header goes to Wafermap only: `pay()` sends nothing extra to third-party services. Marketplace listings keep their seller's price.

## 0.4.1 (2 Nov 2026)

On npm as **`@wafermapxyz/cli`**: `npm i -g @wafermapxyz/cli` (SDK: `import { Wafermap } from "@wafermapxyz/cli"`). The command stays `wafermap`, the wallet stays in `~/.wafermap`. The registry refuses the bare name `wafermap` for everyone, so the package lives under our own scope. If you installed from the tarball, run `npm rm -g wafermap` before installing the scoped package. No code changes since 0.4.0.

## 0.4.0 (2 Nov 2026)

From the second public review by @whoiskn0why, thank you.

- **Shorter payment authorizations.** EVM payments are signed for at most 90 seconds (was up to 300), or less when the server asks for less. That is the window in which "a failed call costs $0" rests on the server's word; `wafermap history --verify` still checks every one on-chain afterwards.
- **Time limits.** Requests to paid resources and services, Wafermap's API, the swap API and Solana RPC give up after 60 seconds (`timeoutMs` in the SDK, `DEFAULT_TIMEOUT_MS`); EVM RPC keeps viem's time-outs. Before, a server that never answered held a call forever. A paid call that times out after signing says the payment stays counted (and, for EVM payments, until when it can be executed); one that times out before signing says nothing was paid.
- **Swaps are checked before anything is signed.** The build now comes first and the approval after it. The quote and the build must name KyberSwap's router (`KYBER_ROUTER`, `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`). The swap calldata is decoded (`decodeSwap`) and must trade the quoted tokens, spend exactly the quoted amount, pay the output to this wallet, take no fee, and set an on-chain minimum output no lower than the built output less your slippage; the built output must be within your slippage of the quote, and ETH is sent only when selling ETH. Otherwise nothing is approved or sent (`unexpected_router`, `unexpected_calldata`, `build_mismatch`, `price_moved`). `amountOutMin` is now the minimum encoded in the transaction.
- **The MCP password can leave the config file.** `wafermap keychain on` stores it with Windows DPAPI, the macOS Keychain or the Linux Secret Service; `wafermap mcp` reads it from there, and warns when `WAFERMAP_PASSWORD` is still set in plain text.
- An empty `WAFERMAP_PASSWORD` counts as not set. `wafermap keychain off` checks that the password is really gone.
- Tests for all of the above (`test/hardening.test.mjs`: real DPAPI on Windows; the macOS and Linux stores are exercised against a stub). CI also runs on Windows and macOS.
- The SDK exports `quoteSwap`, `executeSwap`, `decodeSwap`, `KYBER_ROUTER`, `MAX_VALIDITY_SECONDS` and `DEFAULT_TIMEOUT_MS`.

npm: the name `wafermap` is refused by the registry for everyone (too similar to an existing package). From 0.4.1 the package is `@wafermapxyz/cli`.

## 0.3.3 (1 Nov 2026)

**Fix: the daily cap no longer trusts the server.** Reported publicly in a code review by @whoiskn0why, thank you.

Before: the spend record was written after the call, from the server's receipt (`call()`), or as $0 when the server answered with an error (`pay()`). A server that reported $0, sent no receipt, answered with an error or dropped the connection could take signed payments that never counted towards the daily cap. With a $0.10 cap, $0.15 in signed payments could go through.

Now:
- Every payment is recorded at its full signed amount the moment it is signed, before it is sent, and stays counted whatever the server answers. The outcome (ok / failed / refused) is written as a second line that adds nothing to the total.
- Check, sign and record run one payment at a time within a process, so concurrent calls cannot both pass the cap on the same remaining budget (found while writing the tests). Across processes sharing one wallet (two MCP clients, CLI + MCP), each signed payment is checked again against the shared log before it is sent and dropped, never sent, if another process used the budget meanwhile (found in our own adversarial review).
- `wafermap history --verify` (SDK: `checkPayment`) reads `authorizationState` on the token contract to show which signed EVM payments were executed and which expired unused, without trusting any server.
- `wafermap history` shows each payment's status and notes that log lines from before 0.3.3 hold what the server reported.
- Tests (`npm test`): the caps against a local mock server that lies, errors, refuses or hangs up; CI on Node 20 and 22.

Older `spend.jsonl` lines are still read; `mergeLog` joins the new two-line records.

## 0.3.2

Opt-in per-payment confirmation for the MCP server (`wafermap limits --mcp-confirm on`).

## 0.3.1

First public source release: CLI, SDK and MCP server.
