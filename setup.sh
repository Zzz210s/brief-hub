#!/usr/bin/env bash
# brief-hub 一键部署(standalone:不需要任何 AI 工具即可使用)
#
#   1) 建数据目录 ~/.ai-brief-hub
#   2) 装 bh 命令到 ~/bin(bash + cmd)
#   3) 检测本机 AI 工具,存在才接线其适配器(pi / Claude Code / Codex / opencode)
#
# 幂等:可重复运行;任何一步失败都不影响 CLI 本身可用。
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
log(){ printf '\033[1;34m[brief-hub]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[brief-hub:warn]\033[0m %s\n' "$*" >&2; }

log "仓库: $REPO_DIR"
log "Node: $(node -v 2>/dev/null || echo '未找到(需要 Node >= 24)')"

# ---------- 1. 数据目录(核心,不依赖任何 AI) ----------
mkdir -p "$HOME/.ai-brief-hub"/{briefs,subs,state,adapters}
log "数据目录就绪: $HOME/.ai-brief-hub"

# ---------- 2. bh 命令 ----------
if [ -d "$HOME/bin" ]; then
  printf '#!/usr/bin/env bash\nexec node --no-warnings "%s/src/cli.ts" "$@"\n' "$REPO_DIR" > "$HOME/bin/bh"
  chmod +x "$HOME/bin/bh"
  printf '@echo off\r\nnode "%s\\src\\cli.ts" %%*\r\n' "$(printf '%s' "$REPO_DIR" | sed 's|/|\\\\|g')" > "$HOME/bin/bh.cmd"
  log "已安装命令: $HOME/bin/bh(bash)· bh.cmd(cmd/PowerShell)"
else
  warn "未找到 ~/bin,跳过命令安装(可直接 node $REPO_DIR/src/cli.ts)"
fi

# ---------- 3. 可选:AI 适配器(检测到才接线) ----------
wired=0

# 3.1 pi
if [ -d "$AGENT_DIR" ]; then
  mkdir -p "$AGENT_DIR/extensions"
  # 通配复制:以后拆分/新增扩展文件不必再改这里(硬编码清单曾导致"缺模块 -> pi 启动失败")
  for f in "$REPO_DIR"/extensions/*.ts; do
    cp -f "$f" "$AGENT_DIR/extensions/$(basename "$f")" && wired=$((wired+1))
  done
  # 部署后自检:确认相对导入都能解析(缺模块会让 pi 启动失败)
  [ -f "$REPO_DIR/scripts/check-extensions.mjs" ] && node "$REPO_DIR/scripts/check-extensions.mjs" "$AGENT_DIR/extensions" | sed 's/^/  [ext] /' 
  log "pi: 已安装投稿器 + 订阅器扩展(重启 pi 或 /reload 生效)"
else
  log "pi: 未检测到 $AGENT_DIR,跳过(不影响 CLI)"
fi

# 3.2 Claude Code
if [ -d "$HOME/.claude" ]; then
  if node "$REPO_DIR/adapters/claude/install-hooks.mjs" >/dev/null 2>&1; then
    log "Claude Code: hooks 已合并到 ~/.claude/settings.json"
    grep -q '"disableAllHooks": *true' "$HOME/.claude/settings.json" 2>/dev/null && \
      warn "Claude Code: disableAllHooks=true -> hook 不会生效,需改为 false"
  else
    warn "Claude Code: hook 合并失败(可手动跑 node adapters/claude/install-hooks.mjs)"
  fi
else
  log "Claude Code: 未检测到 ~/.claude,跳过"
fi

# 3.3 Codex
if [ -f "$HOME/.codex/config.toml" ]; then
  if grep -q "adapters.codex.notify.mjs\|adapters/codex/notify.mjs\|adapters\\\\codex\\\\notify.mjs" "$HOME/.codex/config.toml"; then
    log "Codex: notify 已配置"
  else
    warn "Codex: 请在 ~/.codex/config.toml 加一行(未自动改你的配置):"
    warn "  notify = [\"node\", \"$(printf '%s' "$REPO_DIR" | sed 's|/|\\\\\\\\|g')\\\\adapters\\\\codex\\\\notify.mjs\"]"
  fi
else
  log "Codex: 未检测到 ~/.codex/config.toml,跳过"
fi

# 3.4 opencode
if [ -d "$HOME/.config/opencode" ]; then
  mkdir -p "$HOME/.config/opencode/plugin"
  cp -f "$REPO_DIR/adapters/opencode/plugin.js" "$HOME/.config/opencode/plugin/brief-hub.js" && \
    log "opencode: 插件已安装到 ~/.config/opencode/plugin/brief-hub.js"
else
  log "opencode: 未检测到 ~/.config/opencode,跳过"
fi

# ---------- 4. 收尾 ----------
log "自检: node \"$REPO_DIR/src/cli.ts\" doctor"
log "开箱可用(不需要任何 AI):"
log "  bh publish --tool manual --sess-id demo --title '第一条简报' --changed a.txt"
log "  bh sub add sev:err --sess=demo && bh digest --sess=demo"
log "接入的 AI 适配器: $wired 个 pi 扩展 $([ -d "$HOME/.config/opencode/plugin" ] && echo '+ opencode 插件')"
