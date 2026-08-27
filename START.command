#!/bin/zsh
cd "$(dirname "$0")"
pkill -f "http.server 8092" 2>/dev/null
python3 -m http.server 8092 --bind 127.0.0.1 >/tmp/isle8092.log 2>&1 &
sleep 1
open "http://localhost:8092"
