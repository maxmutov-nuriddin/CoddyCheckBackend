#!/bin/bash
# Kill process using port 5000 (Git Bash / MINGW64 on Windows)

echo "Checking what is using port 5000..."

# Get PID using port 5000
PID=$(netstat -ano | grep ":5000 " | grep "LISTENING" | awk '{print $NF}' | head -1)

if [ -n "$PID" ]; then
  echo "Killing process PID: $PID"
  cmd.exe /c "taskkill /PID $PID /F"
  echo "Done. You can now run: npm start"
else
  echo "No process found listening on port 5000."
fi
