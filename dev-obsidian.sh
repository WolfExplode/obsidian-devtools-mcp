#!/bin/bash
# Launch Obsidian with remote debugging enabled for MCP integration
#
# Usage:
#   ./dev-obsidian.sh           # Launch with default port 9222
#   ./dev-obsidian.sh 9223      # Launch with custom port
#   ./dev-obsidian.sh --kill    # Kill existing Obsidian process

PORT=${1:-9222}

# Handle --kill flag
if [ "$1" = "--kill" ]; then
    echo "Killing Obsidian..."
    pkill -9 -f "Obsidian" 2>/dev/null
    echo "Done."
    exit 0
fi

# Kill any existing Obsidian process
echo "Checking for existing Obsidian processes..."
if pgrep -f "Obsidian" > /dev/null; then
    echo "Killing existing Obsidian process..."
    pkill -9 -f "Obsidian"
    sleep 1
fi

# Determine platform and launch Obsidian
case "$(uname -s)" in
    Darwin)
        OBSIDIAN_PATH="/Applications/Obsidian.app/Contents/MacOS/Obsidian"
        ;;
    Linux)
        OBSIDIAN_PATH="obsidian"
        ;;
    MINGW*|CYGWIN*|MSYS*)
        OBSIDIAN_PATH="$LOCALAPPDATA/Obsidian/Obsidian.exe"
        ;;
    *)
        echo "Unsupported platform: $(uname -s)"
        exit 1
        ;;
esac

echo "Launching Obsidian with remote debugging on port $PORT..."
"$OBSIDIAN_PATH" --remote-debugging-port=$PORT &

# Wait for CDP to be available
echo "Waiting for CDP endpoint..."
for i in {1..30}; do
    if curl -s "http://localhost:$PORT/json" > /dev/null 2>&1; then
        echo "CDP endpoint ready at http://localhost:$PORT"
        echo ""
        echo "Obsidian is ready for development!"
        echo "You can now use the obsidian-devtools-mcp server with Claude Code."
        echo ""
        echo "To register the MCP server:"
        echo "  claude mcp add obsidian-devtools -- node $(dirname "$0")/dist/index.js"
        exit 0
    fi
    sleep 1
done

echo "Warning: CDP endpoint did not become available within 30 seconds."
echo "Obsidian may still be starting up. Try connecting manually."
exit 1
