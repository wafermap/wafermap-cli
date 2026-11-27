# Wafermap catalog plugin (Claude directory edition)

A read-only plugin: it connects `wafermap-catalog` (https://wafermap.xyz/mcp/catalog), which has three tools:

- `wafermap_resources`: search Wafermap's pay-per-call resources and marketplace listings
- `wafermap_resource_schema`: one resource's price, input schema, example input and endpoint
- `wafermap_discover`: search third-party x402 services in the open x402 Bazaar index

It does not run resources, sign transactions or handle payments.

## Where data goes

Searches and schema lookups go to wafermap.xyz, the declared server. Third-party searches are answered from the x402 Bazaar index (Coinbase CDP) and partner discovery files that wafermap.xyz reads. No personal data is asked for. Request logs are kept for a short time for debugging, under 30 days. Full details: https://wafermap.xyz/privacy

License: MIT
