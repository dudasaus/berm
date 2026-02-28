#!/bin/bash

set -e

echo "Compiling berm..."
bun scripts/compile.ts

read -p "Move to ~/.local/bin? [y/N] " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    mkdir -p ~/.local/bin
    mv berm ~/.local/bin/
    echo "Installed to ~/.local/bin/berm"

    if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
        echo ""
        echo "Note: ~/.local/bin is not in your PATH. Add it with:"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
fi
