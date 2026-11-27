---
name: wafermap
description: Look up Wafermap's catalog of pay-per-call x402 APIs and third-party x402 services, with prices and input schemas. Use when the user asks which paid API or x402 service can do something (tokenized stock data, gas prices, on-chain data, prediction markets, web reading, AI models), what one costs, or what input it takes.
---

# Wafermap catalog

This plugin connects one read-only server, `wafermap-catalog` (https://wafermap.xyz/mcp/catalog). It answers questions about what exists and what it costs. It does not run resources, sign anything or handle payments.

## Flow

1. Search Wafermap's own resources and its marketplace listings with `wafermap_resources` (optional `query` or `category`).
2. For anything outside that catalog, search third-party x402 services with `wafermap_discover`.
3. Read one resource's price, input schema, example input and endpoint with `wafermap_resource_schema`.
4. Answer with the resource id, what it returns, its price per call and an example input.

## Rules

- Prices are in USD per call. Say them exactly as returned.
- Marketplace listings (ids starting with `m/`) and third-party services are run by their sellers, not by Wafermap. Say so when you recommend one.
- If the user wants to run or pay for a resource, explain that this plugin only browses the catalog and point them to https://wafermap.xyz/docs.
