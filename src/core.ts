// The Wafermap SDK. One class for an agent that holds its own key:
//   call()     pay-per-call Wafermap resources over x402
//   discover() search the open x402 index for third-party services
//   pay()      call any x402 URL and pay it (USDG on Robinhood Chain; USDC on Solana, Base, Arbitrum, Polygon, Arc, Soneium)
//   swapQuote() / swap()  trade tokens through the KyberSwap aggregator
// Every payment is checked against per-payment and daily caps before anything is signed;
// swaps are checked against a per-swap cap. The daily cap counts what this wallet signed, at the
// full signed amount, the moment it is signed: never what a server reports it charged.
// Nothing is ever sent to Wafermap but the signed payment header the x402 protocol requires.
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, isAddress, pad, parseAbiItem, parseUnits, toEventSelector, type Hex, type LocalAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, arc, base, polygon, robinhood, soneium } from "viem/chains";
import { TOKENS, executeSwap, quoteSwap, resolveToken, type Net as SwapNet, type SwapQuote, type Token } from "../shared/swap";
import { checkSolanaPayment, latestBlockhash, latestBlockhashInfo, solanaBalances, solanaKeyFromEvm, type SolanaPayer } from "../shared/solana";
import { CHAIN_KEYS, PAY_CHAINS, PERMIT2, WAFERMAP_TOKEN, x402fetch, X402Error, type ChainKey, type Requirement, type Signed } from "../shared/x402client";
import { PASS_HEADER, decodePass, encodePass, makePass } from "../shared/pass";
import { endpointRefusal, endpointVerdict, type EndpointCheck, type EndpointVerdict } from "../shared/settled";

/** A payment network. Swaps run on Robinhood Chain and Base only. */
export type Net = ChainKey;
type EvmNet = Exclude<Net, "solana">;
export const NETS: Net[] = CHAIN_KEYS;
export const isNet = (v: unknown): v is Net => NETS.includes(v as Net);
const isSwapNet = (v: unknown): v is SwapNet => v === "robinhood" || v === "base";
export type Limits = { perPayment: number; perDay: number; perSwap: number };
/**
 * One line of the spend log. A payment writes two lines: the signed amount the moment it is
 * signed (`status: "signed"`, counted by the daily cap), then the outcome with `usd: 0` and
 * `of` pointing back to it. Older logs have single lines without `id`; `mergeLog` joins them.
 */
export type SpendEntry = {
  at: number;
  kind: "resource" | "service" | "swap";
  what: string;
  usd: number;
  network: Net;
  tx: string | null;
  payer: string;
  id?: string;
  of?: string;
  status?: PaymentStatus;
  /** EVM payments: the EIP-3009 nonce and expiry, to check on-chain whether it was ever used. */
  nonce?: string;
  validBefore?: number;
  /** Solana payments (from 0.4.7): our signature, the memo, the blockhash and the slot it was read at. */
  sig?: string;
  memo?: string;
  blockhash?: string;
  slot?: number;
  /** What the server said it charged, for the record only. */
  reported?: number | null;
};
/** signed: sent, outcome not known (or the request died) · ok: the server answered 2xx ·
 *  failed: it answered with an error · refused: it refused the payment itself ·
 *  aborted: signed but never sent, because another process had used the budget meanwhile. */
export type PaymentStatus = "signed" | "ok" | "failed" | "refused" | "aborted";
export type Approval = { kind: SpendEntry["kind"]; what: string; usd: number; network: Net; detail?: string };

export type WafermapOptions = {
  /** A 0x private key, or pass `account` (any viem LocalAccount). A private key also gives the
   *  wallet its Solana side (derived from it); with `account`, pass `solana` to pay on Solana. */
  privateKey?: Hex;
  account?: LocalAccount;
  /** Signs Solana payments. Derived from `privateKey` when not given. */
  solana?: Omit<SolanaPayer, "blockhash">;
  /** Read-only: a Solana address for balances when there is no key. */
  solanaAddress?: string;
  /** Default https://wafermap.xyz */
  baseUrl?: string;
  /** Preferred payment network. Default robinhood (USDG); base, arbitrum, polygon, arc, soneium and solana pay in USDC. */
  network?: Net;
  limits?: Partial<Limits>;
  /** Where spending is remembered for the daily cap. Default: in memory. */
  ledger?: { entries(): SpendEntry[]; record(e: SpendEntry): void };
  /** Called before every payment or swap. Return false to refuse. Default: allow within caps. */
  approve?: (a: Approval) => boolean | Promise<boolean>;
  /** RPC URLs per network. Solana defaults to `${baseUrl}/api/solana`. */
  rpc?: Partial<Record<Net, string>>;
  /** Give up on any HTTP request (quote, paid call, discovery, swap API) after this long. Default 60000 ms.
   *  A paid call that times out after signing stays counted until its authorization expires. */
  timeoutMs?: number;
  /** Where the $WAFERMAP price comes from when paying in $WAFERMAP (default: GeckoTerminal, read by this client).
   *  The signed amount is valued at this price and refused when it is worth more than the quote states. */
  tokenPriceUsd?: () => Promise<number>;
  /** Ask an independent x402 index (Settled) about a third-party endpoint before `pay()` signs for it: refused when
   *  its recommendation is in `refuse` (default ["avoid"]) or the quote pays someone other than the recipient the
   *  index's own probe of the URL is paid at. Only the URL's origin and path are sent. Off by default (shared/settled.ts). */
  endpointCheck?: EndpointCheck;
};

export class WafermapError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const CHAINS = { robinhood, base, arbitrum, polygon, arc, soneium } as const;
const AUTH_STATE_ABI = [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] }] as const;

/** One row per payment: the signed line joined with its outcome line. Old single lines pass through. */
export function mergeLog(entries: SpendEntry[]): SpendEntry[] {
  const outcomes = new Map(entries.filter((e) => e.of).map((e) => [e.of!, e]));
  return entries
    .filter((e) => !e.of)
    .map((e) => {
      const o = e.id ? outcomes.get(e.id) : undefined;
      if (!o) return e;
      return { ...e, status: o.status, tx: o.tx ?? e.tx, reported: o.reported ?? null, ...(o.status === "aborted" ? { usd: 0 } : {}) };
    });
}

/** The block nearest to a Unix time: the last one at or before it ("from"), or the first one at or after it ("to").
 *  Interpolation search, a handful of getBlock calls; stops once the bracket is under 20 blocks. */
type BlockReader = { getBlock(a?: { blockNumber: bigint }): Promise<{ number: bigint; timestamp: bigint }> };
async function blockAt(client: BlockReader, ts: number, side: "from" | "to", latest: { number: bigint; timestamp: bigint }): Promise<bigint> {
  if (ts >= Number(latest.timestamp)) return latest.number;
  let hi = latest;
  let lo = await client.getBlock({ blockNumber: latest.number > 100_000n ? latest.number - 100_000n : 0n });
  while (Number(lo.timestamp) > ts && lo.number > 0n) {
    const back = (hi.number - lo.number) * 4n;
    hi = lo;
    lo = await client.getBlock({ blockNumber: lo.number > back ? lo.number - back : 0n });
  }
  for (let i = 0; i < 20 && hi.number - lo.number > 20n; i++) {
    const span = Number(hi.timestamp - lo.timestamp) || 1;
    let guess = lo.number + BigInt(Math.floor((Number(hi.number - lo.number) * (ts - Number(lo.timestamp))) / span));
    if (guess <= lo.number) guess = lo.number + 1n;
    if (guess >= hi.number) guess = hi.number - 1n;
    const b = await client.getBlock({ blockNumber: guess });
    if (Number(b.timestamp) <= ts) lo = b;
    else hi = b;
  }
  return side === "from" ? lo.number : hi.number;
}

const AUTH_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

/**
 * Was a signed payment ever executed? Reads the token contract (EIP-3009 authorizationState),
 * so the answer does not depend on any server and needs no key. "unused" after expiry means it
 * can never be charged. authorizationState is also true after cancelAuthorization, so a true is
 * confirmed by the AuthorizationUsed event: first in the receipt of the transaction the server
 * named, else in the blocks between signing and expiry, the only time it could have executed.
 * None there means the nonce was cancelled, never executed ("cancelled"). Solana payments are
 * checked by checkSolanaPayment (shared/solana.ts), by default on the public Solana RPC. Old log
 * lines with nothing to check by come back "unknown"; an RPC failure comes back "error".
 */
export async function checkPayment(e: Pick<SpendEntry, "network" | "payer" | "nonce" | "validBefore"> & Partial<Pick<SpendEntry, "sig" | "memo" | "blockhash" | "slot" | "usd">> & { at?: number; tx?: string | null }, rpc?: string): Promise<"used" | "cancelled" | "unused" | "pending" | "unknown" | "error"> {
  if (e.network === "solana") return checkSolanaPayment(e, rpc).catch(() => "error" as const);
  if (!e.nonce || !(e.network in CHAINS)) return "unknown";
  const chain = PAY_CHAINS.find((c) => c.key === e.network)!;
  try {
    const client = createPublicClient({ chain: CHAINS[e.network as EvmNet], transport: http(rpc) });
    const used = await client.readContract({ address: chain.stable as Hex, abi: AUTH_STATE_ABI, functionName: "authorizationState", args: [e.payer as Hex, e.nonce as Hex] });
    if (!used) return e.validBefore && Date.now() / 1000 > e.validBefore ? "unused" : "pending";
    const isOurs = (l: { address: string; topics: readonly string[] }) =>
      l.address.toLowerCase() === chain.stable.toLowerCase() &&
      l.topics[0] === toEventSelector(AUTH_USED) &&
      l.topics[1]?.toLowerCase() === pad(e.payer as Hex).toLowerCase() &&
      l.topics[2]?.toLowerCase() === e.nonce!.toLowerCase();
    if (e.tx && /^0x[0-9a-fA-F]{64}$/.test(e.tx)) {
      const receipt = await client.getTransactionReceipt({ hash: e.tx as Hex }).catch(() => null);
      if (receipt?.status === "success" && receipt.logs.some(isOurs)) return "used";
    }
    // Not in that receipt: search the window it could have executed in (signing time to expiry).
    if (!e.validBefore || !e.at) return "error";
    const latest = await client.getBlock();
    const fromBlock = await blockAt(client as unknown as BlockReader, Math.floor(e.at / 1000) - 60, "from", latest);
    const toBlock = await blockAt(client as unknown as BlockReader, e.validBefore + 30, "to", latest);
    // Public RPCs cap getLogs by range and rate, so ask in 50-block pieces and retry a refused piece.
    for (let start = fromBlock; start <= toBlock; start += 50n) {
      const end = start + 49n < toBlock ? start + 49n : toBlock;
      for (let attempt = 0; ; attempt++) {
        try {
          const logs = await client.getLogs({ address: chain.stable as Hex, event: AUTH_USED, args: { authorizer: e.payer as Hex, nonce: e.nonce as Hex }, fromBlock: start, toBlock: end });
          if (logs.length) return "used";
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    return "cancelled";
  } catch {
    return "error"; // the RPC could not answer: the payment may or may not have been executed
  }
}

export const DEFAULT_LIMITS: Limits = { perPayment: 0.1, perDay: 1, perSwap: 25 };
export const DEFAULT_TIMEOUT_MS = 60_000;

const timedOut = (e: any) => e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";

/** What a wallet's $WAFERMAP unlocks (holder price, Pro free calls left today), from /api/holder. Needs no key. */
export async function holderInfo(address: string, baseUrl = "https://wafermap.xyz", timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  const host = new URL(baseUrl).host;
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/api/holder?address=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(timeoutMs) }).catch((e) => {
    throw timedOut(e) ? new WafermapError("timeout", `${host} did not answer within ${Math.round(timeoutMs / 1000)} s.`) : new WafermapError("network_error", `${host}: ${e?.message ?? "request failed"}`);
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j) throw new WafermapError(j?.error?.code ?? "network_error", j?.error?.message ?? `${host} answered HTTP ${r.status}.`);
  return j;
}

/** Wafermap's resource catalog. Needs no wallet; gives up after `timeoutMs` like every other request. */
export async function listResources(baseUrl = "https://wafermap.xyz", timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any[]> {
  const host = new URL(baseUrl).host;
  const gaveUp = () => new WafermapError("timeout", `${host} did not answer within ${Math.round(timeoutMs / 1000)} s. Nothing was paid.`);
  const signal = AbortSignal.timeout(timeoutMs);
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/resources`, { signal }).catch((e) => {
    throw timedOut(e) ? gaveUp() : new WafermapError("network_error", `${host}: ${e?.message ?? "request failed"}`);
  });
  const j: any = await r.json().catch((e) => {
    if (timedOut(e)) throw gaveUp();
    return null;
  });
  if (!r.ok || !Array.isArray(j?.data)) throw new WafermapError("network_error", `${host} returned no catalog (HTTP ${r.status}).`);
  return j.data;
}

export class Wafermap {
  readonly account: LocalAccount;
  readonly baseUrl: string;
  network: Net;
  limits: Limits;
  private ledger: NonNullable<WafermapOptions["ledger"]>;
  private approveFn?: WafermapOptions["approve"];
  private rpc: Partial<Record<Net, string>>;
  private clients: Partial<Record<EvmNet, PublicClient>> = {};
  readonly solana: SolanaPayer | null;
  readonly solanaAddress: string | null;
  readonly timeoutMs: number;
  /** fetch with this wallet's time limit: a server that never answers cannot hold a call forever. */
  readonly fetch: typeof fetch;
  private readonly tokenPriceUsd?: () => Promise<number>;
  readonly endpointCheck: EndpointCheck | null;

  constructor(o: WafermapOptions) {
    const account = o.account ?? (o.privateKey ? privateKeyToAccount(o.privateKey) : null);
    if (!account) throw new WafermapError("no_account", "Pass privateKey or account.");
    this.account = account;
    this.baseUrl = (o.baseUrl ?? "https://wafermap.xyz").replace(/\/$/, "");
    this.network = o.network ?? "robinhood";
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    const mem: SpendEntry[] = [];
    this.ledger = o.ledger ?? { entries: () => mem, record: (e) => void mem.push(e) };
    this.approveFn = o.approve;
    this.rpc = o.rpc ?? {};
    this.timeoutMs = o.timeoutMs && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.tokenPriceUsd = o.tokenPriceUsd;
    this.endpointCheck = o.endpointCheck ?? null;
    this.fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs) });
    const sol = o.solana ?? (o.privateKey ? solanaKeyFromEvm(o.privateKey) : null);
    const solRpc = this.rpc.solana ?? `${this.baseUrl}/api/solana`;
    this.solana = sol ? { address: sol.address, sign: sol.sign, blockhash: () => latestBlockhash(solRpc, this.fetch), blockhashInfo: () => latestBlockhashInfo(solRpc, this.fetch) } : null;
    this.solanaAddress = sol?.address ?? o.solanaAddress ?? null;
  }

  get address() {
    return this.account.address;
  }

  client(n: EvmNet): PublicClient {
    return (this.clients[n] ??= createPublicClient({ chain: CHAINS[n], transport: http(this.rpc[n]) }) as PublicClient);
  }

  /** USD signed today (local midnight) on payments, not counting swaps. Every signed payment
   *  counts at its full amount, whatever the server answered, because a signed payment can be
   *  executed until it expires. `checkPayment` shows on-chain which ones were never used. */
  spentToday(): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.ledger
      .entries()
      .filter((e) => e.kind !== "swap" && e.at >= start.getTime() && (e.payer.toLowerCase() === this.address.toLowerCase() || e.payer === this.solanaAddress))
      .reduce((a, e) => a + e.usd, 0);
  }

  private async gate(a: Approval) {
    if (a.kind === "swap") {
      if (a.usd > this.limits.perSwap) throw new WafermapError("over_swap_cap", `$${a.usd.toFixed(2)} is above the per-swap cap of $${this.limits.perSwap}.`);
    } else {
      if (a.usd > this.limits.perPayment) throw new WafermapError("over_payment_cap", `$${a.usd} is above the per-payment cap of $${this.limits.perPayment}.`);
      if (this.spentToday() + a.usd > this.limits.perDay + 1e-9) throw new WafermapError("over_daily_cap", `This would pass the daily cap of $${this.limits.perDay} ($${this.spentToday().toFixed(4)} spent today).`);
    }
    if (this.approveFn && !(await this.approveFn(a))) throw new WafermapError("declined", "Declined.");
  }

  private prefer(n?: Net): Net[] {
    const first = n ?? this.network;
    return [first, ...NETS.filter((x) => x !== first)];
  }

  /** A second 402 means the payment itself was refused (usually: not enough balance). */
  private rejected(res: Response, body: any, paid: { req: Requirement } | null) {
    if (!paid || res.status !== 402) return null;
    const reason = typeof body?.error === "string" ? body.error : (body?.error?.message ?? "rejected");
    return new WafermapError("payment_rejected", `Payment refused (${reason}). Check that ${paid.req.chain.vm === "svm" ? this.solanaAddress : this.address} holds at least $${paid.req.usd} ${paid.req.chain.symbol} on ${paid.req.chain.name}.`);
  }

  /** Write the signed payment to the ledger before it leaves the machine. */
  private booked(kind: "resource" | "service", what: string, s: Signed): string {
    const id = crypto.randomUUID();
    this.ledger.record({ at: Date.now(), kind, what, usd: s.req.usd, network: s.req.chain.key, tx: null, payer: s.from, id, status: "signed", ...(s.auth ? { nonce: s.auth.nonce, validBefore: s.auth.validBefore } : {}), ...(s.sol ? { sig: s.sol.sig, memo: s.sol.memo, blockhash: s.sol.blockhash, ...(s.sol.slot !== undefined ? { slot: s.sol.slot } : {}) } : {}) });
    return id;
  }

  /** The outcome line for a booked payment. It adds nothing to the daily total. */
  private outcome(id: string, kind: "resource" | "service", what: string, s: Signed, status: PaymentStatus, tx: string | null, reported: number | null = null) {
    this.ledger.record({ at: Date.now(), kind, what, usd: 0, network: s.req.chain.key, tx, payer: s.from, of: id, status, reported });
  }

  /** The timeout error for `host`, saying whether a payment was signed and until when it can be executed. */
  private timeoutError(host: string, signed?: { validBefore?: number } | null) {
    const after = signed ? ` A payment had been signed and sent. It stays counted${signed.validBefore ? ` and can only be executed until ${new Date(signed.validBefore * 1000).toLocaleTimeString()}` : ""}; check with \`wafermap history --verify\`.` : " Nothing was paid.";
    return new WafermapError("timeout", `${host} did not answer within ${Math.round(this.timeoutMs / 1000)} s.${after}`);
  }

  /** Read a JSON body; a time-out while reading is reported, anything else gives `fallback`. */
  private async body<T>(res: Response, read: () => Promise<T>, fallback: T, host: string, signed?: { validBefore?: number } | null): Promise<T> {
    try {
      return await read();
    } catch (e) {
      if (timedOut(e)) throw this.timeoutError(host, signed);
      return fallback;
    }
  }

  // Check-sign-book runs one payment at a time in this process, so two calls started together
  // cannot both pass the daily cap on the same remaining budget. Across processes, see onSigned.
  private queue: Promise<void> = Promise.resolve();
  private acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const prev = this.queue;
    this.queue = prev.then(() => held);
    return prev.then(() => release);
  }

  private async paidFetch(kind: "resource" | "service", what: string, url: string, init: RequestInit, network?: Net, payIn?: "wafermap") {
    let id: string | null = null;
    let verdict: EndpointVerdict | null = null;
    let release: (() => void) | null = null;
    const unlock = () => {
      release?.();
      release = null;
    };
    try {
      const r = await x402fetch(url, init, {
        signer: this.account as any,
        solana: this.solana ?? undefined,
        prefer: this.prefer(network),
        fetch: this.fetch,
        payIn,
        tokenPriceUsd: this.tokenPriceUsd,
        approve: async (req) => {
          release = await this.acquire();
          await this.gate({ kind, what, usd: req.usd, network: req.chain.key, detail: req.asset === WAFERMAP_TOKEN ? "in $WAFERMAP at 50% off, burned" : `${req.chain.symbol} to ${req.payTo}` });
          // A third-party service, with endpointCheck set: ask the index before the signature. Wafermap's own
          // resources are never sent anywhere; the caps above have already passed.
          if (kind === "service" && this.endpointCheck) {
            verdict = await endpointVerdict(this.endpointCheck, url, { payTo: req.payTo, network: req.chain.caip }, this.fetch);
            const why = endpointRefusal(this.endpointCheck, verdict, req.payTo);
            if (why) throw new WafermapError("endpoint_check", why);
          }
        },
        onSigned: (s) => {
          id = this.booked(kind, what, s);
          unlock();
          // The queue serialises this process only. Another process using the same ledger (a second
          // MCP client, or the CLI next to the MCP server) may have booked since our check. Re-read
          // the shared total now that ours is in it: if the cap is passed, the signed payment is
          // dropped here, never sent, and its booking reversed. Two racing processes can both drop;
          // neither can both send.
          if (this.spentToday() > this.limits.perDay + 1e-9) {
            this.ledger.record({ at: Date.now(), kind, what, usd: -s.req.usd, network: s.req.chain.key, tx: null, payer: s.from, of: id, status: "aborted" });
            id = null;
            throw new WafermapError("over_daily_cap", `Another payment from this wallet used the daily cap of $${this.limits.perDay} at the same time. Nothing was sent.`);
          }
        },
      });
      return { ...r, id: id as string | null, verdict: verdict as EndpointVerdict | null };
    } catch (e: any) {
      // Signed but no answer: the payment stays counted (status "signed"); nothing more to write.
      if (e instanceof WafermapError) throw e;
      if (e instanceof X402Error) throw new WafermapError(e.code, e.message);
      if (timedOut(e)) throw this.timeoutError(new URL(url).host, id ? (this.ledger.entries().find((x) => x.id === id) ?? {}) : null);
      throw new WafermapError("network_error", `${new URL(url).host}: ${e?.cause?.message ?? e?.message ?? "request failed"}`);
    } finally {
      unlock();
    }
  }

  // ---- Wafermap resources ----

  async resources(): Promise<any[]> {
    return listResources(this.baseUrl, this.timeoutMs);
  }

  private passCache: string | null = null;

  /** A holder pass (shared/pass.ts) signed by this wallet, valid 24 h and reused until its last 10 minutes. It
   *  proves the wallet to Wafermap for what its $WAFERMAP unlocks (Pro free calls, x402 Tracker Pro). Signing
   *  a message moves no funds. */
  async holderPass(): Promise<string> {
    const p = decodePass(this.passCache);
    if (this.passCache && p && p.exp - 600 > Date.now() / 1000) return this.passCache;
    this.passCache = encodePass(await makePass({ address: this.account.address, signMessage: (a) => this.account.signMessage(a) }));
    return this.passCache;
  }

  // ---- Paying in $WAFERMAP (Permit2; the tokens are burned) ----

  /** Whether this wallet has approved Permit2 to move its $WAFERMAP (needed once before paying in $WAFERMAP). */
  async wafermapApproved(): Promise<boolean> {
    const a = (await this.client("robinhood").readContract({ address: WAFERMAP_TOKEN as `0x${string}`, abi: erc20Abi, functionName: "allowance", args: [this.address as `0x${string}`, PERMIT2 as `0x${string}`] })) as bigint;
    return a >= 10n ** 30n;
  }

  /** Approves Permit2 (Uniswap's, at its canonical address) to move this wallet's $WAFERMAP: one on-chain
   *  transaction on Robinhood Chain, paid in ETH. Each payment after that is a signature for one exact amount,
   *  spendable only by Wafermap's relayer for two minutes. */
  async approveWafermap(): Promise<string> {
    const wallet = createWalletClient({ account: this.account, chain: CHAINS.robinhood, transport: http(this.rpc.robinhood) });
    try {
      const tx = await wallet.writeContract({ address: WAFERMAP_TOKEN as `0x${string}`, abi: erc20Abi, functionName: "approve", args: [PERMIT2 as `0x${string}`, 2n ** 256n - 1n] });
      const rc = await this.client("robinhood").waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
      if (rc.status !== "success") throw new WafermapError("approve_failed", `The approval reverted: ${tx}`);
      return tx;
    } catch (e: any) {
      if (e instanceof WafermapError) throw e;
      throw new WafermapError("approve_failed", e?.shortMessage ?? e?.message ?? "The approval failed.");
    }
  }

  /** Reads /v1's server-sent events for an LLM call: delta pieces as they arrive, then receipt (or error), then done. */
  private async readStream(res: Response, onDelta: (text: string) => void) {
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let receipt: any = null;
    let done: any = null;
    let error: any = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        let data: any = null;
        try {
          data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
        } catch {}
        if (ev === "delta" && typeof data?.text === "string") onDelta(data.text);
        else if (ev === "receipt") receipt = data;
        else if (ev === "done") done = data;
        else if (ev === "error") error = data;
      }
    }
    return { receipt, done, error };
  }

  async call(id: string, input: Record<string, unknown> = {}, o: { network?: Net; payIn?: "stablecoin" | "wafermap"; onDelta?: (text: string) => void } = {}) {
    const inToken = o.payIn === "wafermap";
    // LLMs stream when asked (Accept: text/event-stream); the server settles only after the last piece. Free calls
    // and $WAFERMAP payments still answer in one JSON body, so both shapes are read below.
    const stream = !!o.onDelta && !inToken;
    if (inToken && id.startsWith("m/")) throw new WafermapError("token_not_offered", "Marketplace listings are paid in USDG or USDC to their seller, not in $WAFERMAP.");
    if (inToken && !(await this.wafermapApproved().catch(() => true))) throw new WafermapError("permit2_not_approved", "Paying in $WAFERMAP needs a one-time approval of Permit2. Run `wafermap approve-wafermap` (one transaction on Robinhood Chain, paid in ETH), then call again.");
    // X-Wafermap-Payer names this wallet so a $WAFERMAP holder is quoted the holder price, and the holder pass lets
    // a Pro holder's free calls apply (no payment is signed then). Both go to Wafermap only, never to third-party
    // services or marketplace sellers; the server checks the balance again itself.
    const pass = id.startsWith("m/") ? null : await this.holderPass();
    const go = () => this.paidFetch("resource", id, `${this.baseUrl}/v1/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-wafermap-payer": this.address, ...(stream ? { accept: "text/event-stream" } : {}), ...(pass ? { [PASS_HEADER]: pass } : {}) }, body: JSON.stringify(input) }, o.network, inToken ? "wafermap" : undefined);
    const settle = (r: Awaited<ReturnType<typeof go>>, out: any) => {
      if (!r.paid || !r.id) return;
      const status: PaymentStatus = r.res.status === 402 ? "refused" : r.res.ok && !out?.streamError ? "ok" : "failed";
      this.outcome(r.id, "resource", id, r.paid, status, out?.receipt?.tx ?? r.paid.tx, typeof out?.receipt?.amountUsd === "number" ? out.receipt.amountUsd : null);
    };
    const host = new URL(this.baseUrl).host;
    const read = (r: Awaited<ReturnType<typeof go>>) =>
      this.body(
        r.res,
        async (): Promise<any> => {
          if (!(stream && r.res.ok && (r.res.headers.get("content-type") ?? "").includes("text/event-stream"))) return r.res.json();
          const s = await this.readStream(r.res, o.onDelta!);
          return { resource: id, result: { text: s.done?.text ?? "", model: s.done?.model, usage: s.done?.usage }, receipt: s.receipt, streamError: s.error };
        },
        {} as any,
        host,
        r.paid?.auth ?? (r.paid ? {} : null),
      );
    let r = await go();
    let out: any = await read(r);
    settle(r, out);
    // The facilitator rotates its Solana fee payers; a quote that named one just rotated out is
    // refused before anything moves. Ask for a fresh quote once. (The refused one stays counted.)
    if (r.paid?.req.chain.vm === "svm" && r.res.status === 402 && /fee_payer/i.test(JSON.stringify(out))) {
      r = await go().catch((e) => {
        if (e?.code === "over_daily_cap") throw new WafermapError("over_daily_cap", `The facilitator refused the first Solana payment (its fee payer rotated). That signed payment still counts until it expires, and a second one would pass the daily cap of $${this.limits.perDay}. Try again in a few minutes or pay on another network.`);
        throw e;
      });
      out = await read(r);
      settle(r, out);
    }
    const { res, paid } = r;
    const refused = this.rejected(res, out, paid);
    if (refused) throw refused;
    if (out?.streamError) throw new WafermapError(out.streamError.code ?? "stream_failed", out.streamError.message ?? "The answer did not finish. You were not charged.");
    if (!res.ok) throw new WafermapError(out?.error?.code ?? "http_error", out?.error?.message ?? (typeof out?.error === "string" ? out.error : `HTTP ${res.status}`));
    return out as { resource: string; result: any; receipt: { network: string; asset: string; amountUsd: number; amountTokens?: number; burned?: boolean; payer: string; tx: string; ms: number } | null; free?: { wallet: string; left: number; perDay: number } };
  }

  // ---- Third-party x402 services ----

  async discover(query: string, limit = 10) {
    const host = new URL(this.baseUrl).host;
    const r = await this.fetch(`${this.baseUrl}/api/discover?q=${encodeURIComponent(query)}&limit=${limit}`).catch((e) => {
      throw timedOut(e) ? this.timeoutError(host) : new WafermapError("network_error", `${host}: ${e?.message ?? "request failed"}`);
    });
    const j: any = await this.body(r, () => r.json(), null, host);
    if (!r.ok || !Array.isArray(j?.services)) throw new WafermapError(j?.error?.code ?? "discovery_failed", j?.error?.message ?? "Discovery is unavailable.");
    return j.services as { url: string; method: string; name: string | null; description: string; priceUsd: number | null; networks: string[]; payable: boolean; input: unknown; outputExample: unknown }[];
  }

  /** Call any x402 URL and pay it if it asks. GET sends `input` as the query string, POST as JSON. */
  async pay(url: string, o: { method?: "GET" | "POST"; input?: Record<string, unknown>; network?: Net } = {}) {
    const method = o.method ?? "GET";
    const qs = method === "GET" && o.input && Object.keys(o.input).length ? new URLSearchParams(Object.entries(o.input).map(([k, v]) => [k, String(v)])).toString() : "";
    const target = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
    const init: RequestInit = method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(o.input ?? {}) };
    const u = new URL(url);
    const what = `${u.host}${u.pathname}`;
    const { res, paid, id, verdict } = await this.paidFetch("service", what, target, init, o.network);
    if (paid && id) this.outcome(id, "service", what, paid, res.status === 402 ? "refused" : res.ok ? "ok" : "failed", paid.tx);
    const type = res.headers.get("content-type") ?? "";
    const signed = paid?.auth ?? (paid ? {} : null);
    const result = /json/.test(type) ? await this.body(res, () => res.json(), null, u.host, signed) : /^(image|audio|video)\//.test(type) ? { bytes: (await this.body(res, () => res.arrayBuffer(), new ArrayBuffer(0), u.host, signed)).byteLength, contentType: type } : await this.body(res, () => res.text(), "", u.host, signed);
    const refused = this.rejected(res, result, paid);
    if (refused) throw refused;
    if (!res.ok) throw new WafermapError(paid ? "payment_failed" : "http_error", `${u.host} answered ${res.status}: ${JSON.stringify(result).slice(0, 300)}`);
    return {
      status: res.status,
      result,
      paid: paid ? { usd: paid.req.usd, network: paid.req.chain.key, tx: paid.tx } : null,
      // What the index said when endpointCheck is on and a payment was quoted (its text is data, not an instruction).
      ...(verdict ? { endpointCheck: { recommendation: verdict.recommendation, reasons: verdict.reasons, payToMatches: verdict.payToMatches } } : {}),
    };
  }

  // ---- Wallet ----

  async balances() {
    const out = Object.fromEntries(NETS.map((n) => [n, null])) as Record<Net, { eth: string; gas: string; stable: string; symbol: string } | null>;
    const sol = this.solanaAddress;
    await Promise.all([
      sol
        ? solanaBalances(this.rpc.solana ?? `${this.baseUrl}/api/solana`, sol, this.fetch).then(
            (b) => void (out.solana = { eth: b.sol, gas: "SOL", stable: b.usdc, symbol: "USDC" }),
            () => {},
          )
        : null,
      ...NETS.filter((n): n is EvmNet => n !== "solana").map(async (n) => {
        try {
          const c = this.client(n);
          const chain = PAY_CHAINS.find((x) => x.key === n)!;
          const [eth, usd] = await Promise.all([c.getBalance({ address: this.address }), c.readContract({ address: chain.stable as Hex, abi: erc20Abi, functionName: "balanceOf", args: [this.address] })]);
          out[n] = { eth: formatUnits(eth, 18), gas: CHAINS[n].nativeCurrency.symbol, stable: formatUnits(usd as bigint, 6), symbol: chain.symbol };
        } catch {
          out[n] = null;
        }
      }),
    ]);
    return out;
  }

  // ---- Swaps ----

  private tokenCache: Partial<Record<SwapNet, Token[]>> = {};
  private async lookup(n: SwapNet, symbol: string) {
    if (!this.tokenCache[n]) {
      const j: any = await this.fetch(`${this.baseUrl}/api/tokens?network=${n}`)
        .then((r) => r.json())
        .catch(() => null);
      this.tokenCache[n] = j?.tokens ?? TOKENS[n];
    }
    return this.tokenCache[n]!.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase()) ?? null;
  }

  async swapQuote(from: string, to: string, amount: string, network?: Net): Promise<SwapQuote> {
    const n = network ?? (isSwapNet(this.network) ? this.network : "robinhood");
    if (!isSwapNet(n)) throw new WafermapError("unsupported_network", "Swaps run on Robinhood Chain or Base. Use --network robinhood or base.");
    // `as any`: shared/ is type-checked against the parent project's copy of viem.
    const c = this.client(n) as any;
    try {
      const [tokenIn, tokenOut] = await Promise.all([resolveToken(n, from, c, (net, s) => this.lookup(net, s)), resolveToken(n, to, c, (net, s) => this.lookup(net, s))]);
      return await quoteSwap({ network: n, tokenIn, tokenOut, amount, fetch: this.fetch });
    } catch (e: any) {
      throw new WafermapError(e?.code ?? "quote_failed", e?.shortMessage ?? e?.message ?? "No quote.");
    }
  }

  async swap(quote: SwapQuote, o: { slippageBps?: number; step?: (s: string) => void } = {}) {
    if (!quote.amountInUsd) throw new WafermapError("no_usd_value", "This swap has no USD value, so the per-swap cap cannot be checked. Not sent.");
    await this.gate({ kind: "swap", what: `${quote.amountIn} ${quote.tokenIn.symbol} → ${quote.tokenOut.symbol}`, usd: quote.amountInUsd, network: quote.network, detail: `about ${quote.amountOut} ${quote.tokenOut.symbol}` });
    const wallet = createWalletClient({ account: this.account, chain: CHAINS[quote.network], transport: http(this.rpc[quote.network]) });
    try {
      const r = await executeSwap({ quote, wallet: wallet as any, client: this.client(quote.network) as any, slippageBps: o.slippageBps, step: o.step, fetch: this.fetch });
      this.ledger.record({ at: Date.now(), kind: "swap", what: `${quote.amountIn} ${quote.tokenIn.symbol} → ${quote.tokenOut.symbol}`, usd: 0, network: quote.network, tx: r.tx, payer: this.address });
      return r;
    } catch (e: any) {
      throw new WafermapError(e?.code ?? "swap_failed", e?.shortMessage ?? e?.message ?? "Swap failed.");
    }
  }
}

export type { SwapQuote, Token };
