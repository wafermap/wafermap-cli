import { SOLANA_CAIP, SOLANA_USDC, solanaPaymentSigned, type SolanaPayer } from "./solana";

// A small x402 buyer used by the web app, the CLI, the SDK and the MCP server.
// It pays any x402 endpoint (Wafermap's own /v1 or a third-party service found through
// discovery) that accepts the `exact` scheme in a USD stablecoin we know on an EVM chain
// (USDG on Robinhood Chain; USDC on Base, Arbitrum, Polygon, Arc, Soneium) or USDC on Solana, so every price
// can be checked against the user's caps in dollars. Solana is paid only when the caller passes
// a Solana payer (see ./solana).
// Both protocol versions are handled: v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers)
// and v1 (402 JSON body / X-PAYMENT header).

export type Hex = `0x${string}`;

/** Anything that can sign EIP-712 typed data for one address (a viem account works). */
export type Signer = {
  address: Hex;
  signTypedData: (args: { domain: any; types: any; primaryType: string; message: any }) => Promise<Hex>;
};

export type ChainKey = "robinhood" | "base" | "arbitrum" | "polygon" | "arc" | "soneium" | "solana";
export type Chain = { key: ChainKey; vm: "evm" | "svm"; id: number; caip: string; v1: string; stable: string; symbol: string; name: string; domain?: { name: string; version: string } };

const USDC_DOMAIN = { name: "USD Coin", version: "2" };
export const PAY_CHAINS: Chain[] = [
  { key: "robinhood", vm: "evm", id: 4663, caip: "eip155:4663", v1: "robinhood", stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", name: "Robinhood Chain", domain: { name: "Global Dollar", version: "1" } },
  { key: "solana", vm: "svm", id: 0, caip: SOLANA_CAIP, v1: "solana", stable: SOLANA_USDC, symbol: "USDC", name: "Solana" },
  { key: "base", vm: "evm", id: 8453, caip: "eip155:8453", v1: "base", stable: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "Base", domain: USDC_DOMAIN },
  { key: "arbitrum", vm: "evm", id: 42161, caip: "eip155:42161", v1: "arbitrum", stable: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", name: "Arbitrum", domain: USDC_DOMAIN },
  { key: "polygon", vm: "evm", id: 137, caip: "eip155:137", v1: "polygon", stable: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", name: "Polygon", domain: USDC_DOMAIN },
  // EIP-712 domains read from the token contracts (name(), version()) and checked against DOMAIN_SEPARATOR().
  { key: "arc", vm: "evm", id: 5042, caip: "eip155:5042", v1: "arc", stable: "0x3600000000000000000000000000000000000000", symbol: "USDC", name: "Arc", domain: { name: "USDC", version: "2" } },
  { key: "soneium", vm: "evm", id: 1868, caip: "eip155:1868", v1: "soneium", stable: "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369", symbol: "USDC", name: "Soneium", domain: { name: "Bridged USDC (Soneium)", version: "2" } },
];
export const EVM_CHAINS = PAY_CHAINS.filter((c) => c.vm === "evm");
export const CHAIN_KEYS = PAY_CHAINS.map((c) => c.key);

export type Requirement = {
  version: 1 | 2;
  chain: Chain;
  /** Base units, 6 decimals. */
  amount: string;
  usd: number;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  /** EVM: the token's EIP-712 domain. Solana: the facilitator's fee payer and an optional memo. */
  extra: { name?: string; version?: string; feePayer?: string; memo?: string };
  /** The requirement exactly as the server sent it (echoed back in the payment). */
  raw: any;
  /** Metered quotes only: the server announced eip2612GasSponsoring, so a missing Permit2 approval can be signed. */
  gasless?: boolean;
};

export type Quote = { version: 1 | 2; resource: any; accepts: Requirement[]; offered: string[]; inputError?: { code: string; message: string }; token?: TokenRequirement; metered?: Requirement[]; meterInfo?: MeterInfo };

// ---- Metered calls (x402 scheme "upto", Permit2 through the x402 upto proxy) ----
// The client signs a Permit2 transfer of at most the quoted ceiling. Only the x402 upto proxy (fixed here, never
// taken from the server) can spend it, only to the quote's payTo, and only when called by the facilitator named in
// the quote; the server then settles what the call used. Caps count the full ceiling, because that is what was
// signed. When the wallet has not approved Permit2 for the token, an EIP-2612 permit for exactly the ceiling rides
// along (extension eip2612GasSponsoring), so no gas is needed.
export const UPTO_PROXY = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002";
/** The longest a metered authorization stays valid: long answers settle after the model finishes. */
export const MAX_METERED_SECONDS = 300;
export type MeterInfo = { inputPer1kTokensUsd: number; outputPer1kTokensUsd: number; ceilingUsd: number; minimumUsd: number };
/** Reads the client needs for an EIP-2612 permit: the owner's Permit2 allowance and its permit nonce on the token. */
export type ChainReader = { allowance: (chain: Chain, owner: Hex, token: Hex) => Promise<bigint>; permitNonce: (chain: Chain, owner: Hex, token: Hex) => Promise<bigint> };
const UPTO_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;
const EIP2612_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Signs a metered payment for at most `req.amount` (the ceiling). Adds an EIP-2612 permit when the Permit2
 *  allowance is short and the server announced eip2612GasSponsoring. */
export async function signUptoPayment(signer: Signer, req: Requirement, resource: any, opts: { reader?: ChainReader; gasless?: boolean } = {}): Promise<{ name: string; value: string; deadline: number }> {
  const fac = String(req.raw?.extra?.facilitatorAddress ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(fac)) throw new X402Error("bad_quote", "The metered quote names no facilitator. Nothing was signed.");
  const nonce = BigInt(randomNonce()) >> 8n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds, MAX_METERED_SECONDS));
  const max = BigInt(req.amount);
  const witness = { to: req.payTo as Hex, facilitator: fac as Hex, validAfter: 0n };
  let signature: Hex;
  try {
    signature = await signer.signTypedData({ domain: { name: "Permit2", chainId: req.chain.id, verifyingContract: PERMIT2 as Hex }, types: UPTO_TYPES, primaryType: "PermitWitnessTransferFrom", message: { permitted: { token: req.asset as Hex, amount: max }, spender: UPTO_PROXY as Hex, nonce, deadline, witness } });
  } catch (e: any) {
    throw new X402Error("sign_rejected", e?.shortMessage ?? e?.message ?? "Signature rejected.");
  }
  let extensions: Record<string, unknown> | undefined;
  if (opts.gasless && opts.reader) {
    const allowance = await opts.reader.allowance(req.chain, signer.address, req.asset as Hex).catch(() => 0n);
    if (allowance < max) {
      const pn = await opts.reader.permitNonce(req.chain, signer.address, req.asset as Hex);
      let ps: Hex;
      try {
        ps = await signer.signTypedData({ domain: { name: req.extra.name, version: req.extra.version, chainId: req.chain.id, verifyingContract: req.asset as Hex }, types: EIP2612_TYPES, primaryType: "Permit", message: { owner: signer.address, spender: PERMIT2 as Hex, value: max, nonce: pn, deadline } });
      } catch (e: any) {
        throw new X402Error("sign_rejected", e?.shortMessage ?? e?.message ?? "Signature rejected.");
      }
      extensions = { eip2612GasSponsoring: { info: { from: signer.address, asset: req.asset, spender: PERMIT2, amount: max.toString(), nonce: pn.toString(), deadline: deadline.toString(), signature: ps, version: "1" } } };
    }
  }
  const permit2Authorization = { from: signer.address, permitted: { token: req.asset, amount: req.amount }, spender: UPTO_PROXY, nonce: nonce.toString(), deadline: deadline.toString(), witness: { to: req.payTo, facilitator: fac, validAfter: "0" } };
  return { name: "PAYMENT-SIGNATURE", value: b64encode(JSON.stringify({ x402Version: 2, resource, accepted: req.raw, payload: { signature, permit2Authorization }, ...(extensions ? { extensions } : {}) })), deadline: Number(deadline) };
}

// ---- Paying Wafermap in $WAFERMAP (Permit2, burned) ----
// A Permit2 PermitTransferFrom lets its spender send the tokens anywhere, so the client trusts the quote for nothing
// it can check itself:
//   - it signs only when the caller asks (`payIn: "wafermap"`), and the Wafermap SDK asks only for its own resources;
//   - the spender must be one of WAFERMAP_RELAYERS, fixed in this code, so a lookalike or compromised server
//     cannot name itself;
//   - the quote must name the canonical Permit2, the $WAFERMAP token and the dead address;
//   - the token amount is valued at the market price read by the client itself (GeckoTerminal), and refused when it
//     is worth more than the quote's USD figure allows; caps count the higher of the two.
export const WAFERMAP_TOKEN = "0xfda080f64d84c989cfc50ff18253542cfe502db3";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const DEAD = "0x000000000000000000000000000000000000dEaD";
export const TOKEN_SCHEME = "wafermap-permit2";
/** Wafermap's relayer wallets, the only spenders this client signs a $WAFERMAP permit for. Empty: paying in
 *  $WAFERMAP is off in this build. A new relayer address ships as a new client release. */
export const WAFERMAP_RELAYERS: string[] = ["0xD21547a387a9CfFb747211983c91f457742Ef00D"];
/** A permit may be worth at most this much more than the quote says (price moves between quote and check). */
const TOKEN_VALUE_SLACK = 1.25;

/** $WAFERMAP in USD, read by the client itself from GeckoTerminal. Throws when it cannot be read. */
export async function wafermapPriceUsd(f: typeof fetch = fetch): Promise<number> {
  const res = await f(`https://api.geckoterminal.com/api/v2/simple/networks/robinhood/token_price/${WAFERMAP_TOKEN}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const j: any = await res.json().catch(() => null);
  const p = Number(j?.data?.attributes?.token_prices?.[WAFERMAP_TOKEN]);
  if (!res.ok || !(p > 0)) throw new X402Error("price_unavailable", "The $WAFERMAP market price could not be read, so the amount cannot be checked. Nothing was signed; pay in USDG or USDC.");
  return p;
}
export type TokenRequirement = { amount: string; usd: number; spender: Hex; maxTimeoutSeconds: number; raw: any };
const PERMIT_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

function tokenOption(r: any): TokenRequirement | undefined {
  const e = r?.extra ?? {};
  const same = (a: unknown, b: string) => String(a ?? "").toLowerCase() === b.toLowerCase();
  if (r?.scheme !== TOKEN_SCHEME || r.network !== "eip155:4663" || !same(r.asset, WAFERMAP_TOKEN) || !same(r.payTo, DEAD) || !same(e.permit2, PERMIT2)) return;
  if (!/^\d{1,40}$/.test(String(r.amount)) || !/^0x[0-9a-fA-F]{40}$/.test(String(e.spender)) || !(Number(e.usd) > 0)) return;
  if (!WAFERMAP_RELAYERS.some((a) => same(e.spender, a))) return;
  return { amount: String(r.amount), usd: Number(e.usd), spender: e.spender as Hex, maxTimeoutSeconds: Number(r.maxTimeoutSeconds) || 120, raw: r };
}

/** Signs a Permit2 transfer of exactly the quoted $WAFERMAP to Wafermap's relayer, valid for at most 120 s. */
export async function signTokenPayment(signer: Signer, t: TokenRequirement, resource: any): Promise<{ name: string; value: string; deadline: number }> {
  const nonce = BigInt(randomNonce()) >> 8n; // any unused uint256; 248 random bits
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.min(t.maxTimeoutSeconds, 120));
  const permitted = { token: WAFERMAP_TOKEN as Hex, amount: BigInt(t.amount) };
  let signature: Hex;
  try {
    signature = await signer.signTypedData({ domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 as Hex }, types: PERMIT_TYPES, primaryType: "PermitTransferFrom", message: { permitted, spender: t.spender, nonce, deadline } });
  } catch (e: any) {
    throw new X402Error("sign_rejected", e?.shortMessage ?? e?.message ?? "Signature rejected.");
  }
  const payload = { owner: signer.address, permit: { permitted: { token: WAFERMAP_TOKEN, amount: t.amount }, nonce: nonce.toString(), deadline: deadline.toString() }, signature };
  return { name: "PAYMENT-SIGNATURE", value: b64encode(JSON.stringify({ x402Version: 2, resource, accepted: t.raw, payload })), deadline: Number(deadline) };
}

export class X402Error extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// UTF-8 safe base64 with globals that exist in browsers, Workers and Node 18+.
const b64encode = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

function chainOf(network: unknown): Chain | undefined {
  const n = String(network ?? "").toLowerCase();
  return PAY_CHAINS.find((c) => c.caip.toLowerCase() === n || c.v1 === n || (c.id > 0 && String(c.id) === n));
}

/** Read a 402 response into a quote. Only payable requirements are kept in `accepts`. */
export async function readQuote(res: Response): Promise<Quote> {
  let body: any = null;
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      body = JSON.parse(b64decode(header));
    } catch {
      /* fall back to the body */
    }
  }
  if (!body) body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.accepts)) throw new X402Error("not_x402", "The service answered 402 without x402 payment details.");
  const version: 1 | 2 = Number(body.x402Version) === 1 ? 1 : 2;
  const accepts: Requirement[] = [];
  const offered: string[] = [];
  let token: TokenRequirement | undefined;
  const metered: Requirement[] = [];
  for (const r of body.accepts) {
    offered.push(`${r.scheme ?? "?"}/${r.network ?? "?"}`);
    if (r?.scheme === TOKEN_SCHEME) {
      token ??= tokenOption(r);
      continue;
    }
    if (r?.scheme === "upto" && version === 2) {
      const ch = chainOf(r.network);
      if (ch && ch.vm === "evm" && String(r.asset ?? "").toLowerCase() === ch.stable.toLowerCase() && /^\d+$/.test(String(r.amount)) && /^0x[0-9a-fA-F]{40}$/.test(String(r.extra?.facilitatorAddress ?? "")) && /^0x[0-9a-fA-F]{40}$/.test(String(r.payTo ?? "")))
        metered.push({ version, chain: ch, amount: String(r.amount), usd: Number(r.amount) / 1e6, payTo: r.payTo, asset: r.asset, maxTimeoutSeconds: Number(r.maxTimeoutSeconds) || 120, extra: r.extra?.name && r.extra?.version ? { name: String(r.extra.name), version: String(r.extra.version) } : ch.domain!, raw: r });
      continue;
    }
    const chain = chainOf(r.network);
    if (!chain || r.scheme !== "exact") continue;
    if (chain.vm === "evm" ? String(r.asset ?? "").toLowerCase() !== chain.stable.toLowerCase() : r.asset !== chain.stable) continue;
    const amount = String(version === 1 ? r.maxAmountRequired : r.amount);
    if (!/^\d+$/.test(amount)) continue;
    let extra: Requirement["extra"];
    if (chain.vm === "svm") {
      if (typeof r.extra?.feePayer !== "string") continue;
      extra = { feePayer: r.extra.feePayer, ...(typeof r.extra.memo === "string" ? { memo: r.extra.memo } : {}) };
    } else extra = r.extra?.name && r.extra?.version ? { name: String(r.extra.name), version: String(r.extra.version) } : chain.domain!;
    accepts.push({ version, chain, amount, usd: Number(amount) / 1e6, payTo: r.payTo, asset: r.asset, maxTimeoutSeconds: Number(r.maxTimeoutSeconds) || 120, extra, raw: r });
  }
  const inputError = body.inputError?.message ? { code: String(body.inputError.code ?? "invalid_input"), message: String(body.inputError.message) } : undefined;
  const m = body.metered;
  const meterInfo = m && Number.isFinite(Number(m.ceilingUsd)) ? { inputPer1kTokensUsd: Number(m.inputPer1kTokensUsd), outputPer1kTokensUsd: Number(m.outputPer1kTokensUsd), ceilingUsd: Number(m.ceilingUsd), minimumUsd: Number(m.minimumUsd) } : undefined;
  const gasless = !!body.extensions?.eip2612GasSponsoring;
  return { version, resource: body.resource ?? null, accepts, offered, inputError, ...(token ? { token } : {}), ...(metered.length ? { metered: metered.map((q) => ({ ...q, gasless })) } : {}), ...(meterInfo ? { meterInfo } : {}) };
}

/** Pick the requirement to pay: the first preferred chain that is offered. */
export function choose(q: Quote, prefer: ChainKey[] = CHAIN_KEYS): Requirement {
  for (const k of prefer) {
    const r = q.accepts.find((a) => a.chain.key === k);
    if (r) return r;
  }
  throw new X402Error("no_supported_payment", q.offered.length ? `This service only accepts ${[...new Set(q.offered)].join(", ")}. Wafermap pays USDG on Robinhood Chain or USDC on Solana, Base, Arbitrum, Polygon, Arc or Soneium.` : "The service offered no payment option.");
}

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The longest an EVM payment authorization stays valid, whatever the server allows. Whoever receives
 *  a signed payment can execute it until then, so this bounds how long "failed calls cost $0" rests on
 *  the server's word. Long enough for a slow resource plus settlement (Wafermap needs at least 60 s). */
export const MAX_VALIDITY_SECONDS = 90;

const randomNonce = (): Hex => ("0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;

/** Sign the payment for the exact amount and return the header to send: an EIP-3009 transfer on
 *  EVM chains, a partially signed USDC transfer transaction on Solana. */
export async function signPayment(signer: Signer, req: Requirement, resource: any, solana?: SolanaPayer): Promise<{ name: string; value: string; auth?: SignedAuth; sol?: SignedSol }> {
  if (req.chain.vm === "svm") {
    if (!solana) throw new X402Error("no_solana_wallet", "This payment is on Solana and no Solana wallet was given.");
    let transaction: string;
    let sol: SignedSol;
    try {
      const s = await solanaPaymentSigned(solana, { amount: req.amount, payTo: req.payTo, asset: req.asset, feePayer: req.extra.feePayer!, memo: req.extra.memo });
      transaction = s.transaction;
      sol = { sig: s.signature, memo: s.memo, blockhash: s.blockhash, ...(s.slot !== undefined ? { slot: s.slot } : {}) };
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError") throw e; // the caller reports time-outs
      throw new X402Error("sign_failed", e?.message ?? "Could not build the Solana payment.");
    }
    if (req.version === 1) return { name: "X-PAYMENT", value: b64encode(JSON.stringify({ x402Version: 1, scheme: "exact", network: req.raw.network, payload: { transaction } })), sol };
    return { name: "PAYMENT-SIGNATURE", value: b64encode(JSON.stringify({ x402Version: 2, resource, accepted: req.raw, payload: { transaction } })), sol };
  }
  const nonce = randomNonce();
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds, MAX_VALIDITY_SECONDS));
  const message = { from: signer.address, to: req.payTo, value: BigInt(req.amount), validAfter: 0n, validBefore, nonce };
  let signature: Hex;
  try {
    signature = await signer.signTypedData({ domain: { name: req.extra.name, version: req.extra.version, chainId: req.chain.id, verifyingContract: req.asset as Hex }, types: TYPES, primaryType: "TransferWithAuthorization", message });
  } catch (e: any) {
    throw new X402Error("sign_rejected", e?.shortMessage ?? e?.message ?? "Signature rejected.");
  }
  const authorization = { from: signer.address, to: req.payTo, value: req.amount, validAfter: "0", validBefore: validBefore.toString(), nonce };
  const auth = { nonce, validBefore: Number(validBefore) };
  if (req.version === 1) return { name: "X-PAYMENT", value: b64encode(JSON.stringify({ x402Version: 1, scheme: "exact", network: req.raw.network, payload: { signature, authorization } })), auth };
  return { name: "PAYMENT-SIGNATURE", value: b64encode(JSON.stringify({ x402Version: 2, resource, accepted: req.raw, payload: { signature, authorization } })), auth };
}

/** Settlement details a server returns after a paid call, when it sends them. */
export function readSettlement(res: Response): { tx?: string; network?: string; success?: boolean } | null {
  const h = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (!h) return null;
  try {
    const j = JSON.parse(b64decode(h));
    return { tx: j.transaction ?? j.txHash ?? j.tx, network: j.network, success: j.success };
  } catch {
    return null;
  }
}

/** What an EVM payment authorized on-chain: anyone holding it can execute it until `validBefore`
 *  (unix seconds), once. `authorizationState(from, nonce)` on the token says whether it was used. */
export type SignedAuth = { nonce: Hex; validBefore: number };
/** What a Solana payment can be found by on-chain later (see checkSolanaPayment): our signature, its
 *  memo, its blockhash and the slot that blockhash was read at. */
export type SignedSol = { sig: string; memo: string; blockhash: string; slot?: number };
export type Signed = { req: Requirement; from: string; metered?: { ceiling: string; deadline: number }; auth?: SignedAuth; sol?: SignedSol; token?: { amount: string } };
export type PaidCall = { res: Response; paid: (Signed & { tx: string | null }) | null };

/**
 * Fetch an x402 resource, paying once when it answers 402.
 * `approve` sees the chosen requirement before anything is signed; throw to stop.
 * `onSigned` runs once the payment is signed and before it is sent: from then on the payment
 * can be executed whatever the server answers (or if it never answers), so a spend limit has to
 * count it here, at its full amount, not from what the server reports back.
 */
export async function x402fetch(
  url: string,
  init: RequestInit,
  opts: { signer: Signer | (() => Promise<Signer>); solana?: SolanaPayer; prefer?: ChainKey[]; approve?: (req: Requirement) => Promise<void> | void; onSigned?: (s: Signed) => void; fetch?: typeof fetch; payIn?: "stablecoin" | "wafermap"; tokenPriceUsd?: () => Promise<number>; meter?: boolean; reader?: ChainReader },
): Promise<PaidCall> {
  const f = opts.fetch ?? fetch;
  const first = await f(url, init);
  if (first.status !== 402) return { res: first, paid: null };
  const quote = await readQuote(first);
  // Some servers (Wafermap among them) quote even when the input is wrong; never sign for that.
  if (quote.inputError) throw new X402Error(quote.inputError.code, quote.inputError.message);
  if (opts.payIn === "wafermap") {
    const t = quote.token;
    if (!t) throw new X402Error("token_not_offered", "This call is not offered in $WAFERMAP right now (or not to a known Wafermap relayer). Pay in USDG or USDC.");
    // Value what would be signed at the client's own market price; the quote's USD figure is only a claim.
    const value = (Number(BigInt(t.amount) / 10n ** 12n) / 1e6) * (await (opts.tokenPriceUsd ?? (() => wafermapPriceUsd(fetch)))());
    if (value > t.usd * TOKEN_VALUE_SLACK + 0.0005) throw new X402Error("price_mismatch", `The quote asks for $WAFERMAP worth about $${value.toFixed(4)} at the market price, more than the $${t.usd} it states. Nothing was signed.`);
    const usd = Math.max(t.usd, Math.round(value * 1e6) / 1e6);
    // For caps and the ledger it is a Robinhood Chain payment worth `usd`.
    const req: Requirement = { version: 2, chain: PAY_CHAINS[0], amount: String(Math.round(usd * 1e6)), usd, payTo: DEAD, asset: WAFERMAP_TOKEN, maxTimeoutSeconds: t.maxTimeoutSeconds, extra: {}, raw: t.raw };
    if (opts.approve) await opts.approve(req);
    const signer = typeof opts.signer === "function" ? await opts.signer() : opts.signer;
    const header = await signTokenPayment(signer, t, quote.resource);
    const signed: Signed = { req, from: signer.address, token: { amount: t.amount } };
    opts.onSigned?.(signed);
    const headers = new Headers(init.headers);
    headers.set(header.name, header.value);
    const res = await f(url, { ...init, headers });
    return { res, paid: { ...signed, tx: readSettlement(res)?.tx ?? null } };
  }
  if (opts.meter) {
    // Metered: pay the tokens used, up to the quoted ceiling, on a network the server meters on.
    const pref = (opts.prefer ?? CHAIN_KEYS).filter((k) => k !== "solana");
    const req = pref.map((k) => quote.metered?.find((q) => q.chain.key === k)).find(Boolean);
    if (!req) throw new X402Error("metered_not_offered", quote.metered?.length ? `Metered calls are offered on ${quote.metered.map((q) => q.chain.name).join(", ")}; pick one of those networks.` : "This call is not offered as a metered (pay per token) call. Pay the flat price instead.");
    if (opts.approve) await opts.approve(req);
    const signer = typeof opts.signer === "function" ? await opts.signer() : opts.signer;
    const header = await signUptoPayment(signer, req, quote.resource, { reader: opts.reader, gasless: !!req.gasless });
    const signed: Signed = { req, from: signer.address, metered: { ceiling: req.amount, deadline: header.deadline } };
    opts.onSigned?.(signed);
    const headers = new Headers(init.headers);
    headers.set(header.name, header.value);
    const res = await f(url, { ...init, headers });
    return { res, paid: { ...signed, tx: readSettlement(res)?.tx ?? null } };
  }
  const req = choose(quote, (opts.prefer ?? CHAIN_KEYS).filter((k) => k !== "solana" || opts.solana));
  if (opts.approve) await opts.approve(req);
  const svm = req.chain.vm === "svm";
  const signer = svm ? null : typeof opts.signer === "function" ? await opts.signer() : opts.signer;
  const header = await signPayment(signer!, req, quote.resource, opts.solana);
  const signed: Signed = { req, from: svm ? opts.solana!.address : signer!.address, ...(header.auth ? { auth: header.auth } : {}), ...(header.sol ? { sol: header.sol } : {}) };
  opts.onSigned?.(signed);
  const headers = new Headers(init.headers);
  headers.set(header.name, header.value);
  const res = await f(url, { ...init, headers });
  return { res, paid: { ...signed, tx: readSettlement(res)?.tx ?? null } };
}
