#!/usr/bin/env bash
# 校验仓库内全部 Markdown 的相对链接目标是否存在。
# 外部链接（http/https/mailto）与纯锚点链接不检查。
#
# 用法：bash scripts/check-links.sh [根目录]
set -uo pipefail

root="${1:-.}"
cd "$root" || exit 1

fail=0
checked=0

while IFS= read -r file; do
  dir=$(dirname "$file")
  targets=$(grep -o ']([^)]*)' "$file" 2>/dev/null | sed 's/^](//; s/)$//')
  [ -z "$targets" ] && continue

  while IFS= read -r target; do
    [ -z "$target" ] && continue
    case "$target" in
      http://* | https://* | mailto:* | '#'*) continue ;;
    esac

    # 去掉锚点部分，只校验路径
    path="${target%%#*}"
    [ -z "$path" ] && continue

    resolved=$(realpath -m "$dir/$path" 2>/dev/null) || continue
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

echo "已校验 $checked 个内部链接，全部可解析。/ Checked $checked internal links, all resolve."
