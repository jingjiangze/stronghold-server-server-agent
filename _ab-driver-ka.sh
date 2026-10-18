#!/bin/bash
# A/B 驱动（新）：同一台服务器进程，用 git stash 切换「旧判据 / 新判据」，
# 各跑 3 组，每组 1 真人 + 3 AI 跑到第 8 轮即停，收集服务器 CPU。
# 服务器始终跑在 3100；客户端是进程外的「浏览器」。
cd "C:/DDDD/Agent Work/_tmp/newrepo-server-agent" || exit 1
REPRO="C:/DDDD/Agent Work/_tmp/task-sp-ai-distribution-audit-2026-10-15/repro"
OUT="$TEMP/ab-killaware.jsonl"
: > "$OUT"

kill_srv() {
  local P
  P=$(netstat -ano | grep LISTENING | grep -E ":3100\s" | awk '{print $NF}' | head -1)
  [ -n "$P" ] && taskkill //F //PID "$P" >/dev/null 2>&1
  sleep 2
}

for rep in 1 2 3; do
  for cfg in OLD NEW; do
    kill_srv
    if [ "$cfg" = OLD ]; then
      git stash push server/sim/rehearsal.js -m "ab-old" >/dev/null 2>&1
    else
      git stash list | grep -q "ab-old" && git stash pop >/dev/null 2>&1
    fi
    AB_PORT=3100 AB_SEED=20261015 nohup node _ab-server.mjs > "$TEMP/ab-ka-$cfg-$rep.log" 2>&1 &
    sleep 9
    AB_PORT=3100 AB_LABEL="$cfg-rep$rep" AB_ROUNDS=8 AB_MAX_MS=300000 node _ab-client.mjs 2>&1 |
      tr -d '\n' | sed 's/  */ /g' >> "$OUT"
    echo >> "$OUT"
    echo "  [driver-ka] $cfg-rep$rep done" >> "$TEMP/ab-driver.log"
  done
done
kill_srv
git stash list | grep -q "ab-old" && git stash pop >/dev/null 2>&1
echo "DONE" >> "$OUT"
