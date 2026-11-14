// Spend reports. `wafermap statement` downloads a month of this wallet's payments to Wafermap and marketplace sellers
// (GET /api/statement on wafermap.xyz). `wafermap statement --verify <file>` checks every line of a statement JSON
// against the chain itself, without trusting Wafermap: for an EVM line, the transaction's receipt must hold a
// Transfer of exactly `amountUnits` of `token` from `from` to `to`; for a Solana line, the transaction must have
// succeeded and moved exactly that amount of the token from `from` to `to` (by token-balance changes per owner).
import { createPublicClient, getAddress, http, isAddress, parseAbiItem, toEventSelector, type Hex, type PublicClient } from "viem";
import { arbitrum, arc, base, polygon, robinhood, soneium } from "viem/chains";
import { solanaRpc, SOLANA_PUBLIC_RPC } from "../shared/solana";

export type StatementLine = { date: string; resource: string; network: string; asset: string; amountUsd: string; token: string; amountUnits: string; from: string; to: string; tx: string; explorer?: string | null };
export type Statement = { kind: "wafermap-statement"; version: number; month: string; wallets: string[]; totals: { calls: number; usd: number }; lines: StatementLine[]; truncated?: boolean };
export type LineCheck = "ok" | "mismatch" | "failed" | "not_found" | "unsupported" | "error";

const EVM: Record<string, any> = { "eip155:4663": robinhood, "eip155:8453": base, "eip155:42161": arbitrum, "eip155:137": polygon, "eip155:5042": arc, "eip155:1868": soneium };
const ENV_RPC: Record<string, string> = { "eip155:4663": "WAFERMAP_RPC_ROBINHOOD", "eip155:8453": "WAFERMAP_RPC_BASE", "eip155:42161": "WAFERMAP_RPC_ARBITRUM", "eip155:137": "WAFERMAP_RPC_POLYGON", "eip155:5042": "WAFERMAP_RPC_ARC", "eip155:1868": "WAFERMAP_RPC_SONEIUM", solana: "WAFERMAP_RPC_SOLANA" };
const TRANSFER = toEventSelector(parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"));
const topicAddr = (t: string | undefined) => (t ? getAddress(`0x${t.slice(-40)}`) : null);

/** Downloads a statement. `csv` returns the CSV text, otherwise the parsed JSON. */
export async function fetchStatement(wallets: string[], month: string, opts: { baseUrl?: string; csv?: boolean; timeoutMs?: number } = {}): Promise<Statement | string> {
  const url = `${(opts.baseUrl ?? "https://wafermap.xyz").replace(/\/$/, "")}/api/statement?wallet=${encodeURIComponent(wallets.join(","))}&month=${encodeURIComponent(month)}${opts.csv ? "&format=csv" : ""}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  if (!r.ok) {
    const j: any = await r.json().catch(() => null);
    throw new Error(j?.error?.message ?? `Statement request failed (${r.status}).`);
  }
  return opts.csv ? r.text() : ((await r.json()) as Statement);
}

/** Reads and sanity-checks a statement file's content. Throws on anything that is not a statement. */
export function parseStatement(text: string): Statement {
  let s: any;
  try {
    s = JSON.parse(text);
  } catch {
    throw new Error("That file is not JSON. Download the JSON statement (not the CSV) to verify it.");
  }
  if (s?.kind !== "wafermap-statement" || !Array.isArray(s.lines)) throw new Error("That file is not a Wafermap statement.");
  return s as Statement;
}

type Clients = { evm: (network: string) => Pick<PublicClient, "getTransactionReceipt"> | null; solana: (method: string, params: unknown[]) => Promise<any> };

/** Clients from env RPCs (WAFERMAP_RPC_<NET>) or the chains' public RPCs. */
export function defaultClients(env: Record<string, string | undefined> = process.env): Clients {
  const cache = new Map<string, PublicClient>();
  return {
    evm: (network) => {
      const chain = EVM[network];
      if (!chain) return null;
      if (!cache.has(network)) cache.set(network, createPublicClient({ chain, transport: http(env[ENV_RPC[network]] || undefined, { timeout: 30_000 }) }) as PublicClient);
      return cache.get(network)!;
    },
    solana: (method, params) => solanaRpc(env.WAFERMAP_RPC_SOLANA || SOLANA_PUBLIC_RPC, method, params),
  };
}

/** Checks one line against its chain. */
export async function verifyLine(l: StatementLine, clients: Clients): Promise<LineCheck> {
  try {
    if (!/^\d+$/.test(l.amountUnits)) return "mismatch";
    const want = BigInt(l.amountUnits);
    if (l.network.startsWith("solana:")) {
      const tx = await clients.solana("getTransaction", [l.tx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
      if (!tx) return "not_found";
      if (tx.meta?.err) return "failed";
      const delta = (owner: string) => {
        const sum = (xs: any[] | undefined) => (xs ?? []).filter((b) => b.owner === owner && b.mint === l.token).reduce<bigint>((a, b) => a + BigInt(b.uiTokenAmount?.amount ?? "0"), 0n);
        return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
      };
      return delta(l.from) === -want && delta(l.to) === want ? "ok" : "mismatch";
    }
    const client = clients.evm(l.network);
    if (!client) return "unsupported";
    if (!/^0x[0-9a-fA-F]{64}$/.test(l.tx) || !isAddress(l.token) || !isAddress(l.from) || !isAddress(l.to)) return "mismatch";
    const receipt = await client.getTransactionReceipt({ hash: l.tx as Hex }).catch((e: any) => (/not.*found|could not be found/i.test(String(e?.message)) ? null : Promise.reject(e)));
    if (!receipt) return "not_found";
    if (receipt.status !== "success") return "failed";
    const hit = receipt.logs.some(
      (g) => g.address.toLowerCase() === l.token.toLowerCase() && g.topics[0] === TRANSFER && topicAddr(g.topics[1]) === getAddress(l.from) && topicAddr(g.topics[2]) === getAddress(l.to) && BigInt(g.data) === want,
    );
    return hit ? "ok" : "mismatch";
  } catch {
    return "error";
  }
}

/** Checks every line, four at a time (public RPCs refuse bursts), and adds up what the chain confirms. */
export async function verifyStatement(s: Statement, clients: Clients = defaultClients(), onLine?: (i: number, r: LineCheck) => void) {
  const results: LineCheck[] = new Array(s.lines.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < s.lines.length) {
        const i = next++;
        results[i] = await verifyLine(s.lines[i], clients);
        onLine?.(i, results[i]);
      }
    }),
  );
  const usd = (pick: (r: LineCheck) => boolean) => Math.round(s.lines.reduce((a, l, i) => a + (pick(results[i]) ? Number(l.amountUsd) : 0), 0) * 1e6) / 1e6;
  const count = (r: LineCheck) => results.filter((x) => x === r).length;
  const linesUsd = usd(() => true);
  return {
    results,
    lines: s.lines.length,
    ok: count("ok"),
    mismatch: count("mismatch"),
    failed: count("failed"),
    notFound: count("not_found"),
    unsupported: count("unsupported"),
    error: count("error"),
    confirmedUsd: usd((r) => r === "ok"),
    linesUsd,
    // The totals block must add up to the lines it sits next to.
    totalsMatch: s.totals?.calls === s.lines.length && Math.abs((s.totals?.usd ?? NaN) - linesUsd) < 1e-6,
  };
}
