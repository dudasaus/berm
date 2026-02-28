#!/bin/bash

set -e

echo "Compiling command-center..."
bun scripts/compile.ts

read -p "Move to ~/.local/bin? [y/N] " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    mkdir -p ~/.local/bin
    mv command-center ~/.local/bin/
    echo "Installed to ~/.local/bin/command-center"

    if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
        echo ""
        echo "Note: ~/.local/bin is not in your PATH. Add it with:"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
fi
