#!/bin/bash
# Starts the dashboard and opens it full screen in Chromium.
# Run once with --install to put a launcher icon on the desktop.
cd "$(dirname "$(readlink -f "$0")")" || exit 1

if [ "$1" = "--install" ]; then
  launcher="$HOME/Desktop/hackathon-dashboard.desktop"
  cat > "$launcher" <<EOF
[Desktop Entry]
Type=Application
Name=Hackathon Dashboard
Exec=$PWD/start-dashboard.sh
Icon=$PWD/static/home-assistant-icon.svg
Terminal=false
EOF
  chmod +x "$launcher"
  echo "Launcher added: $launcher"
  exit 0
fi

# Only start the server if it isn't already running, e.g. after closing the browser
if ! curl -s -o /dev/null http://localhost:8080; then
  mkdir -p data
  nohup python3 dashboard.py >> data/dashboard.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -s -o /dev/null http://localhost:8080 && break
    sleep 0.5
  done
fi

browser=$(command -v chromium || command -v chromium-browser)
exec "$browser" --start-fullscreen http://localhost:8080
