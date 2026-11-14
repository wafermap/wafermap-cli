// Spend reports: `wafermap statement --verify` checks each line against the chain. These tests feed verifyLine
// fake receipts and Solana transactions. Run: npm test (after npm run build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, toHex } from "viem";
import { parseStatement, verifyLine, verifyStatement } from "../dist/index.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FROM = "0xF2C1E81891E170d7813B6BfAab0416fE08500658";
const TO = "0xefa0FDf4Ca8FD79227fb9A19E5CFd24a2A864B81";
const TX = `0x${"ab".repeat(32)}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const line = (o = {}) => ({ date: "2026-11-05T10:00:00.000Z", resource: "gas-now", network: "eip155:8453", asset: "USDC", amountUsd: "0.02", token: USDC, amountUnits: "20000", from: FROM, to: TO, tx: TX, ...o });
const log = (o = {}) => ({ address: USDC.toLowerCase(), topics: [TRANSFER, pad(FROM.toLowerCase()), pad(TO.toLowerCase())], data: toHex(20000n, { size: 32 }), ...o });
const evm = (receipt) => ({ evm: () => ({ getTransactionReceipt: async () => (receipt instanceof Error ? Promise.reject(receipt) : receipt) }), solana: async () => null });

test("EVM: the exact transfer in a successful receipt is ok", async () => {
  assert.equal(await verifyLine(line(), evm({ status: "success", logs: [log()] })), "ok");
});

test("EVM: wrong amount, recipient, token or a reverted tx are caught", async () => {
  assert.equal(await verifyLine(line(), evm({ status: "success", logs: [log({ data: toHex(19999n, { size: 32 }) })] })), "mismatch");
  assert.equal(await verifyLine(line(), evm({ status: "success", logs: [log({ topics: [TRANSFER, pad(FROM.toLowerCase()), pad(FROM.toLowerCase())] })] })), "mismatch");
  assert.equal(await verifyLine(line(), evm({ status: "success", logs: [log({ address: "0x0000000000000000000000000000000000000001" })] })), "mismatch");
  assert.equal(await verifyLine(line(), evm({ status: "reverted", logs: [log()] })), "failed");
  assert.equal(await verifyLine(line({ amountUnits: "2e4" }), evm({ status: "success", logs: [log()] })), "mismatch");
});

test("EVM: missing tx is not_found, RPC trouble is error, unknown network unsupported", async () => {
  assert.equal(await verifyLine(line(), evm(new Error("Transaction receipt with hash 0x… could not be found."))), "not_found");
  assert.equal(await verifyLine(line(), evm(new Error("fetch failed"))), "error");
  assert.equal(await verifyLine(line({ network: "eip155:1" }), { evm: () => null, solana: async () => null }), "unsupported");
});

const SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const sline = (o = {}) => line({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", token: SOL_MINT, from: "Payer1111111111111111111111111111111111111", to: "Treas111111111111111111111111111111111111", tx: "5sig", amountUnits: "1000", ...o });
const bal = (owner, amount) => ({ owner, mint: SOL_MINT, uiTokenAmount: { amount: String(amount) } });
const sol = (tx) => ({ evm: () => null, solana: async () => tx });

test("Solana: balance changes per owner must match exactly", async () => {
  const ok = { meta: { err: null, preTokenBalances: [bal("Payer1111111111111111111111111111111111111", 5000), bal("Treas111111111111111111111111111111111111", 0)], postTokenBalances: [bal("Payer1111111111111111111111111111111111111", 4000), bal("Treas111111111111111111111111111111111111", 1000)] } };
  assert.equal(await verifyLine(sline(), sol(ok)), "ok");
  assert.equal(await verifyLine(sline({ amountUnits: "999" }), sol(ok)), "mismatch");
  assert.equal(await verifyLine(sline(), sol({ meta: { ...ok.meta, err: { InstructionError: [0, "x"] } } })), "failed");
  assert.equal(await verifyLine(sline(), sol(null)), "not_found");
});

test("verifyStatement totals and the totals check", async () => {
  const s = { kind: "wafermap-statement", version: 1, month: "2026-11", wallets: [FROM], totals: { calls: 2, usd: 0.04 }, lines: [line(), line({ tx: `0x${"cd".repeat(32)}` })] };
  const clients = { evm: () => ({ getTransactionReceipt: async ({ hash }) => ({ status: "success", logs: hash === TX ? [log()] : [] }) }), solana: async () => null };
  const r = await verifyStatement(s, clients);
  assert.deepEqual([r.ok, r.mismatch, r.confirmedUsd, r.linesUsd, r.totalsMatch], [1, 1, 0.02, 0.04, true]);
  const lied = await verifyStatement({ ...s, totals: { calls: 2, usd: 0.03 } }, clients);
  assert.equal(lied.totalsMatch, false);
  assert.throws(() => parseStatement("date,resource\n"), /not JSON/);
  assert.throws(() => parseStatement('{"lines":[]}'), /not a Wafermap statement/);
});
