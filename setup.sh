#!/usr/bin/env bash
# brief-hub 一键部署:把两个 pi 扩展装到 ~/.pi/agent/extensions/,并在 ~/bin 生成 bh 命令。
# 幂等:可重复运行。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

log(){ printf '\033[1;34m[brief-hub]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[brief-hub:warn]\033[0m %s\n' "$*" >&2; }

log "仓库: $REPO_DIR"

# 1) 数据目录
mkdir -p "$HOME/.ai-brief-hub"/{briefs,subs,state}
log "数据目录就绪: $HOME/.ai-brief-hub"

# 2) pi 扩展
mkdir -p "$AGENT_DIR/extensions"
for f in brief-publisher.ts brief-subscriber.ts; do
  cp -f "$REPO_DIR/extensions/$f" "$AGENT_DIR/extensions/$f"
  log "已安装扩展: $AGENT_DIR/extensions/$f"
done

# 3) bh 命令(写绝对路径,避免依赖 PATH 解析)
if [ -d "$HOME/bin" ]; then
  printf '#!/usr/bin/env bash\nexec node --no-warnings "%s/src/cli.ts" "$@"\n' "$REPO_DIR" > "$HOME/bin/bh"
  chmod +x "$HOME/bin/bh"
  printf '@echo off\r\nnode "%s\\src\\cli.ts" %%*\r\n' "$(echo "$REPO_DIR" | sed 's|/|\\\\|g')" > "$HOME/bin/bh.cmd"
  log "已安装命令: $HOME/bin/bh(bash)· bh.cmd"
else
  warn "未找到 ~/bin,跳过命令安装(可直接 node $REPO_DIR/src/cli.ts)"
fi

# 4) 提示
log "下一步:重启 pi(或 /reload)后,会话会在任务完成时自动投稿"
log "订阅示例: bh sub add git config --sess <会话id> --delivery l1"
