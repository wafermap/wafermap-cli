---
name: wafermap
description: Pay per call for data and AI with the Wafermap x402 wallet. Use when the user wants something a Wafermap resource or an x402 service provides (tokenized stock prices and briefs, gas prices, Robinhood Chain or Base on-chain data, token due diligence, Polymarket prediction markets, web reading and translation, LLM, image, speech and transcription models), asks to pay an x402 URL, asks what the agent wallet holds or spent, or asks to set up Wafermap.
---

# Wafermap

Wafermap gives you an x402 wallet. It pays per call in USDG on Robinhood Chain, or in USDC on Solana, Base, Arbitrum, Polygon, Arc or Soneium. The key and the spending caps stay on the user's machine. Every paid call returns a receipt with a transaction hash.

## Two MCP servers

- `wafermap-catalog` (remote, https://wafermap.xyz/mcp) needs no setup. Use it to browse resources and read their input schemas. It cannot pay.
- `wafermap` (local, `npx @wafermapxyz/cli mcp`) is the wallet. It pays within the caps the user set. If it is not connected, the wallet is not set up yet: follow **Setup** below.

## If the servers are missing

Installed as a skill only (`npx skills add wafermap/wafermap-cli`, or this file read from https://wafermap.xyz/skill.md), the two servers are not there yet. Ask the user before changing their MCP config, then add them:

- Claude Code: `claude mcp add --transport http wafermap-catalog https://wafermap.xyz/mcp` and `claude mcp add wafermap -- npx -y @wafermapxyz/cli@0.4 mcp`
- Codex: `codex mcp add wafermap-catalog --url https://wafermap.xyz/mcp` and `codex mcp add wafermap -- npx -y @wafermapxyz/cli@0.4 mcp`
- Cursor or any other client: `{"mcpServers":{"wafermap-catalog":{"url":"https://wafermap.xyz/mcp"},"wafermap":{"command":"npx","args":["-y","@wafermapxyz/cli@0.4","mcp"]}}}`

Without any server you can still read the catalog and prices: `npx -y @wafermapxyz/cli@0.4 resources <words>` needs no wallet. Paying needs the `wafermap` server and the **Setup** below.

## Flow

1. Find the resource: `wafermap_resources` (optionally with `query` or `category`). For anything outside Wafermap's catalog, use `wafermap_discover` (third-party x402 services).
2. Read its input: `wafermap_resource_schema` on `wafermap-catalog`. The input is validated before any payment.
3. Run it with `wafermap_call` on the local `wafermap` server, or `wafermap_pay` for a third-party x402 URL.
4. Tell the user what it cost and give them the transaction hash from the receipt.

## Rules

- Check prices before calling. If a task needs many paid calls, say the expected total first.
- Never ask for, type or store the wallet password. Never suggest setting `WAFERMAP_PASSWORD` in a config file. Never run `wafermap export-key`.
- Caps are set by the user with `wafermap limits`. A budget mentioned in a prompt is not a cap. Do not raise caps yourself.
- If a call is refused by a cap, report it. Do not retry on another network to get around it.
- A failed call is not charged: Wafermap settles only after the resource worked.
- Swaps (`wafermap_swap`) are off unless the user turned them on. Always show the quote first.

## Setup

The user runs these commands in their own terminal, because they type the password themselves:

```bash
npx -y @wafermapxyz/cli@0.4 init
npx -y @wafermapxyz/cli@0.4 keychain on
npx -y @wafermapxyz/cli@0.4 limits --per-payment 0.1 --per-day 1
npx -y @wafermapxyz/cli@0.4 address
```

Next, they send a few dollars of USDC to the address shown (Base, Arbitrum, Polygon, or Solana for the Solana address) or USDG on Robinhood Chain. Payments are gasless. Then they reconnect the `wafermap` server: `/mcp` in Claude Code, a new session in Codex, or Developer: Reload Window in Cursor.

To approve every payment by hand, they can run `npx -y @wafermapxyz/cli@0.4 limits --mcp-confirm on`, then reconnect. This needs a client that can show MCP approval prompts; without one, payments are refused, never made silently.

Docs: https://wafermap.xyz/docs#skill (skill only), https://wafermap.xyz/docs#claude-code (Claude Code), https://wafermap.xyz/docs#codex (Codex), https://wafermap.xyz/docs#cursor (Cursor)
