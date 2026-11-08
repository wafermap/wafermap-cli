// The optional endpoint check (shared/settled.ts): the index's answer becomes a verdict, the verdict a
// refusal or not, only the URL's origin and path leave the wallet, and pay() signs nothing when the
// index says avoid or sees another recipient. The index is a local double; nothing here reaches the
// network. Run: npm test (after npm run build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generatePrivateKey } from "viem/accounts";
import { Wafermap, checkedUrl, verdictFromAnswer, endpointRefusal, payToComparison } from "../dist/index.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const quote = { payTo: PAY_TO, network: "eip155:8453" };
const settled = { provider: "settled" };
const answer = (over = {}) => ({ url: "https://api.example.com/search", status: "live", recommendation: "pay", reasons: ["a real payment by Settled's scout came back with content"], pay_to: PAY_TO, network: "eip155:8453", ...over });

test("only the origin and path are sent", () => {
  assert.equal(checkedUrl("https://user:pw@api.example.com:8443/v1/search?q=secret#frag"), "https://api.example.com:8443/v1/search");
});

test("pay passes, avoid refuses by default, caution and unknown are the operator's choice", () => {
  const pay = verdictFromAnswer("https://api.example.com/search", quote, 200, answer());
  assert.equal(pay.recommendation, "pay");
  assert.equal(pay.payToMatches, true);
  assert.equal(endpointRefusal(settled, pay, PAY_TO), null);
  const avoid = verdictFromAnswer("https://api.example.com/search", quote, 200, answer({ recommendation: "avoid", reasons: ["the last real payment by Settled's scout came back without usable content"] }));
  assert.match(endpointRefusal(settled, avoid, PAY_TO), /avoid: the last real payment/);
  for (const r of ["caution", "unknown"]) {
    const v = verdictFromAnswer("https://api.example.com/search", quote, 200, answer({ recommendation: r }));
    assert.equal(endpointRefusal(settled, v, PAY_TO), null, r);
    assert.ok(endpointRefusal({ provider: "settled", refuse: ["avoid", r] }, v, PAY_TO), `${r} refused when listed`);
  }
});

test("a quote paying another recipient on the same network is refused whatever the recommendation", () => {
  const v = verdictFromAnswer("https://api.example.com/search", { payTo: OTHER, network: "eip155:8453" }, 200, answer());
  assert.equal(v.payToMatches, false);
  const why = endpointRefusal(settled, v, OTHER);
  assert.ok(why.includes(OTHER) && why.includes(PAY_TO), why);
  assert.equal(payToComparison({ payTo: OTHER, network: "eip155:137" }, { payTo: PAY_TO, network: "eip155:8453" }), null, "another network is not compared");
  assert.equal(payToComparison({ payTo: PAY_TO.toLowerCase(), network: "EIP155:8453" }, { payTo: PAY_TO, network: "eip155:8453" }), true, "EVM addresses and networks compare case-insensitively");
  assert.equal(payToComparison({ payTo: "So11111111111111111111111111111111111111112", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, { payTo: "so11111111111111111111111111111111111111112", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), false, "Solana addresses are case-sensitive");
});

test("an index error allows by default and refuses under onError refuse; odd answers are errors", () => {
  const used = verdictFromAnswer("https://api.example.com/search", quote, 429, { error: "free_quota_exhausted" });
  assert.equal(used.recommendation, "error");
  assert.equal(endpointRefusal(settled, used, PAY_TO), null);
  assert.match(endpointRefusal({ provider: "settled", onError: "refuse" }, used, PAY_TO), /free_quota_exhausted/);
  assert.equal(verdictFromAnswer("https://api.example.com/search", quote, 0, null).error, "Settled could not be reached");
  assert.equal(verdictFromAnswer("https://api.example.com/search", quote, 200, answer({ recommendation: "buy now" })).recommendation, "error");
  const many = verdictFromAnswer("https://api.example.com/search", quote, 200, answer({ reasons: Array.from({ length: 12 }, () => "x".repeat(400)) }));
  assert.equal(many.reasons.length, 8);
  assert.ok(many.reasons.every((r) => r.length === 301));
});

/** A mock x402 service: quotes $0.05 in USDC on Base to PAY_TO, answers once paid. */
async function mockService() {
  const payments = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sig = req.headers["payment-signature"];
      if (!sig) {
        const q = { x402Version: 2, resource: { url: req.url }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "50000", asset: USDC_BASE, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] };
        res.writeHead(402, { "payment-required": b64(q), "content-type": "application/json" });
        return res.end(JSON.stringify(q));
      }
      payments.push(sig);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { ok: true } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, payments, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

/** A mock index: records what it was asked and answers what the test sets. */
async function mockIndex() {
  const asked = [];
  const state = { status: 200, body: answer() };
  const server = createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(JSON.stringify(state.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, state, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

function wallet(baseUrl, endpointCheck) {
  const log = [];
  const wm = new Wafermap({ privateKey: generatePrivateKey(), baseUrl, network: "base", limits: { perPayment: 0.1, perDay: 1 }, ledger: { entries: () => log, record: (e) => void log.push(e) }, endpointCheck });
  return { wm, log };
}

test("pay(): with the check on, the index is asked the origin and path, and a pay answer lets the payment through", async () => {
  const s = await mockService();
  const ix = await mockIndex();
  try {
    const { wm } = wallet(s.url, { provider: "settled", baseUrl: ix.url });
    const out = await wm.pay(`${s.url}/svc`, { input: { q: "secret" } });
    assert.equal(ix.asked.length, 1);
    assert.equal(ix.asked[0], "/v1/free/check?url=" + encodeURIComponent(`${s.url}/svc`), "the query string stays home");
    assert.equal(s.payments.length, 1);
    assert.equal(out.endpointCheck.recommendation, "pay");
    assert.equal(out.endpointCheck.payToMatches, true);
    assert.equal(wm.spentToday(), 0.05);
  } finally {
    await Promise.all([s.close(), ix.close()]);
  }
});

test("pay(): avoid means nothing is signed and nothing counts", async () => {
  const s = await mockService();
  const ix = await mockIndex();
  try {
    ix.state.body = answer({ recommendation: "avoid", reasons: ["the last real payment by Settled's scout came back without usable content"] });
    const { wm, log } = wallet(s.url, { provider: "settled", baseUrl: ix.url });
    await assert.rejects(wm.pay(`${s.url}/svc`), (e) => e.code === "endpoint_check" && /avoid/.test(e.message));
    assert.equal(s.payments.length, 0);
    assert.equal(log.length, 0);
    assert.equal(wm.spentToday(), 0);
  } finally {
    await Promise.all([s.close(), ix.close()]);
  }
});

test("pay(): a quote paying someone the index does not see at this URL is refused even on a pay answer", async () => {
  const s = await mockService();
  const ix = await mockIndex();
  try {
    ix.state.body = answer({ pay_to: OTHER });
    const { wm } = wallet(s.url, { provider: "settled", baseUrl: ix.url });
    await assert.rejects(wm.pay(`${s.url}/svc`), (e) => e.code === "endpoint_check" && e.message.includes(OTHER));
    assert.equal(s.payments.length, 0);
  } finally {
    await Promise.all([s.close(), ix.close()]);
  }
});

test("pay(): an index that is out of free checks does not stop the payment unless onError is refuse", async () => {
  const s = await mockService();
  const ix = await mockIndex();
  try {
    ix.state.status = 429;
    ix.state.body = { error: "free_quota_exhausted" };
    const open = wallet(s.url, { provider: "settled", baseUrl: ix.url });
    const out = await open.wm.pay(`${s.url}/svc`);
    assert.equal(s.payments.length, 1);
    assert.equal(out.endpointCheck.recommendation, "error");
    const closed = wallet(s.url, { provider: "settled", baseUrl: ix.url, onError: "refuse" });
    await assert.rejects(closed.wm.pay(`${s.url}/svc`), (e) => e.code === "endpoint_check");
    assert.equal(s.payments.length, 1);
  } finally {
    await Promise.all([s.close(), ix.close()]);
  }
});

test("pay(): without endpointCheck nothing is asked and the result has no endpointCheck field", async () => {
  const s = await mockService();
  const ix = await mockIndex();
  try {
    const { wm } = wallet(s.url, undefined);
    const out = await wm.pay(`${s.url}/svc`);
    assert.equal(ix.asked.length, 0);
    assert.equal(s.payments.length, 1);
    assert.equal("endpointCheck" in out, false);
  } finally {
    await Promise.all([s.close(), ix.close()]);
  }
});
