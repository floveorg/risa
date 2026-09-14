#!/usr/bin/env bash
# Build the Risa 2.x download — the replicable actual environment.
#
# Bundles the web + bot + worker + workflows + docs (NOT the media: audios and
# images live on Cloudflare R2; the seed images and categorias are content).
#
# Versioning: the canonical download is `risa2.zip` and ALWAYS carries the
# latest Risa 2.x.x; released cuts may be kept as `risa2.<x.y>.zip`
# (risa2.0.1, risa2.1.3, …). The package title/VERSION/changelog in the README
# carry the actual number (e.g. "Risa 2.1.3").
#
# When the flove checkout is present (../../../central/shared/code), the
# central libs are bundled inside the zip and the index paths rewritten to
# `central/shared/code/…`, so the download works standalone. Without the
# checkout the index keeps its relative repo paths (risa2.zip is then a
# dev-only pack).
#
# Usage:   ./build-risa-zip.sh [version]
# Version defaults to config.json's "version" (e.g. v2.1.0).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -e "process.stdout.write(require('./config.json').version)")}"
VERSION="${VERSION#v}"                     # strip leading v for the filename
NAME="risa2"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STAGE="$TMP/$NAME"
mkdir -p "$STAGE/bot" "$STAGE/worker" "$STAGE/.github/workflows"

# ── Web ──────────────────────────────────────────────────────────────────
cp index.html risa.js config.json risa.json usernames.json CNAME "$STAGE/" 2>/dev/null || true
cp build-rss.mjs risa.xml atom.xml "$STAGE/" 2>/dev/null || true
# Imágenes LOCALES que index.html referencia por ruta relativa (diagramas,
# QR y fotos de réplica) — imprescindibles para ver la web offline.
cp -n *.png *.jpg "$STAGE/" 2>/dev/null || true
mkdir -p "$STAGE/media"
cp -n media/replica-*.jpg "$STAGE/media/" 2>/dev/null || true
# (media/logos · seed/ · categorias/ no entran: son contenido y viven en R2)

# ── Central libs (si el checkout de flove está presente) ─────────────────
CENTRAL="../../../central/shared/code"
if [ -d "$CENTRAL" ]; then
  mkdir -p "$STAGE/central/shared/code/css" "$STAGE/central/shared/code/js"
  cp "$CENTRAL"/css/flove.css "$CENTRAL"/css/flove-bottom-nav.css "$STAGE/central/shared/code/css/" 2>/dev/null || true
  cp "$CENTRAL"/js/flove-feed.js "$CENTRAL"/js/flove-tags.js "$CENTRAL"/js/flove-player.js \
     "$CENTRAL"/js/flove-bottom-nav.js "$CENTRAL"/js/flove-sound.js "$CENTRAL"/js/flove-app.js \
     "$STAGE/central/shared/code/js/" 2>/dev/null || true
  # El index empaquetado referencia las libs en relativo dentro del zip.
  sed -i 's#../../../central/shared/code#central/shared/code#g' "$STAGE/index.html"
  echo "central libs bundled (${VERSION})"
fi

# ── Bot ──────────────────────────────────────────────────────────────────
cp bot/*.mjs "$STAGE/bot/" 2>/dev/null || true
cp -r bot/test "$STAGE/bot/test" 2>/dev/null || true
# ── Worker ───────────────────────────────────────────────────────────────
cp worker/* "$STAGE/worker/" 2>/dev/null || true
# ── Workflows ────────────────────────────────────────────────────────────
cp .github/workflows/*.yml "$STAGE/.github/workflows/" 2>/dev/null || true
# ── Docs ─────────────────────────────────────────────────────────────────
cp README.md .htmlvalidate.json "$STAGE/" 2>/dev/null || true
echo "v${VERSION}" > "$STAGE/VERSION"

# Feed placeholder for the download (the real feed has current content).
if [ ! -s "$STAGE/risa.json" ]; then echo '[]' > "$STAGE/risa.json"; fi

(cd "$TMP" && zip -qr "$ROOT/$NAME.zip" "$NAME")
echo "✓ $ROOT/$NAME.zip  (Risa ${VERSION})"
