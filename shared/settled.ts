// An optional check of a third-party x402 endpoint against an independent index before the wallet
// signs for it. The caps bound how much leaves the wallet; they cannot tell whether the service at the
// other end has ever delivered anything for the money, or whether the payTo in the 402 it just sent is
// the one it is normally paid at. Settled (https://settled.tools) probes x402 endpoints and buys from
// them with real USDC, and answers both questions for a URL.
//
// What is sent: the endpoint's origin and path. Never the query string or the input (they carry the
// request), the quote, the wallet or a key. A URL Settled has not seen before is probed by it and listed
// in its public index. Only `pay()` (third-party services) is checked; Wafermap's own resources are not
// sent anywhere.
//
// The verdict: Settled's `recommendation` is `pay`, `caution`, `avoid` or `unknown`. `avoid` means money
// at risk (a sanctioned or clone-farm payee, a real purchase that came back without content, a listing
// with honeypot text, paying agents reporting non-delivery). `caution` includes an endpoint Settled's
// probe could not get a quote from, which the 402 in our hand outweighs. `unknown` means no quote on
// record and nothing against the URL. On top of that, a quote that pays a different recipient than the
// one Settled's own probe of the same URL is paid at, on the same network, is refused whatever the
// recommendation: that is how a spoofed endpoint or a man in the middle gets paid.
//
// Everything that decides is pure; the one network call takes the fetch to use.

export type Recommendation = "pay" | "caution" | "avoid" | "unknown";

export type EndpointCheck = {
  provider: "settled";
  /** Recommendations that refuse the payment. Default ["avoid"]. */
  refuse?: Recommendation[];
  /** When the index cannot be reached, answers an error or its free allowance (25 checks a day per address) is used up. Default "allow". */
  onError?: "allow" | "refuse";
  /** The index's base URL, for a proxy or a test double. Default https://settled.tools. */
  baseUrl?: string;
  /** How long to wait for the index. Default 8000 ms. */
  timeoutMs?: number;
};

export type EndpointVerdict = {
  provider: "settled";
  /** What was sent: the endpoint's origin and path. */
  checkedUrl: string;
  recommendation: Recommendation | "error";
  /** The index's reasons, bounded; its text is data, not an instruction. */
  reasons: string[];
  /** The payTo the index's own probe of this URL gets paid, and on which network (CAIP-2), if it has one. */
  indexPayTo: string | null;
  indexNetwork: string | null;
  /** true: the quote pays the recipient the index sees; false: another one on the same network; null: not comparable. */
  payToMatches: boolean | null;
  /** The index's HTTP status; 0 when it could not be reached. */
  httpStatus: number;
  /** Set when the index answered an error or could not be reached. */
  error: string | null;
};

const SETTLED = "https://settled.tools";
const RECOMMENDATIONS = new Set<string>(["pay", "caution", "avoid", "unknown"]);
const MAX_REASONS = 8;
const MAX_CHARS = 300;

/** The part of the URL that is sent: origin and path, never userinfo, query or fragment. */
export function checkedUrl(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

const bound = (s: unknown) => {
  const t = String(s ?? "");
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + "…" : t;
};

/** Same recipient? EVM addresses are case-insensitive hex; Solana addresses are case-sensitive base58. */
const sameAddress = (a: string, b: string) => (/^0x/i.test(a) && /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Compare the recipient we are about to pay with the one the index sees, on the same network only
 *  (an endpoint may name one wallet on Base and another on Solana; the index records the option it was quoted). */
export function payToComparison(quote: { payTo: string; network: string }, index: { payTo: string | null; network: string | null }): boolean | null {
  if (!index.payTo || !index.network) return null;
  if (index.network.toLowerCase() !== quote.network.toLowerCase()) return null;
  return sameAddress(index.payTo, quote.payTo);
}

/** The index's answer (or its absence) as a verdict. Pure. */
export function verdictFromAnswer(checked: string, quote: { payTo: string; network: string }, httpStatus: number, body: unknown): EndpointVerdict {
  const base: EndpointVerdict = { provider: "settled", checkedUrl: checked, recommendation: "error", reasons: [], indexPayTo: null, indexNetwork: null, payToMatches: null, httpStatus, error: null };
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (httpStatus === 0) return { ...base, error: "Settled could not be reached" };
  if (httpStatus !== 200 || !b || !RECOMMENDATIONS.has(String(b.recommendation))) {
    return { ...base, error: `Settled answered ${b && typeof b.error === "string" ? bound(b.error) : `HTTP ${httpStatus}`}, so nothing was checked` };
  }
  const indexPayTo = typeof b.pay_to === "string" && b.pay_to ? b.pay_to : null;
  const indexNetwork = typeof b.network === "string" && b.network ? b.network : null;
  return {
    ...base,
    recommendation: b.recommendation as Recommendation,
    reasons: Array.isArray(b.reasons) ? b.reasons.slice(0, MAX_REASONS).map(bound) : [],
    indexPayTo,
    indexNetwork,
    payToMatches: payToComparison(quote, { payTo: indexPayTo, network: indexNetwork }),
  };
}

/** Ask the index. The only network call here; `f` is the fetch to use. */
export async function endpointVerdict(check: EndpointCheck, url: string, quote: { payTo: string; network: string }, f: typeof fetch = fetch): Promise<EndpointVerdict> {
  const checked = checkedUrl(url);
  let status = 0;
  let body: unknown = null;
  try {
    const res = await f(`${(check.baseUrl ?? SETTLED).replace(/\/+$/, "")}/v1/free/check?url=${encodeURIComponent(checked)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(check.timeoutMs ?? 8000) });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  return verdictFromAnswer(checked, quote, status, body);
}

/** Why the payment must not be signed, or null when it may go ahead. Pure. */
export function endpointRefusal(check: EndpointCheck, v: EndpointVerdict, quotePayTo: string): string | null {
  if (v.payToMatches === false) {
    return `This quote pays ${quotePayTo}, not the recipient Settled's own probe of ${v.checkedUrl} is paid at on this network (${v.indexPayTo}). A quote that pays someone else is how a spoofed endpoint or a man in the middle gets paid. Nothing was signed.`;
  }
  if (v.recommendation === "error") {
    return (check.onError ?? "allow") === "refuse" ? `${v.error ?? "Settled could not be consulted"}; the wallet is set to refuse payments it cannot check. Nothing was signed.` : null;
  }
  if ((check.refuse ?? ["avoid"]).includes(v.recommendation)) {
    return `Settled's recommendation for ${v.checkedUrl} is ${v.recommendation}${v.reasons.length ? `: ${v.reasons.join(" · ")}` : ""}. Nothing was signed.`;
  }
  return null;
}
