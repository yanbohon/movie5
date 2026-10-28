#!/bin/zsh
# 内存看门狗：系统空闲内存低于阈值时，先杀 puppeteer 开的无头 Chrome（不碰用户自己的浏览器），防止整机卡死。
# 用法: tools/memguard.sh [阈值百分比=12] [日志=out/memguard.log]
TH=${1:-12}
LOG=${2:-out/memguard.log}
mkdir -p "$(dirname "$LOG")"
while true; do
  F=$(/usr/bin/memory_pressure 2>/dev/null | sed -n 's/.*free percentage: \([0-9]*\)%.*/\1/p')
  F=${F:-100}
  if [ "$F" -lt "$TH" ]; then
    P=$(pgrep -f "puppeteer_dev_chrome_profile" | tr '\n' ' ')
    echo "$(date '+%H:%M:%S') free=${F}% < ${TH}% -> kill headless chrome: ${P}" >> "$LOG"
    [ -n "$P" ] && pkill -9 -f "puppeteer_dev_chrome_profile"
    sleep 20
  else
    sleep 8
  fi
done
