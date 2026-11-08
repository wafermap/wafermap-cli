#!/usr/bin/env node
// The `wafermap` command. Run `wafermap help` for the list.
import { createInterface } from "node:readline";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PAY_NETWORKS, payNetworkOf } from "../shared/catalog";
import { NETS, WafermapError, checkPayment, holderInfo, isNet, listResources, mergeLog, type Approval, type Net } from "./core.js";
import { BACKEND_NAME, backend, keychainClear, keychainGet, keychainSet } from "./keychain.js";
import { openWallet } from "./local.js";
import { solanaKeyFromEvm } from "../shared/solana";
import { HOME, config, hasWallet, keystoreAddress, keystoreSolana, loadKey, rememberSolana, saveConfig, saveKey, spendLog } from "./store.js";
import { VERSION } from "./version.js";

const HELP = `wafermap ${VERSION}: an x402 wallet for agents (Robinhood Chain, Solana, Base, Arbitrum, Polygon, Arc, Soneium)

Wallet
  wafermap init [--import]              create (or import) the agent wallet, encrypted with a password
  wafermap address                      print the wallet addresses (EVM and Solana)
  wafermap balance                      USDG / USDC and gas on every payment network
  wafermap limits [--per-payment 0.1] [--per-day 1] [--per-swap 25] [--network <net>] [--mcp-swaps on|off] [--mcp-confirm on|off] [--endpoint-check on|off]
  wafermap history [--days 7] [--verify]  payments and swaps from this machine; --verify checks on-chain
  wafermap export-key [--solana]        print the private key, or the Solana key for Phantom/Solflare
  wafermap keychain [on|off]            keep the password for \`wafermap mcp\` in the OS keychain, not in plain text

Pay
  wafermap resources [words]            Wafermap's pay-per-call catalog
  wafermap call <id> [field=value ...]  run a resource and pay its price  (--json '{...}' for complex input)
  wafermap call <id> ... --pay wafermap pay a Wafermap resource in $WAFERMAP at 50% off (the tokens are burned)
  wafermap call <llm> ... --stream       print the answer as it arrives; you pay only once the model finishes
  wafermap approve-wafermap             one-time approval so the wallet can pay in $WAFERMAP (Robinhood Chain, ETH gas)
  wafermap holder                       what this wallet's $WAFERMAP unlocks: holder price, Pro free calls left today
  wafermap pass                         print a holder pass (X-Wafermap-Pass) for scripts and x402 Tracker Pro
  wafermap discover <words>             search third-party x402 services
  wafermap pay <url> [field=value ...]  call any x402 URL and pay it       (--post to send a JSON body)

Trade
  wafermap swap <amount> <from> <to>    swap through KyberSwap on robinhood or base, e.g. wafermap swap 0.01 ETH USDG

Agents
  wafermap mcp                          run as an MCP server (stdio); password from \`wafermap keychain on\` or WAFERMAP_PASSWORD

Common flags: --network robinhood|solana|base|arbitrum|polygon|arc|soneium   --yes (skip the confirmation)
Files live in ${HOME}. Docs: https://wafermap.xyz/docs#cli`;

type Args = { _: string[]; flags: Record<string, string | true> };
function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--") && !["yes", "post", "import", "stream"].includes(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = process.stdout;
      (rl as any)._writeToOutput = (s: string) => out.write(s.includes(question) ? question : s === "\r\n" || s === "\n" ? s : "");
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a);
    });
  });
}

async function password(): Promise<string> {
  return process.env.WAFERMAP_PASSWORD || (await ask("Wallet password: ", true));
}

const net = (v: unknown): Net | undefined => (isNet(v) ? v : v === undefined || v === true ? undefined : die(`--network must be one of ${NETS.join(", ")}`));
function die(msg: string): never {
  console.error(`✕ ${msg}`);
  process.exit(1);
}

/** field=value pairs (numbers stay numbers) plus an optional --json object. */
function inputOf(a: Args, from = 0): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (typeof a.flags.json === "string") {
    try {
      Object.assign(input, JSON.parse(a.flags.json));
    } catch {
      die("--json is not valid JSON");
    }
  }
  for (const kv of a._.slice(from)) {
    const i = kv.indexOf("=");
    if (i < 1) die(`"${kv}" should look like field=value`);
    const v = kv.slice(i + 1);
    input[kv.slice(0, i)] = /^-?\d+(\.\d+)?$/.test(v) && !/^0x/i.test(v) && v.length < 16 ? Number(v) : v;
  }
  return input;
}

function approver(yes: boolean) {
  return async (a: Approval) => {
    if (yes) return true;
    const what = a.kind === "swap" ? `Swap ${a.what} (${a.detail}), worth $${a.usd.toFixed(2)}` : `Pay $${a.usd} on ${a.network} for ${a.what}`;
    return /^y(es)?$/i.test((await ask(`${what}? [y/N] `)).trim());
  };
}

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const EXPLORER = (n: string) => PAY_NETWORKS[payNetworkOf(n) ?? "robinhood"].explorer;

function printResult(r: any) {
  const scrub = (x: any): any =>
    typeof x === "string" && x.startsWith("data:") ? `[${x.slice(5, x.indexOf(";"))}, ${Math.round(x.length / 1365)} KB, use --out to save]` : Array.isArray(x) ? x.map(scrub) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, scrub(y)])) : x;
  console.log(typeof r === "string" ? r : JSON.stringify(scrub(r), null, 2));
}

async function saveMedia(r: any, out: string) {
  const { writeFileSync } = await import("node:fs");
  const media = JSON.stringify(r).match(/data:[\w/.+-]+;base64,[A-Za-z0-9+/=]+/);
  if (!media) return console.log("(no image or audio in the result to save)");
  writeFileSync(out, Buffer.from(media[0].split(",")[1], "base64"));
  console.log(`Saved ${out}`);
}

async function main() {
  const a = parse(process.argv.slice(2));
  const cmd = a._.shift() ?? (a.flags.version ? "version" : "help");
  const yes = a.flags.yes === true;

  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    case "version":
    case "--version":
      return console.log(VERSION);

    case "init": {
      if (hasWallet()) die(`A wallet already exists (${keystoreAddress()}). Delete ${HOME}/keystore.json first if you really want a new one.`);
      let key: `0x${string}`;
      if (a.flags.import) {
        const k = (await ask("Private key (0x…): ", true)).trim();
        key = (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
        if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die("That is not a 64-character hex private key.");
      } else key = generatePrivateKey();
      const p1 = process.env.WAFERMAP_PASSWORD ?? (await ask("New password (8+ characters): ", true));
      if (!process.env.WAFERMAP_PASSWORD && p1 !== (await ask("Repeat password: ", true))) die("Passwords do not match.");
      const acct = privateKeyToAccount(key);
      const sol = solanaKeyFromEvm(key).address;
      saveKey(key, acct.address, p1, sol);
      saveConfig(config());
      console.log(`✓ Agent wallet ${acct.address}
  Solana address ${sol} (derived from the same key)
  Key encrypted in ${HOME}/keystore.json. Forget the password and the key is gone: run \`wafermap export-key\` to back it up.
  Fund it with a few dollars of USDC on Solana (Solana address), or USDG on Robinhood Chain or USDC on Base, Arbitrum, Polygon, Arc or Soneium (EVM address). Payments are gasless; swaps need a little ETH.
  Caps: $0.10 per payment, $1 per day, $25 per swap. Change with \`wafermap limits\`.`);
      return;
    }

    case "approve-wafermap": {
      const wm = openWallet(await password());
      if (await wm.wafermapApproved()) return console.log("✓ Already approved: this wallet can pay Wafermap in $WAFERMAP (wafermap call <id> --pay wafermap).");
      console.error(`This sends one transaction on Robinhood Chain from ${wm.address}, paid in ETH: approve Permit2 (Uniswap, 0x000000000022D473030F116dDEE9F6B43aC78BA3) to move this wallet's $WAFERMAP. Each payment after that is a separate signature for one exact amount, usable only by Wafermap's relayer for two minutes.`);
      if (!yes && !/^y(es)?$/i.test((await ask("Send the approval? [y/N] ")).trim())) die("Cancelled. Nothing was sent.");
      const tx = await wm.approveWafermap();
      return console.log(`✓ Approved · ${EXPLORER("robinhood")}/tx/${tx}`);
    }

    case "holder": {
      const addr = keystoreAddress() ?? die("No wallet yet. Run `wafermap init`.");
      const j = await holderInfo(addr, process.env.WAFERMAP_URL, Number(process.env.WAFERMAP_TIMEOUT_MS) || undefined);
      if (!j.active) return console.log("The $WAFERMAP holder program is off.");
      const n = (v: number) => Math.floor(v).toLocaleString("en-US");
      const k = j.perks;
      console.log(`${addr}\n  holds     ${n(j.balance)} $WAFERMAP on Robinhood Chain`);
      console.log(`  tier      ${j.tier === "pro" ? "Pro" : j.tier === "holder" ? "Holder" : "none"}`);
      console.log(`  price     ${j.holder ? `${j.percent}% off Wafermap resources on EVM networks` : `regular (hold ${n(j.minTokens)} for ${j.percent}% off)`}`);
      if (k) console.log(`  free      ${j.tier === "pro" ? `${k.freeLeftToday ?? "?"} of ${k.freeCallsPerDay} free calls left today (resources up to $${k.freeMaxUsd}); \`wafermap call\` uses them first` : `hold ${n(k.proMinTokens)} for ${k.freeCallsPerDay} free calls a day`}`);
      return console.log(`  tracker   ${j.holder ? "x402 Tracker Pro unlocked: wafermap.xyz/x402 (or \`wafermap pass\` for the API)" : `x402 Tracker Pro needs ${n(j.minTokens)}`}`);
    }

    case "pass": {
      const wm = openWallet(await password());
      const v = await wm.holderPass();
      console.error(`Holder pass for ${wm.address}, valid 24 hours. It proves you hold the wallet and moves no funds; anyone who has it can use your free calls until it expires, so keep it private. Send it as X-Wafermap-Pass:`);
      console.error(`  curl -H "X-Wafermap-Pass: $(wafermap pass)" https://wafermap.xyz/api/x402/pro/movers`);
      return console.log(v);
    }

    case "address": {
      const evm = keystoreAddress() ?? die("No wallet yet. Run `wafermap init`.");
      let sol = keystoreSolana();
      if (!sol && process.env.WAFERMAP_PASSWORD) rememberSolana((sol = solanaKeyFromEvm(loadKey(process.env.WAFERMAP_PASSWORD)).address));
      console.log(`evm     ${evm}`);
      return console.log(`solana  ${sol ?? "(unlock once to see it: WAFERMAP_PASSWORD=… wafermap address)"}`);
    }

    case "export-key": {
      const k = loadKey(await password());
      console.error("Anyone with this key can spend the wallet. Do not paste it into chats or websites.");
      if (a.flags.solana) {
        const s = solanaKeyFromEvm(k);
        rememberSolana(s.address);
        console.error(`Solana ${s.address}. Import this secret key in Phantom or Solflare ("Import private key"):`);
        return console.log(s.secretKey);
      }
      return console.log(k);
    }

    case "limits": {
      const c = config();
      const num = (k: string) => {
        const v = a.flags[k];
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!(n > 0)) die(`--${k} must be a positive number`);
        return n;
      };
      c.limits.perPayment = num("per-payment") ?? c.limits.perPayment;
      c.limits.perDay = num("per-day") ?? c.limits.perDay;
      c.limits.perSwap = num("per-swap") ?? c.limits.perSwap;
      if (c.limits.perPayment > c.limits.perDay) die("The per-payment cap cannot be above the daily cap.");
      c.network = net(a.flags.network) ?? c.network;
      if (a.flags["mcp-swaps"] !== undefined) c.mcpSwaps = a.flags["mcp-swaps"] === "on";
      if (a.flags["mcp-confirm"] !== undefined) c.mcpConfirm = a.flags["mcp-confirm"] === "on";
      if (a.flags["endpoint-check"] !== undefined) c.endpointCheck = a.flags["endpoint-check"] === "on";
      if (Object.keys(a.flags).length) saveConfig(c);
      return console.log(`Per payment $${c.limits.perPayment} · per day $${c.limits.perDay} · per swap $${c.limits.perSwap} · network ${c.network} · swaps from MCP ${c.mcpSwaps ? "on" : "off"} · confirm each MCP payment ${c.mcpConfirm ? "on" : "off"} · endpoint check ${c.endpointCheck ? "on (Settled)" : "off"}`);
    }

    case "history": {
      const days = Number(a.flags.days ?? 7);
      const since = Date.now() - days * 86400_000;
      const rows = mergeLog(spendLog()).filter((e) => e.at >= since).reverse(); // newest first
      if (!rows.length) return console.log(`Nothing in the last ${days} days.`);
      // --verify asks each token contract whether the signed payment was ever executed.
      const verify = a.flags.verify !== undefined;
      const RPC: Partial<Record<Net, string | undefined>> = { robinhood: process.env.WAFERMAP_RPC_ROBINHOOD, base: process.env.WAFERMAP_RPC_BASE, arbitrum: process.env.WAFERMAP_RPC_ARBITRUM, polygon: process.env.WAFERMAP_RPC_POLYGON, arc: process.env.WAFERMAP_RPC_ARC, soneium: process.env.WAFERMAP_RPC_SONEIUM, solana: process.env.WAFERMAP_RPC_SOLANA };
      // four at a time: public RPCs refuse bursts
      const chain: (Awaited<ReturnType<typeof checkPayment>> | null)[] = [];
      if (verify) {
        const txCount = new Map<string, number>();
        for (const e of rows) if (e.network === "solana" && e.tx) txCount.set(e.tx, (txCount.get(e.tx) ?? 0) + 1);
        let next = 0;
        await Promise.all(Array.from({ length: 4 }, async () => {
          while (next < rows.length) {
            const i = next++;
            const e = rows[i];
            // A line from before 0.4.7 is proven only by the server's transaction id, so one id given to
            // several Solana lines proves none of them.
            const shared = e.network === "solana" && !e.sig && !!e.tx && (txCount.get(e.tx) ?? 0) > 1;
            chain[i] = e.kind === "swap" ? null : await checkPayment(shared ? { ...e, tx: null } : e, RPC[e.network]);
          }
        }));
      }
      rows.forEach((e, i) => {
        const state = [e.status, chain[i] ? `on-chain: ${chain[i]}` : null].filter(Boolean).join(", ");
        console.log(`${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")}  ${e.kind.padEnd(8)}  ${e.kind === "swap" ? "      " : `$${e.usd}`.padEnd(8)}  ${e.network.padEnd(9)}  ${e.what}${state ? `  [${state}]` : ""}${e.tx ? `  ${EXPLORER(e.network)}/tx/${e.tx}` : ""}`);
      });
      const pays = rows.filter((e) => e.kind !== "swap");
      const total = pays.reduce((s, e) => s + e.usd, 0);
      console.log(`
Total $${total.toFixed(4)} in ${pays.length} payments. From 0.3.3 every payment counts at its full signed amount; older lines show what the server reported.`);
      if (verify) {
        const never = rows.filter((e, i) => e.kind !== "swap" && chain[i] === "unused").reduce((s, e) => s + e.usd, 0);
        const cancelled = rows.filter((e, i) => e.kind !== "swap" && chain[i] === "cancelled").reduce((s, e) => s + e.usd, 0);
        console.log(`On-chain: $${never.toFixed(4)} of that was signed but never executed and has expired${cancelled ? `, and $${cancelled.toFixed(4)} was cancelled by this wallet before it executed` : ""}. "used" = the token contract logged the transfer (AuthorizationUsed); "cancelled" = the nonce is spent but never executed (cancelAuthorization); "unknown" = an older log line with nothing to check by; "error" = the RPC did not answer, try again (Base's public RPC refuses log searches: for a payment with no transaction on record, set WAFERMAP_RPC_BASE to your own RPC).`);
      } else console.log("Add --verify to check on-chain which signed payments were executed.");
      return;
    }

    case "resources": {
      const q = a._.join(" ").toLowerCase();
      const list = await listResources(process.env.WAFERMAP_URL, Number(process.env.WAFERMAP_TIMEOUT_MS) || undefined);
      for (const x of list.filter((x: any) => !q || `${x.id} ${x.name} ${x.summary} ${x.category}`.toLowerCase().includes(q))) console.log(`${x.id.padEnd(22)} $${String(x.price).padEnd(7)} ${x.summary}`);
      return;
    }

    case "discover": {
      const q = a._.join(" ");
      if (q.length < 2) die("Say what you are looking for: wafermap discover weather");
      const wm = openWallet(await password());
      const list = await wm.discover(q, Number(a.flags.limit ?? 10));
      for (const s of list) console.log(`${s.payable ? "●" : "○"} ${s.priceUsd !== null ? `$${s.priceUsd}`.padEnd(8) : "—".padEnd(8)} ${s.method.padEnd(4)} ${s.url}\n    ${s.description.slice(0, 140)}${s.input ? `\n    input: ${JSON.stringify(s.input).slice(0, 140)}` : ""}`);
      return console.log(`\n● payable with USDG (Robinhood Chain) or USDC (Solana, Base, Arbitrum, Polygon, Arc, Soneium)   ○ other networks only`);
    }

    case "call": {
      const id = a._[0] ?? die("Which resource? e.g. wafermap call gas-now network=base");
      const wm = openWallet(await password(), approver(yes));
      const payIn = a.flags.pay === "wafermap" ? "wafermap" : a.flags.pay === undefined || a.flags.pay === "usd" ? undefined : die("--pay must be wafermap (or leave it out to pay in USDG/USDC)");
      // --stream prints an LLM's answer as it arrives; the payment settles only after the last piece.
      let streamed = false;
      const onDelta = a.flags.stream === true ? (t: string) => ((streamed = true), process.stdout.write(t)) : undefined;
      const out = await wm.call(id, inputOf(a, 1), { network: net(a.flags.network), payIn, onDelta });
      if (streamed) process.stdout.write("\n");
      if (out.receipt?.asset === "WAFERMAP") console.error(`✓ Paid ${out.receipt.amountTokens} $WAFERMAP (≈ $${out.receipt.amountUsd}), burned · ${EXPLORER(out.receipt.network)}/tx/${out.receipt.tx}`);
      else if (out.receipt) console.error(`✓ Paid $${out.receipt.amountUsd} ${out.receipt.asset} · ${EXPLORER(out.receipt.network)}/tx/${out.receipt.tx}`);
      else if (out.free) console.error(`✓ Free call ($WAFERMAP Pro) · ${out.free.left} of ${out.free.perDay} left today. Nothing was paid.`);
      if (typeof a.flags.out === "string") await saveMedia(out.result, a.flags.out);
      return streamed ? undefined : printResult(out.result);
    }

    case "pay": {
      const url = a._[0] ?? die("Which URL? e.g. wafermap pay https://example.com/api city=Paris");
      if (!/^https:\/\//.test(url)) die("Only https:// URLs.");
      const wm = openWallet(await password(), approver(yes));
      const out = await wm.pay(url, { method: a.flags.post ? "POST" : "GET", input: inputOf(a, 1), network: net(a.flags.network) });
      if (out.paid) console.error(`✓ Paid $${out.paid.usd} on ${out.paid.network}${out.paid.tx ? ` · ${EXPLORER(out.paid.network)}/tx/${out.paid.tx}` : ""}`);
      return printResult(out.result);
    }

    case "balance": {
      const addr = keystoreAddress() ?? die("No wallet yet. Run `wafermap init`.");
      const { Wafermap } = await import("./core.js");
      // Balances need no key: a throwaway account with the same address is enough to read.
      const wm = new Wafermap({ account: { ...privateKeyToAccount(generatePrivateKey()), address: addr as `0x${string}` } as any, solanaAddress: keystoreSolana() ?? undefined, baseUrl: process.env.WAFERMAP_URL, rpc: { robinhood: process.env.WAFERMAP_RPC_ROBINHOOD, base: process.env.WAFERMAP_RPC_BASE, arbitrum: process.env.WAFERMAP_RPC_ARBITRUM, polygon: process.env.WAFERMAP_RPC_POLYGON, arc: process.env.WAFERMAP_RPC_ARC, soneium: process.env.WAFERMAP_RPC_SONEIUM, solana: process.env.WAFERMAP_RPC_SOLANA } });
      const b = await wm.balances();
      console.log(addr);
      for (const n of NETS) console.log(`  ${n.padEnd(10)} ${b[n] ? `${Number(b[n]!.stable).toFixed(4)} ${b[n]!.symbol}   ${Number(b[n]!.eth).toPrecision(4)} ${b[n]!.gas}` : n === "solana" && !wm.solanaAddress ? "run `wafermap address` once with WAFERMAP_PASSWORD set" : "unreadable (RPC did not answer)"}`);
      return;
    }

    case "swap": {
      const [amount, from, to] = a._;
      if (!amount || !from || !to) die("Usage: wafermap swap <amount> <from> <to>  e.g. wafermap swap 0.01 ETH USDG");
      const wm = openWallet(await password(), approver(yes));
      const q = await wm.swapQuote(from, to, amount, net(a.flags.network));
      console.log(`${q.network}: pay ${q.amountIn} ${q.tokenIn.symbol}${q.amountInUsd ? ` ($${q.amountInUsd.toFixed(2)})` : ""} → about ${q.amountOut} ${q.tokenOut.symbol}${q.amountOutUsd ? ` ($${q.amountOutUsd.toFixed(2)})` : ""} · cost ${q.impactPct ?? "?"}% · gas ~$${q.gasUsd?.toFixed(3) ?? "?"}`);
      const slip = a.flags.slippage !== undefined ? Number(a.flags.slippage) : 1;
      if (!(slip > 0 && slip <= 5)) die("--slippage must be between 0 and 5 (percent)");
      const r = await wm.swap(q, { slippageBps: Math.round(slip * 100), step: (s) => console.error(`… ${s}`) });
      return console.log(`✓ Swapped · ${EXPLORER(q.network)}/tx/${r.tx}`);
    }

    case "keychain": {
      const b = backend() ?? die(`No OS keychain support on ${process.platform}. Use WAFERMAP_PASSWORD.`);
      const where = BACKEND_NAME[b];
      const what = a._[0];
      if (what === "on") {
        const pw = await password();
        loadKey(pw); // a wrong password stops here: nothing is stored
        keychainSet(pw);
        if (keychainGet() !== pw) die(`The ${where} did not give the password back. Nothing changed for \`wafermap mcp\`.`);
        return console.log(`✓ The wallet password is in the ${where}. \`wafermap mcp\` reads it from there: remove WAFERMAP_PASSWORD from your MCP client's config and restart the client.`);
      }
      if (what === "off") {
        keychainClear();
        if (keychainGet() !== null) die(`The ${where} still holds the password. Remove the "wafermap" entry by hand.`);
        return console.log(`✓ Removed from the ${where}. \`wafermap mcp\` needs WAFERMAP_PASSWORD again.`);
      }
      if (what !== undefined) die("Use: wafermap keychain [on|off]");
      const pw = keychainGet();
      if (!pw) return console.log(`Off. \`wafermap mcp\` reads WAFERMAP_PASSWORD. Run \`wafermap keychain on\` to keep it in the ${where}.`);
      try {
        loadKey(pw);
      } catch {
        die(`On (${where}), but it no longer unlocks the wallet. Run \`wafermap keychain on\` again.`);
      }
      return console.log(`On (${where}). It unlocks the wallet.`);
    }

    case "mcp": {
      const { runMcp } = await import("./mcp.js");
      return runMcp();
    }

    default:
      die(`Unknown command "${cmd}". Run \`wafermap help\`.`);
  }
}

main().catch((e) => {
  if (e instanceof WafermapError && e.code === "declined") die("Cancelled. Nothing was paid.");
  die(e instanceof WafermapError ? `${e.message} (${e.code})` : (e?.shortMessage ?? e?.message ?? String(e)));
});
