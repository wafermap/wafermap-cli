# Wafermap plugin (Claude directory edition)

This folder is the version of the Wafermap plugin submitted to the Claude directory. It connects only the remote catalog server (https://wafermap.xyz/mcp): browse resources, prices and input schemas, and find third-party x402 services. It cannot pay.

To pay per call, add the Wafermap wallet, which runs on your machine and keeps your key and caps there. The skill in this plugin walks you through it, and the full plugin with both servers is in [../plugin](../plugin).

Privacy: https://wafermap.xyz/privacy. License: MIT.

## Where data goes

- **wafermap.xyz** (the declared `wafermap-catalog` server): catalog searches and schema lookups. No personal data is asked for. Request logs are kept for a short time for debugging, under 30 days.
- **Only if you add the Wafermap wallet** (the skill's setup steps, which you run yourself): the `wafermap` CLI on your machine sends the input of each paid call to the resource that answers it (wafermap.xyz, or the third-party x402 service you choose), signs payments that an x402 facilitator settles on-chain (Coinbase's facilitator, or heyelsa.build for Robinhood Chain), and reads balances from public chain RPCs. Settled payments are public on-chain and listed at https://wafermap.xyz/proof.

Full details: https://wafermap.xyz/privacy
