---
name: wafermap
description: Pay per call for data and AI with the Wafermap x402 wallet. Use when the user wants something a Wafermap resource or an x402 service provides (tokenized stock prices and briefs, gas prices, Robinhood Chain or Base on-chain data, token due diligence, Polymarket prediction markets, web reading and translation, LLM, image, speech and transcription models), asks to pay an x402 URL, asks what the agent wallet holds or spent, or asks to set up Wafermap.
---

# Wafermap

Wafermap gives you an x402 wallet. It pays per call in USDG on Robinhood Chain, or in USDC on Solana, Base, Arbitrum, Polygon, Arc or Soneium. The key and the spending caps stay on the user's machine. Every paid call returns a receipt with a transaction hash.

## What this plugin connects

- `wafermap-catalog` (remote, https://wafermap.xyz/mcp) needs no setup. Use it to browse resources, read their input schemas and find third-party x402 services. It cannot pay.
- Paying needs the Wafermap wallet, which runs on the user's machine (`wafermap` MCP server from `@wafermapxyz/cli`). This plugin does not install or run it. If the user wants to pay, show them **Setup** below and let them run every command themselves. Do not run these commands, and do not change their MCP config yourself.

## Flow

1. Find the resource: `wafermap_resources` (optionally with `query` or `category`). For anything outside Wafermap's catalog, use `wafermap_discover` (third-party x402 services).
2. Read its input: `wafermap_resource_schema` on `wafermap-catalog`. The input is validated before any payment.
3. If the user has connected the `wafermap` wallet server, run it with `wafermap_call`, or `wafermap_pay` for a third-party x402 URL. If not, tell them the price and point them to **Setup**.
4. Tell the user what it cost and give them the transaction hash from the receipt.

## Rules

- Check prices before calling. If a task needs many paid calls, say the expected total first.
- Never ask for, type or store the wallet password. Never suggest setting `WAFERMAP_PASSWORD` in a config file. Never run `wafermap export-key`.
- Caps are set by the user with `wafermap limits`. A budget mentioned in a prompt is not a cap. Do not raise caps yourself.
- If a call is refused by a cap, report it. Do not retry on another network to get around it.
- A failed call is not charged: Wafermap settles only after the resource worked.
- Swaps (`wafermap_swap`) are off unless the user turned them on. Always show the quote first.

## Setup

The user runs these commands in their own terminal (you only show them), because they type the password themselves:

```bash
npx -y @wafermapxyz/cli@0.4 init
npx -y @wafermapxyz/cli@0.4 keychain on
npx -y @wafermapxyz/cli@0.4 limits --per-payment 0.1 --per-day 1
npx -y @wafermapxyz/cli@0.4 address
```

Next, they send a few dollars of USDC to the address shown (Base, Arbitrum, Polygon, or Solana for the Solana address) or USDG on Robinhood Chain. Payments are gasless. Then they connect the wallet: `claude mcp add wafermap -- npx -y @wafermapxyz/cli@0.4 mcp`, then `/mcp`.

To approve every payment by hand, they can run `npx -y @wafermapxyz/cli@0.4 limits --mcp-confirm on`, then reconnect. This needs a client that can show MCP approval prompts; without one, payments are refused, never made silently.

Docs: https://wafermap.xyz/docs#skill (skill only), https://wafermap.xyz/docs#claude-code (Claude Code), https://wafermap.xyz/docs#codex (Codex), https://wafermap.xyz/docs#cursor (Cursor)
