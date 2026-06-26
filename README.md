# StorAlex

Self-hosted personal inventory for a storage unit. Pre-print QR labels, stick them on objects and storage places, then use a phone/tablet to scan things **in** and **out**, track every movement, and tag items for events/exhibitions.

- **Source of truth:** SQLite (single file). **Mirror:** a live-readable Google Sheet.
- **Client:** installable PWA, camera QR scanning.
- **Deploy:** one self-contained Docker image on a VPS, behind your TLS reverse proxy.
- **Stack:** TypeScript end to end (Fastify + better-sqlite3 + React/Vite).

## Status
Pre-implementation. The full design is in **[SPEC.md](./SPEC.md)**. Build rules and security guardrails for the implementing agent are in **[AGENTS.md](./AGENTS.md)**.

## For the next session
1. Read `SPEC.md` then `AGENTS.md`.
2. Start at milestone **M0** (SPEC §9).
3. Vet every dependency before installing (AGENTS.md). `.npmrc` already disables install scripts — keep it.

## Concept
- **Objects** (`item`): minimal data — name + photo. Live in a place, or are "out".
- **Places** (`place`): `unit → shelf → crate`, nestable. Hold objects and child places.
- **Codes** (`code`): QR labels with predictable IDs (`OBJ-000123`, `PLC-000045`). Many codes can point to one object (relabel / lost-label recovery).
- **Movements:** append-only history of in/out/relocate.
- **Tags:** flag items for an exhibition/event → instant packing list.
