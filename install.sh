#!/usr/bin/env bash
# Install Cartographer from this folder: fetch its packages, put `carto` on your PATH,
# and write the settings file. Safe to run again, for example after updating the folder.
#
#   bash install.sh --server http://127.0.0.1:8888/v1 --model ByteShape
#
# Start it with `bash`: a downloaded copy of this folder has lost its executable marks,
# and this script puts them back.
#
# Nothing is copied: ~/.local/bin/carto is a link to bin/carto here, so this folder is
# the one copy of the program and every project uses it.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
CORE=$PWD
BIN_DIR=${CARTO_BIN_DIR:-$HOME/.local/bin}
SERVER=""
MODEL=""
while [ $# -gt 0 ]; do
	case "$1" in
		--server) SERVER=${2:?--server needs an address}; shift 2 ;;
		--model) MODEL=${2:?--model needs a name}; shift 2 ;;
		*) echo "Unknown option $1. Usage: bash install.sh [--server URL --model NAME]" >&2; exit 1 ;;
	esac
done

command -v node >/dev/null || { echo "Node is not installed. Cartographer needs Node 22.19 or newer." >&2; exit 1; }
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' \
	|| { echo "Cartographer needs Node 22.19 or newer; this is Node $(node -v)." >&2; exit 1; }
command -v git >/dev/null || echo "Note: git is not installed. Looking works without it; changing a project needs it, for the checkpoints."
command -v bwrap >/dev/null || echo "Note: bubblewrap (bwrap) is not installed. Everything works without it except running commands, which tasks do only inside its sandbox."

echo "Fetching packages into $CORE/node_modules ..."
npm install --omit=dev --no-audit --no-fund --loglevel=error

chmod +x "$CORE/bin/carto" "$CORE/install.sh"
mkdir -p "$BIN_DIR"
ln -sfn "$CORE/bin/carto" "$BIN_DIR/carto"
echo "Linked $BIN_DIR/carto -> $CORE/bin/carto"

if [ -n "$SERVER" ] || [ -n "$MODEL" ]; then
	[ -n "$SERVER" ] && [ -n "$MODEL" ] || { echo "Give --server and --model together." >&2; exit 1; }
	SERVER=$SERVER MODEL=$MODEL node -e '
		const fs = require("fs");
		const old = fs.existsSync("config.json") ? JSON.parse(fs.readFileSync("config.json", "utf8")) : {};
		fs.writeFileSync("config.json", JSON.stringify({ ...old, server: process.env.SERVER, model: process.env.MODEL }, null, "\t") + "\n");'
	echo "Wrote $CORE/config.json"
elif [ ! -f config.json ]; then
	echo
	echo "No settings yet. Run this again with your server and model, for example:"
	echo "  bash install.sh --server http://127.0.0.1:8888/v1 --model ByteShape"
fi

case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*)
		echo
		echo "$BIN_DIR is not on your PATH. Add this line to ~/.bashrc (or your shell's file), then open a new terminal:"
		echo "  export PATH=\"$BIN_DIR:\$PATH\""
		;;
esac
echo
echo "Done. In a project folder, run: carto"
