#!/usr/bin/env bash
# 校验仓库内全部 Markdown 的相对链接目标是否存在。
#
# 覆盖范围与已知边界（请勿把本脚本当作完整的链接检查器）：
#   - 只校验行内链接 ](target) 的**路径部分**是否存在于文件系统
#   - 不校验锚点：target 中 # 之后的部分被丢弃
#   - 不校验外部链接（http/https/mailto）与纯锚点链接
#   - 不校验引用式定义 [ref]: ./x.md、HTML <a href>、自动链接 <./x.md>
#   - 跳过围栏代码块，避免把文档中示例代码里的括号当成链接
#   - 文件名含 ) 的链接（如 ./a_(b).md）会被截断误判，仓库内请避免这种命名
#   - 只处理 UTF-8 文本；UTF-16 文件（如 DESIGN.md）无法匹配，会被计入跳过数
#
# 用法：bash scripts/check-links.sh [根目录]
set -uo pipefail

root="${1:-.}"
cd "$root" || exit 1

fail=0
checked=0
skipped_binary=0

while IFS= read -r file; do
  # UTF-16 等非 UTF-8 文本 grep 无法匹配，单独计数以免造成「已检查」的假象
  if ! grep -qI . "$file" 2>/dev/null || file "$file" 2>/dev/null | grep -q 'UTF-16'; then
    skipped_binary=$((skipped_binary + 1))
    continue
  fi

  dir=$(dirname "$file")

  # 先剔除围栏代码块，再提取链接
  targets=$(awk '
      /^[[:space:]]*```/ { infence = !infence; next }
      !infence { print }
    ' "$file" 2>/dev/null \
    | grep -o ']([^)]*)' 2>/dev/null \
    | sed 's/^](//; s/)$//')
  [ -z "$targets" ] && continue

  while IFS= read -r target; do
    [ -z "$target" ] && continue
    case "$target" in
      http://* | https://* | mailto:* | '#'*) continue ;;
    esac

    # 去掉 Markdown 链接标题：](./a.md "Title") -> ./a.md
    target="${target%% \"*}"
    target="${target%% \'*}"
    # 去掉锚点，只校验路径
    path="${target%%#*}"
    [ -z "$path" ] && continue

    # 根绝对路径按仓库根解析，与 GitHub 行为一致
    case "$path" in
      /*) candidate=".${path}" ;;
      *)  candidate="$dir/$path" ;;
    esac

    resolved=$(realpath -m "$candidate" 2>/dev/null) || continue
    checked=$((checked + 1))

    if [ ! -e "$resolved" ]; then
      echo "::error file=${file#./}::链接目标不存在 / broken link: $target"
      fail=1
    fi
  done <<<"$targets"
done < <(find . -name '*.md' \
  -not -path './node_modules/*' \
  -not -path './build/*' \
  -not -path './.git/*')

if [ "$fail" -ne 0 ]; then
  echo "存在失效的内部链接。/ Broken internal links found."
  exit 1
fi

# 一个链接都没检查到，说明 find/grep/realpath 出了问题，不能报成功
if [ "$checked" -eq 0 ]; then
  echo "::error::没有检查到任何链接，工具链可能不可用（需要 GNU realpath）。"
  exit 1
fi

echo "已校验 $checked 个内部链接，全部可解析。/ Checked $checked internal links, all resolve."
if [ "$skipped_binary" -ne 0 ]; then
  echo "另有 $skipped_binary 个非 UTF-8 文件未检查。/ Skipped $skipped_binary non-UTF-8 file(s)."
fi
