#!/bin/bash
# Starts the dashboard and opens it full screen in Chromium.
# Run once with --install to put start and stop icons on the desktop. --stop stops it.
cd "$(dirname "$(readlink -f "$0")")" || exit 1

if [ "$1" = "--install" ]; then
  cat > "$HOME/Desktop/hackathon-dashboard.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Hackathon Dashboard
Exec=$PWD/start-dashboard.sh
Icon=$PWD/static/home-assistant-icon.svg
Terminal=false
EOF
  cat > "$HOME/Desktop/hackathon-dashboard-stop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Stop Hackathon Dashboard
Exec=$PWD/start-dashboard.sh --stop
Icon=process-stop
Terminal=false
EOF
  chmod +x "$HOME/Desktop/hackathon-dashboard.desktop" "$HOME/Desktop/hackathon-dashboard-stop.desktop"
  echo "Start and stop icons added to $HOME/Desktop"
  exit 0
fi

if [ "$1" = "--stop" ]; then
  if pkill -f "python3 dashboard.py"; then
    message="Hackathon dashboard stopped"
  else
    message="Hackathon dashboard wasn't running"
  fi
  pkill -f -- "--start-fullscreen http://localhost:8080"
  # Show a pop-up, as the stop icon has no window of its own
  if command -v notify-send > /dev/null; then
    notify-send "$message"
  elif command -v zenity > /dev/null; then
    zenity --info --text="$message" --timeout=4
  fi
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
