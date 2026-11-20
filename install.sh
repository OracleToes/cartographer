#!/usr/bin/env bash
set -euo pipefail

# Determine repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Target installation directory
CARTO_HOME="${CARTO_HOME:-$HOME/.carto}"

echo "==> Building Carto..."
npm install
npm run build

echo "==> Installing Carto to $CARTO_HOME..."
mkdir -p "$CARTO_HOME"

# Clean and copy runtime artifacts
rm -rf "$CARTO_HOME/src" "$CARTO_HOME/dist" "$CARTO_HOME/bin"
cp -r src "$CARTO_HOME/src"
cp -r dist "$CARTO_HOME/dist"
cp -r bin "$CARTO_HOME/bin"
cp package.json "$CARTO_HOME/package.json"
cp package-lock.json "$CARTO_HOME/package-lock.json"
cp tsconfig.json "$CARTO_HOME/tsconfig.json"

# Ensure executable bit
chmod +x "$CARTO_HOME/bin/carto.mjs"

# Install production dependencies in ~/.carto
echo "==> Installing production dependencies in $CARTO_HOME..."
(
  cd "$CARTO_HOME"
  npm ci --omit=dev
)

echo ""
echo "Carto successfully installed/updated in $CARTO_HOME"
echo "To use 'carto', ensure $CARTO_HOME/bin is in your PATH:"
echo "  export PATH=\"$CARTO_HOME/bin:\$PATH\""
echo "  hash -r"
