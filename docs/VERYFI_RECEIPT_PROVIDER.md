# v0.3.4 Veryfi Receipt Provider

## Architecture

`Telegram -> Cloudflare Queue -> Veryfi OCR -> Wanxiang Receipt Resolver -> deterministic reconciliation -> Workers AI item category only -> D1 -> Telegram`

Veryfi is used as the document/OCR layer, not as the authoritative semantic parser.

The resolver deliberately does not trust Veryfi's ready-made description/amount association or inferred payment method. It rebuilds item-name to numeric-line associations from OCR reading order, then requires the existing deterministic amount reconciliation before D1 writes.

## Runtime secrets

The Worker supports the existing Veryfi Standard API credentials:

- `VERYFI_CLIENT_ID`
- `VERYFI_USERNAME`
- `VERYFI_API_KEY`

It also supports a future Bearer key via `VERYFI_BEARER_API_KEY`.

No credential values belong in Git.

## Veryfi request policy

- synchronous v8 `/api/v8/partner/documents`
- `document_type=receipt`
- `country=CN`
- `bounding_boxes=true`
- `confidence_details=true`
- crop enabled
- compute/enrichment disabled to reduce semantic guessing
- `auto_delete=true`
- raw receipt image is not persisted by Wanxiang

## Safety boundary

Workers AI only assigns one of Wanxiang's item categories to OCR-confirmed item names. AI output cannot change item name, quantity, unit price, line total, receipt total, transaction existence, or reconciliation.

A receipt is written only when:

- provider document confidence passes the existing threshold
- total confidence passes the existing threshold
- every item has a resolved name and valid numeric amount
- low-confidence-item ratio remains within the existing limit
- deterministic reconciliation is within 2 fen

## Regression fixture

`tests/receipt-resolver.test.ts` models the real Chinese supermarket failure mode observed on 2026-09-03: Veryfi correctly reads six numeric rows and the 52.18 total but shifts structured descriptions by one line. The fixture contains no original image or API response file. The expected resolver output is six sequential item names and line totals `[3.71, 9.90, 2.17, 14.50, 9.90, 12.00]`, summing to 52.18.

## Hermes handoff boundary

Hermes may configure Cloudflare secrets, run typecheck/tests/Wrangler dry-run, deploy the branch, run Telegram/Queue/D1 E2E, and report evidence. Hermes must not redesign or rewrite Wanxiang business code. Code defects are reported back for ChatGPT to fix on this branch.
