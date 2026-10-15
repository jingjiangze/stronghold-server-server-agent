#!/bin/sh
# 边缘层容器的入口：三个进程共用一个对外端口（7860）。
#
#   nginx :7860  ──/assets|fonts──►  sidecar :3130  ──302──► 源
#                └──其余─────────►  游戏    :3120
#
# 为什么不让 nginx 直接代理游戏：创空间只给一个对外端口（7860，写死在 deploy_schema.json），
# 所以 nginx 占住它，另外两个退到内部端口。反过来做（游戏占 7860、nginx 另开端口）在平台上
# 没有公网口可用。
#
# 监督语义是**故意不对称**的：
#   * 游戏或 nginx 退出 → 整体退出，让平台重启容器。这两者少一个就没有服务。
#   * sidecar 退出 → 只记日志、继续跑。nginx 的 @sp_asset_fallback 还能把素材供出去，
#     而为一个只影响素材选路的进程去重启整个容器，会把游戏一起停掉——拿小故障换大故障。
set -u

EDGE_DIR=/app/deploy/stardust/ms-edge
EDGE_CONF="$EDGE_DIR/nginx.conf"
PUBLIC_PORT="${SP_PUBLIC_PORT:-7860}"
GAME_PORT="${SP_GAME_PORT:-3120}"
EDGE_PORT="${SP_EDGE_PORT:-3130}"

# 非 root 运行（镜像里是 USER node）：nginx 的 pid 与临时目录都得是可写路径。
mkdir -p /tmp/sp-edge/client_body /tmp/sp-edge/proxy /tmp/sp-edge/fastcgi \
         /tmp/sp-edge/uwsgi /tmp/sp-edge/scgi

if ! nginx -t -c "$EDGE_CONF" >/dev/null 2>&1; then
    echo "sp-edge: nginx config rejected; serving the game directly on ${PUBLIC_PORT}" >&2
    nginx -t -c "$EDGE_CONF" >&2 || true
    exec env PORT="$PUBLIC_PORT" HOST=0.0.0.0 node server/index.js
fi

# 素材解析器：故意不参与退出判定（见文件头的监督语义）。
SP_EDGE_PORT="$EDGE_PORT" node "$EDGE_DIR/edge-sidecar.mjs" &
EDGE_PID=$!

export PORT="$GAME_PORT"
export HOST="${SP_GAME_HOST:-127.0.0.1}"

node server/index.js &
GAME_PID=$!

# 等游戏真正开始监听再放 nginx 进来，否则头几个请求会撞上 502。
# 用 node 自己探（容器里必有 node），不依赖 wget/curl 的实现细节。
node -e '
const port = Number(process.env.SP_GAME_PORT || 3120);
const net = require("net");
const deadline = Date.now() + 60000;
(function probe() {
  const sock = net.connect(port, "127.0.0.1");
  sock.on("connect", () => { sock.destroy(); process.exit(0); });
  sock.on("error", () => {
    sock.destroy();
    if (Date.now() > deadline) { console.error("sp-edge: game did not listen in time"); process.exit(1); }
    setTimeout(probe, 250);
  });
})();
' || { kill "$GAME_PID" "$EDGE_PID" 2>/dev/null || true; exit 1; }

nginx -c "$EDGE_CONF" -g 'daemon off;' &
NGINX_PID=$!

shutdown() {
    kill "$NGINX_PID" "$GAME_PID" "$EDGE_PID" 2>/dev/null || true
    wait "$NGINX_PID" 2>/dev/null || true
    wait "$GAME_PID" 2>/dev/null || true
    wait "$EDGE_PID" 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

EDGE_REPORTED=0
while :; do
    if ! kill -0 "$GAME_PID" 2>/dev/null; then
        echo "sp-edge: game process exited; stopping everything" >&2
        kill "$NGINX_PID" "$EDGE_PID" 2>/dev/null || true
        wait "$NGINX_PID" 2>/dev/null || true
        exit 1
    fi
    if ! kill -0 "$NGINX_PID" 2>/dev/null; then
        echo "sp-edge: nginx exited; stopping everything" >&2
        kill "$GAME_PID" "$EDGE_PID" 2>/dev/null || true
        wait "$GAME_PID" 2>/dev/null || true
        exit 1
    fi
    # 只报一次，避免刷屏；不重启它，也不因此停容器。
    if [ "$EDGE_REPORTED" = "0" ] && ! kill -0 "$EDGE_PID" 2>/dev/null; then
        echo "sp-edge: sidecar exited; /assets|fonts now served by the nginx fallback" >&2
        EDGE_REPORTED=1
    fi
    sleep 2
done
