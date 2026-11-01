# Illustration placement and delivery

## Current screen map

| Surface                      | Retain / replace                                                                                      | Placement and boundary                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading form, desktop        | Retain `spread-ribbon`                                                                                | Heading decoration; separate from photo controls and actual uploads.                                                                                                                                                                              |
| Reading form, ≤760 px        | **Replace miniature ribbon with `mobile-corner`**                                                     | Dedicated 64 × 72 px grid cell beside the heading, with a 12 px gap. No absolute overlap or clipping crop.                                                                                                                                        |
| Optional-photo empty state   | Retain `three-card-spread`                                                                            | Exactly three abstract cards; 220 px mobile / 320 px desktop. Never a recognized result.                                                                                                                                                          |
| Account                      | Retain `account-sprig` on desktop; use `mobile-corner` at ≤760 px                                     | Mobile title reserves a separate column; disclosures use the full width below it.                                                                                                                                                                 |
| Accepted photo reading       | Replace header ribbon with **no decorative image**                                                    | The actual uploaded spread sits directly before situation → tension → possibility. All three cards and portrait boundaries remain contained.                                                                                                      |
| Drawn-card reading           | Retain `study-inquiry` on desktop; hide the redundant mobile header plate                             | The actual draw labels, orientations and complete interpretation remain authoritative. Suit-specific study plates stay inside the illustrative card faces.                                                                                        |
| Position sections            | Remove repeated corner illustrations from the rendered rows                                           | `position-situation.png`, `position-tension.png`, `position-possibility.png` remain as originals, but are no longer imported/shipped. Numbered hairline rows replace repeated boxes in both reading modes.                                        |
| Reflection editor            | Retain user's original attached photo only                                                            | Contained reference thumbnail, not a second recognition or generation request.                                                                                                                                                                    |
| Landing                      | Retain `study-return`; reuse optimized `account-sprig` for the wide footer                            | Shared editorial panel with orbit at desktop scale. At ≤900 px, account controls precede a short orbit crop; the footer sprig is hidden. `leaves.png` is retained as an original but no longer imported/shipped.                                  |
| Saved readings               | Compact `study-stillness` title and retained `study-possibility` empty state; no per-record thumbnail | Title has a reserved 112 × 88 px desktop / 72 × 72 px phone slot. Records remain distinguished by date and question, preserving PR #7. A decorative image beside a question could look like a preview of that reading, so list rows carry no art. |
| Recovery / replacement / kit | Retain `study-inquiry` and kit `study-perspective`                                                    | Existing recovery art, outside codes, warnings and passkey controls. Supporting-screen styling follows landing/history.                                                                                                                           |
| Progress / outcomes          | No decorative image                                                                                   | The status text and its live region lead the card; `progress-strip.png` remains a source original but is no longer imported/shipped.                                                                                                              |
| Deletion receipt             | No decorative image                                                                                   | The deletion status leads the card; completion is communicated by the status text, never by art.                                                                                                                                                  |
| Older form banner            | Park `hero-rose.webp`                                                                                 | Retained original, no longer imported/shipped.                                                                                                                                                                                                    |

## Originals and provenance

The [November 1 supporting-screen boards](../../../../docs/design/concept-direction.md) extend the existing artwork hierarchy without generating or modifying originals. The entry footer reuses the existing optimized transparent account sprig; the orbit and compact title crop reuse the original study JPEGs. The supplied refined boards are stored unchanged under `docs/design/concepts/2026-11-01/` and are not imported by the client.

The ribbon (2172 × 724), account sprig (1945 × 809) and three-card spread (1983 × 793) were made with built-in ImageGen on 2026-10-31 from the owner's supplied concepts. The dedicated mobile corner (1222 × 1287) was generated the same day from the ribbon/sprig style references as a new compact three-leaf composition, not a tiny ribbon or a crop. They retain the cream, sage, teal and coral botanical print language. All four originals are untouched RGBA PNGs with transparent pixels and are retained here for future exports; runtime code imports only the delivery variants.

All decorative `Art` images have `alt=""`, `aria-hidden="true"`, intrinsic dimensions and reserved layout space. Actual photographs always have descriptive alternative text. The illustrative synthetic spread fixture is `tests/fixtures/spread-photo.jpg`, outside the client bundle. It is not card-recognition evidence.

## Lossless delivery variants

`optimized/manifest.json` records original SHA-256, dimensions and bytes, plus every generated variant. `Art` uses width-descriptor `srcset`, placement-specific `sizes` and a media-qualified desktop `<picture>` source with the compact mobile image as fallback. This also avoids WebKit speculatively fetching desktop ribbon/sprig candidates while React mounts the picture tree. No full-resolution PNG is imported into the production bundle.

| Image             | Original bytes | Widths → lossless WebP bytes              |
| ----------------- | -------------: | ----------------------------------------- |
| Ribbon            |      1,196,767 | 320 → 27,476; 640 → 85,660; 960 → 178,842 |
| Account sprig     |      1,274,288 | 160 → 10,960; 320 → 33,300; 560 → 86,404  |
| Three-card spread |      1,875,484 | 320 → 49,364; 640 → 160,384               |
| Mobile corner     |      1,257,168 | 80 → 7,134; 160 → 21,638; 240 → 42,886    |

For these decorations alone, the mobile empty form at DPR 1 selects about **56.5 kB instead of 3.07 MB** (98.2% less); at DPR 2, about **182 kB** (94.1% less). Account's mobile decoration selects 7.1 kB at DPR 1 instead of 1.27 MB. These are selected-asset byte comparisons, not total page-weight claims. `sizes` choices are also recorded by the browser matrix.

Rebuild using Python 3 with Pillow installed:

```sh
python3 scripts/optimize-illustrations.py
```

This is a development-only tool, not an application dependency. It resizes from the originals with Lanczos, encodes lossless RGBA WebP, then verifies a byte-for-byte RGBA round trip against each resized source, including partially transparent edges. There is no JPEG matte, alpha removal or lossy color encoding. The 1×/2× exports cover the actual CSS slots; the corner also has a 3× option. Inspect both themes at actual display sizes after regenerating.

Palette decision: retain the shared Solstice colors, not sampled mint/deeper-teal replacements. Accessible destructive-text/button variants now live alongside the light/dark colors in `design/tokens.css`, rather than introducing component-local palettes. The shared `--input` stroke is strengthened in both themes to meet 3:1 non-text contrast; primary buttons and foreground/background palette values are unchanged.
