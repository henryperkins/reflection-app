# Immanuelle's vector Rider–Waite–Smith deck

Original SVG files from [Vectorized Tarot by Immanuelle on Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Vectorized_Tarot_by_Immanuelle): 22 major arcana, 14 cards in each of four suits, and the Roses and Lilies card back (79 files).

The collection is complete: all 79 original SVGs are present (276,071,643 bytes), and offline verification on October 9, 2026 confirmed their source size/SHA-1, SHA-256, XML parsing, and static image-use checks. `manifest.json` records those results. On another machine, verification reports missing files explicitly; the fetch command can resume an interrupted acquisition.

The source descriptions credit Pamela Colman Smith for the artwork and Immanuelle for vectorization with vectorizer.com followed by Inkscape editing. All 79 source files were marked **Public domain** when their metadata was retrieved. Recorded metadata and exact source links are in `manifest.json` and `commons-metadata.json`. These originals retain their traced shapes, metadata, and original byte contents; they are not hand-grouped animation assets.

Major files use `major-00-fool.svg` through `major-21-world.svg`. Minor files use `cups-01.svg`, `pentacles-01.svg`, `swords-01.svg`, and `wands-01.svg` through rank 14: Ace=01, Page=11, Knight=12, Queen=13, King=14. The reverse is `back.svg`.

Start or resume the detached completion job from the repository worktree root:

```sh
python3 output/reading-motion/assets/rws-immanuelle/run-download.py start
```

Check its progress or stop it while preserving every verified original:

```sh
python3 output/reading-motion/assets/rws-immanuelle/run-download.py status
python3 output/reading-motion/assets/rws-immanuelle/run-download.py stop
```

The job continues after the terminal closes. `start` avoids duplicate jobs using a process lock and also resumes a previously stopped or interrupted job. A machine restart requires running `start` again. Progress, next allowed request time, and the final verified result or error are in `download-job.json`; output is in `download-job.log` and the active PID is in `download.pid`. These machine-specific files are ignored by Git.

Wikimedia imposed repeated 600-second cooldowns during acquisition. The runner honors the persisted cooldown before requesting anything, starts with 60 seconds between files, and increases that interval to 90 and then 120 seconds after renewed cooldowns. A job stops after six hours or eight resumptions, recording an incomplete result if the collection is still partial. A completed job runs the full offline verification before recording success.

For a foreground fetch, first stop any background job, then run:

```sh
python3 output/reading-motion/assets/rws-immanuelle/fetch-deck.py
```

Verify all local originals and regenerate the manifest without network access:

```sh
python3 output/reading-motion/assets/rws-immanuelle/fetch-deck.py --verify-only
```

The Python standard-library script queries the source category on first use (or with `--refresh-metadata`), checks its membership and unique card identities, and downloads serially with 60-second spacing, two attempts per file, and rate-limit backoff. Matching local size/SHA-1 values skip downloading. Long source cooldowns stop every further request and are persisted in `download-status.json` for the next invocation. SHA-256, pixel dimensions, byte counts, source timestamps, licensing, and static XML findings are recorded per card. Successful transfer sizes, timings, and public response headers are recorded in the ignored local `transfer-log.jsonl`; source metadata and checksums travel in the versioned manifests. Interrupted downloads never replace a valid asset. Missing assets retain their source metadata and are explicitly marked unavailable in the manifest.

Validation parses the XML without fetching external DTDs and checks for scripts, event handlers, `foreignObject`, and external `href`/`src` or CSS references. The originals' standard SVG 1.1 public DOCTYPE is reported separately; namespace and RDF attribution identifiers are metadata, not image resource requests. Source bytes are never sanitized or executed. This inspection is not an exhaustive SVG security audit, and none of these originals should be inserted as executable document markup solely on the strength of this check. The study loads them as images.

