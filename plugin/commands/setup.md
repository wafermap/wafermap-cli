---
description: Check the Wafermap wallet and walk through setup
---

Check whether the Wafermap wallet is ready, without asking for or handling the password.

1. Run `npx -y @wafermapxyz/cli@0.4 address`. If it says there is no wallet, give the user the setup commands from the wafermap skill and stop. They must run `init` themselves, because it asks for a password.
2. Run `npx -y @wafermapxyz/cli@0.4 keychain`. If the password is not in the keychain, ask the user to run `npx -y @wafermapxyz/cli@0.4 keychain on` in their terminal.
3. Run `npx -y @wafermapxyz/cli@0.4 balance`. If every balance is zero, show the addresses to fund.
4. If the local `wafermap` MCP server is connected, call `wafermap_wallet` and report the caps and today's spend. Otherwise ask the user to run `/mcp` and reconnect `wafermap`.

End with one line: ready, or the single next step.
