# Reading gesture artwork delivery

These 78 WebP faces are delivery copies of the Immanuelle vector edition. Pamela Colman Smith's artwork and its vector shapes are unchanged; only encoding and raster resolution differ. Source vectors, source descriptions and license metadata remain in the [source manifest](../../../../output/reading-motion/assets/rws-immanuelle/manifest.json). The [delivery manifest](manifest.json) repeats per-card attribution, source links, license metadata, hashes, dimensions and byte counts.

Regenerate from the repository root with `node scripts/assets/build-gesture-artwork.mjs` using the locked dependencies. The script verifies original hashes and renders at 1086 pixels wide, WebP quality 88. It does not rewrite the original vectors or the independent SVG illumination/water masks.

The reading loads only its spread's images. A single URL is reused for the shelf, focus window and illumination layer so the browser can share the cached image. These delivery copies do not enable the production reading-gestures flag; edition rollout remains a separate decision.

