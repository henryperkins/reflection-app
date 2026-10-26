# Swiss Ephemeris licensing decision (M0 Milestone 0)

**Status:** `DECIDED` — **AGPL (public SE)**  
**Product:** Pattern-Like Astrology App  
**Calc pin:** Swiss Ephemeris **2.10.03** via Node binding **`sweph@2.10.3-7`**  
**Spec:** Product platform v0.2 — *Resolve Swiss Ephemeris licensing before public activation*  
**Date opened:** 2026-07-31  
**Date decided:** 2026-07-31  
**Decision maker:** Product owner (session decision: “AGPL (public SE)”)  
**Owner:** Product + legal (engineering implements the chosen path)

> This document is an engineering decision record, not legal advice. Confirm terms on [astro.com/swisseph](https://www.astro.com/swisseph/) and with counsel before public distribution. AGPL network copyleft has material implications for app stores and proprietary clients.

---

## 1. Decision summary

| Item | Choice |
| --- | --- |
| **Path** | **Option B — AGPL public Swiss Ephemeris** |
| **Astrodienst professional license** | **Not purchased** (not required for this path) |
| **`SE_LICENSE_MODE`** | **`agpl`** |
| **Calc service license** | **AGPL-3.0-or-later** (`apps/calc-stub/LICENSE`) |
| **Binding** | `sweph` under **AGPL-3.0-or-later** (no commercial SE → no LGPL branch) |
| **Public activation** | Allowed **only after** AGPL obligations in §6 are satisfied (source offer, notices, counsel review of store distribution) |

Production may set `SE_LICENSE_MODE=agpl` and `ENVIRONMENT=production`. The process boot gate no longer blocks on `pending`. Remaining blockers are **compliance** (source offer, notices, store strategy), not “undecided license.”

---

## 2. Why AGPL was chosen

- No Astrodienst professional fee.  
- Aligns with free public SE + AGPL `sweph` without dual-license switching.  
- Fits a product that can operate as **source-available / AGPL-compliant** network software.

### Tradeoffs accepted

- **Copyleft:** Modifications and network use of the SE-linked service typically require offering corresponding source under AGPL.  
- **App stores:** Proprietary closed mobile binaries calling a closed backend conflict with AGPL unless architecture and counsel define a compliant boundary. Re-evaluate store distribution under AGPL.  
- **Contributors / employees:** All calc-service contributions must be compatible with AGPL-3.0.

---

## 3. Scope of AGPL in this monorepo (engineering map)

Counsel should confirm the final boundary. Engineering default:

| Component | License posture under this decision |
| --- | --- |
| **`apps/calc-stub`** (Swiss Ephemeris process) | **AGPL-3.0-or-later** — links SE + sweph |
| **SE data files** (`data/ephe/*`) | Distributed under Swiss Ephemeris / AGPL terms; provenance documented |
| **`apps/api`**, **`packages/shared`**, mobile (future) | **Not auto-relicensed** in this commit; if they form one combined AGPL work with calc over the network, counsel must map obligations. Prefer treating **calc as the AGPL network service** with a documented source offer. |
| **Third-party** (luxon, hono, wrangler, …) | Remain under their own licenses (see `NOTICE`) |

This table is implemented at [`LICENSING.md`](../../LICENSING.md), which is the
file a reader of the public repository will find first.

There is deliberately **no root `LICENSE`**: GitHub and most tooling read one as
covering the whole repository, which would over-grant AGPL rights to `apps/api`,
`packages/shared`, and `spec-bundle/`. The visible cost is that the repository
summary shows no license, which is accurate — there is no single one.

If counsel requires the entire monorepo under AGPL, add a root `LICENSE` and
update both this table and `LICENSING.md` in the same PR.

---

## 4. Background (dual license reference)

### Swiss Ephemeris (Astrodienst)

- Public path: AGPL-compatible public license (see astro.com).  
- Professional path: paid proprietary use — **not selected**.

### `sweph` binding

- Without commercial SE: **AGPL-3.0-or-later**.  
- With commercial SE: LGPL-3.0-or-later — **N/A**.

---

## 5. Decision record

| Field | Value |
| --- | --- |
| **Decision** | **`AGPL`** |
| **Decided by** | Product (user directive 2026-07-31) |
| **Date** | 2026-07-31 |
| **Counsel reviewed** | **No** (pending before public store launch) |
| **Astrodienst contract edition** | N/A (public AGPL path) |
| **License / invoice reference** | N/A |
| **SE version authorized** | 2.10.03 |
| **Binding** | sweph@2.10.3-7 |
| **SE_LICENSE_MODE** | **`agpl`** |
| **Public activation authorized** | **Conditional** — license mode OK; complete §6 checklist + counsel before marketing “production live” to end users |
| **Notes** | Source offer process: `docs/legal/AGPL_SOURCE_OFFER.md`. Calc LICENSE: `apps/calc-stub/LICENSE`. |

### Sign-off

| Role | Name | Date |
| --- | --- | --- |
| Product | (session decision) | 2026-07-31 |
| Engineering | Implemented record + mode + notices | 2026-07-31 |
| Legal / counsel | | |

---

## 6. AGPL implementation checklist

### Done in repo

- [x] Record decision as `AGPL`  
- [x] Set `SE_LICENSE_MODE=agpl` (defaults / wrangler / health)  
- [x] `apps/calc-stub/LICENSE` — **full verbatim AGPL-3.0 text** (34,524 bytes, 662 lines, SPDX `AGPL-3.0`). Until 2026-08-01 this was a 27-line notice claiming "you should have received a copy of the GNU Affero General Public License" while no copy was in the repository; AGPL §4 requires conveying an actual copy.  
- [x] `apps/calc-stub/COPYRIGHT` — copyright line, §13 network-use pointer, incorporated works, and scope  
- [x] `LICENSING.md` at root — per-directory terms, and why there is deliberately no root `LICENSE`  
- [x] `NOTICE` (SE + sweph attribution)  
- [x] Source offer process documented (`docs/legal/AGPL_SOURCE_OFFER.md`)  
- [x] `/health` reports `se_license_mode: agpl`  
- [x] **Public git repository exists** — https://github.com/henryperkins/patternlike-app. The §2 clone procedure in the source offer was inoperable before this: there was no history and no remote.  

### Still required before public end-user launch

- [ ] Counsel maps AGPL network obligations to Workers API + any mobile clients  
- [ ] **Decide terms for `packages/shared`**, which `apps/calc-stub` imports. Corresponding Source for the AGPL service reaches into it. AGPL or a permissive AGPL-compatible license (e.g. MIT) both work; "all rights reserved" is the current default and is the weakest position. See `LICENSING.md`.  
- [ ] User-facing legal page links to source offer (website / app settings)  
- [ ] App store distribution strategy reviewed under AGPL  
- [ ] CONTRIBUTING / CLA policy if accepting external patches to calc  
- [ ] Release process includes source tarball or public git tag matching deployed calc image  

### Always

- [x] Pin SE version + ephe download script  
- [x] Pin ephe file SHA-256 — `apps/calc-stub/ephemeris.lock.json` pins the upstream commit and a digest per file; the downloader refuses to write a file that does not match and exits non-zero  
- [x] No LLM-invented chart facts  

---

## 7. Runtime config

| Env | Meaning |
| --- | --- |
| `SE_LICENSE_MODE=agpl` | **Selected path** — production boot allowed |
| `SE_LICENSE_MODE=pending` | Legacy block if someone reverts |
| `SE_LICENSE_MODE=professional` | Only if decision is later reversed and commercial license purchased |
| `ENVIRONMENT=production` | Allowed with `agpl` |

---

## 8. Related paths

| Path | Role |
| --- | --- |
| `apps/calc-stub/LICENSE` | AGPL-3.0 for calc service |
| `NOTICE` | Third-party / SE notices |
| `docs/legal/AGPL_SOURCE_OFFER.md` | How users obtain corresponding source |
| `docs/legal/SWISS_EPHEMERIS_LICENSE_DECISION.md` | This record |
| `apps/calc-stub/src/license-mode.ts` | Runtime mode gate |

