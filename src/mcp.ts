// `wafermap mcp`: a stdio MCP server so Claude, Cursor and other MCP clients can use the local
// Wafermap wallet. Payments stay inside the caps in ~/.wafermap/config.json. Swaps are off
// unless you turn them on with `wafermap limits --mcp-swaps on`.
// The keystore password comes from the OS keychain (`wafermap keychain on`), or from WAFERMAP_PASSWORD
// in the MCP client's config, where it sits in plain text.
// With `wafermap limits --mcp-confirm on`, every payment and swap also waits for the person to approve it
// in the client (MCP elicitation); a client that cannot ask gets a refusal, never a silent payment.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WafermapError, mergeLog, type Approval } from "./core.js";
import { BACKEND_NAME, backend, keychainGet } from "./keychain.js";
import { openWallet } from "./local.js";
import { config, spendLog } from "./store.js";
import { VERSION } from "./version.js";

const NET = z.enum(["robinhood", "solana", "base", "arbitrum", "polygon", "arc", "soneium"]).optional().describe("Payment network: robinhood (USDG), or solana, base, arbitrum, polygon, arc or soneium (USDC). Defaults to your configured network.");
const SWAP_NET = z.enum(["robinhood", "base"]).optional().describe("Swap network: robinhood or base. Defaults to your configured network when it is one of these, else robinhood.");

function text(v: unknown) {
  return { content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] };
}

/** Media in results goes back as MCP image content instead of a giant base64 string. */
function result(v: any) {
  const content: any[] = [];
  const scrub = (x: any): any => {
    if (typeof x === "string" && /^data:(image|audio)\/[\w.+-]+;base64,/.test(x)) {
      const [head, data] = x.split(",");
      const mimeType = head.slice(5, head.indexOf(";"));
      if (mimeType.startsWith("image/")) content.push({ type: "image", data, mimeType });
      return `[${mimeType}, ${Math.round((data.length * 3) / 4 / 1024)} KB${mimeType.startsWith("image/") ? ", attached" : ""}]`;
    }
    if (Array.isArray(x)) return x.map(scrub);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, scrub(y)]));
    return x;
  };
  const clean = scrub(v);
  return { content: [{ type: "text" as const, text: JSON.stringify(clean, null, 2) }, ...content] };
}

function failure(e: any) {
  const msg = e instanceof WafermapError ? `${e.code}: ${e.message}` : String(e?.message ?? e);
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

/** Asks the person to approve one payment or swap, after the caps have passed and before anything is signed. */
async function confirmWithPerson(server: McpServer, a: Approval): Promise<boolean> {
  if (!server.server.getClientCapabilities()?.elicitation) {
    throw new WafermapError(
      "confirm_unavailable",
      "Per-payment confirmation is on, but this MCP client cannot show an approval prompt, so nothing was paid. Use a client that supports MCP elicitation, or turn it off with `wafermap limits --mcp-confirm off`.",
    );
  }
  const message =
    a.kind === "swap"
      ? `Approve this swap?

${a.what} (${a.detail}), worth about $${a.usd.toFixed(2)}, on ${a.network}.`
      : `Approve this payment?

$${a.usd} ${a.detail ?? ""} on ${a.network}
for ${a.what}`;
  const r = await server.server.elicitInput({
    mode: "form",
    message,
    requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve", description: "Sign and pay this one call", default: false } }, required: ["approve"] },
  });
  return r.action === "accept" && r.content?.approve === true;
}

export async function runMcp() {
  const fromEnv = process.env.WAFERMAP_PASSWORD || undefined;
  const password = fromEnv ?? keychainGet();
  if (!password) {
    process.stderr.write("No wallet password: run `wafermap keychain on` once in a terminal (recommended), or set WAFERMAP_PASSWORD in your MCP client's env.\n");
    process.exit(1);
  }
  const store = backend();
  if (fromEnv && store) process.stderr.write(`WAFERMAP_PASSWORD is set in plain text. Run \`wafermap keychain on\` to keep it in the ${BACKEND_NAME[store]} instead, then remove it from your MCP config.\n`);
  const server = new McpServer({ name: "wafermap", version: VERSION });
  const wm = openWallet(password, config().mcpConfirm ? (a) => confirmWithPerson(server, a) : undefined);

  server.registerTool(
    "wafermap_wallet",
    { title: "Wallet status", description: "The agent wallet's address, USDG/USDC and ETH balances on Robinhood Chain and Base, spending caps and today's spend.", inputSchema: {} },
    async () => {
      try {
        return text({ address: wm.address, balances: await wm.balances(), limits: wm.limits, spentTodayUsd: Number(wm.spentToday().toFixed(6)), network: wm.network, swapsEnabled: !!config().mcpSwaps, confirmEachPayment: !!config().mcpConfirm, endpointCheck: wm.endpointCheck ? "settled" : "off" });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "wafermap_resources",
    {
      title: "List Wafermap resources",
      description: "Pay-per-call tools on Wafermap: LLMs, image and audio models, web reading, on-chain data, tokenized stocks, prediction markets. Each has an id, a USD price and input fields.",
      inputSchema: { query: z.string().optional().describe("Filter by words in the name, summary or category.") },
    },
    async ({ query }) => {
      try {
        const q = query?.toLowerCase();
        const list = (await wm.resources()).filter((r: any) => !q || `${r.id} ${r.name} ${r.summary} ${r.category}`.toLowerCase().includes(q));
        return text(list.map((r: any) => ({ id: r.id, name: r.name, priceUsd: r.price, category: r.category, summary: r.summary, input: r.input ?? r.fields })));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "wafermap_call",
    {
      title: "Call a Wafermap resource",
      description: "Run one Wafermap resource and pay its exact price over x402 from the local wallet, within the per-payment and daily caps. Failed calls are not charged.",
      inputSchema: {
        resource: z.string().describe("Resource id, e.g. market-brief, prediction-markets, stock-signal, flux-2-dev."),
        input: z.record(z.string(), z.any()).optional().describe("Input fields for the resource."),
        network: NET,
        payIn: z.enum(["stablecoin", "wafermap"]).optional().describe("wafermap: pay Wafermap's own resources in $WAFERMAP at 50% off (the tokens are burned; needs `wafermap approve-wafermap` once). Default: USDG/USDC."),
      },
    },
    async ({ resource, input, network, payIn }) => {
      try {
        return result(await wm.call(resource, input ?? {}, { network, payIn }));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "wafermap_discover",
    {
      title: "Discover x402 services",
      description: "Search the open x402 index for third-party paid APIs (weather, search, enrichment, data…). Services marked payable accept USDG on Robinhood Chain or USDC on Solana, Base, Arbitrum, Polygon, Arc or Soneium and can be called with wafermap_pay.",
      inputSchema: { query: z.string().min(2).describe("What you need, in a few words."), limit: z.number().int().min(1).max(20).optional() },
    },
    async ({ query, limit }) => {
      try {
        return text(await wm.discover(query, limit ?? 10));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "wafermap_pay",
    {
      title: "Call and pay an x402 service",
      description: "Call any x402 URL (e.g. one found with wafermap_discover) and pay it if it answers 402, within the caps. GET sends input as query parameters, POST as a JSON body.",
      inputSchema: { url: z.string().url().startsWith("https://"), method: z.enum(["GET", "POST"]).optional(), input: z.record(z.string(), z.any()).optional(), network: NET },
    },
    async ({ url, method, input, network }) => {
      try {
        return result(await wm.pay(url, { method, input, network }));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "wafermap_swap_quote",
    {
      title: "Quote a token swap",
      description: "Best route through the KyberSwap aggregator on Robinhood Chain or Base. Tokens: ETH, WETH, USDG, USDC, Robinhood stock tickers (TSLA…) or a 0x address. Amount is in units of the token you sell.",
      inputSchema: { from: z.string(), to: z.string(), amount: z.string().describe('e.g. "0.01"'), network: SWAP_NET },
    },
    async ({ from, to, amount, network }) => {
      try {
        const q = await wm.swapQuote(from, to, amount, network);
        return text({ network: q.network, pay: `${q.amountIn} ${q.tokenIn.symbol}`, receiveAbout: `${q.amountOut} ${q.tokenOut.symbol}`, amountInUsd: q.amountInUsd, amountOutUsd: q.amountOutUsd, costPct: q.impactPct, gasUsd: q.gasUsd, swapsEnabled: !!config().mcpSwaps });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "wafermap_swap",
    {
      title: "Swap tokens",
      description: "Execute a swap from the local wallet (needs ETH for gas). Disabled unless the owner ran `wafermap limits --mcp-swaps on`. Always within the per-swap cap. Only swap when the user explicitly asked for this trade.",
      inputSchema: { from: z.string(), to: z.string(), amount: z.string(), network: SWAP_NET, slippagePct: z.number().min(0.05).max(5).optional().describe("Max slippage, default 1%.") },
    },
    async ({ from, to, amount, network, slippagePct }) => {
      if (!config().mcpSwaps) return failure(new WafermapError("swaps_disabled", "Swaps from MCP are off. The wallet owner can enable them with `wafermap limits --mcp-swaps on`."));
      try {
        const q = await wm.swapQuote(from, to, amount, network);
        const r = await wm.swap(q, { slippageBps: Math.round((slippagePct ?? 1) * 100) });
        return text({ swapped: `${q.amountIn} ${q.tokenIn.symbol} → ~${q.amountOut} ${q.tokenOut.symbol}`, minimumOut: r.amountOutMin, tx: r.tx, approveTx: r.approveTx ?? null, network: q.network });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "wafermap_history",
    { title: "Spending history", description: "Recent payments and swaps made by this wallet.", inputSchema: { limit: z.number().int().min(1).max(200).optional() } },
    async ({ limit }) => text(mergeLog(spendLog()).slice(-(limit ?? 30)).reverse()),
  );

  await server.connect(new StdioServerTransport());
  process.stderr.write(`Wafermap MCP ${VERSION} ready · wallet ${wm.address}\n`);
}
