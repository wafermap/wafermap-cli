---
name: setup
description: Walk through setting up the Wafermap wallet (the user runs every command)
---

Help the user set up the Wafermap wallet. Do not run any of these commands yourself: show them, and the user runs them in their own terminal. Never ask for or handle the wallet password.

1. Wallet: `npx -y @wafermapxyz/cli@0.4 init` (asks for a password), then `npx -y @wafermapxyz/cli@0.4 keychain on`.
2. Caps: `npx -y @wafermapxyz/cli@0.4 limits --per-payment 0.1 --per-day 1`.
3. Funding: `npx -y @wafermapxyz/cli@0.4 address` shows where to send a few dollars of USDC (Base, Arbitrum, Polygon or Solana) or USDG on Robinhood Chain.
4. Connect the wallet to Claude Code: `claude mcp add wafermap -- npx -y @wafermapxyz/cli@0.4 mcp`, then `/mcp`.

The catalog in this plugin (`wafermap-catalog`) works without any of this. End with the single next step for the user.
