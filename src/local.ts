// Opens the local wallet for the CLI and the MCP server: key from the encrypted keystore,
// caps and network from config.json, spending remembered in spend.jsonl.
import { Wafermap, type Approval } from "./core.js";
import { appendSpend, config, hasWallet, loadKey, rememberSolana, spendLog } from "./store.js";

export function openWallet(password: string, approve?: (a: Approval) => boolean | Promise<boolean>) {
  if (!hasWallet()) throw new Error("No wallet yet. Run `wafermap init` first.");
  const c = config();
  const wm = new Wafermap({
    privateKey: loadKey(password),
    baseUrl: process.env.WAFERMAP_URL,
    timeoutMs: Number(process.env.WAFERMAP_TIMEOUT_MS) || undefined,
    network: c.network,
    limits: c.limits,
    ledger: { entries: spendLog, record: appendSpend },
    approve,
    endpointCheck: c.endpointCheck ? { provider: "settled" } : undefined,
    rpc: { robinhood: process.env.WAFERMAP_RPC_ROBINHOOD, base: process.env.WAFERMAP_RPC_BASE, arbitrum: process.env.WAFERMAP_RPC_ARBITRUM, polygon: process.env.WAFERMAP_RPC_POLYGON, arc: process.env.WAFERMAP_RPC_ARC, soneium: process.env.WAFERMAP_RPC_SONEIUM, solana: process.env.WAFERMAP_RPC_SOLANA },
  });
  if (wm.solanaAddress) rememberSolana(wm.solanaAddress);
  return wm;
}
