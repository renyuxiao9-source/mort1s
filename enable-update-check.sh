#!/usr/bin/env bash
set -eu

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
profile="$HOME/.profile"
for candidate in "$HOME/.bash_profile" "$HOME/.bash_login"; do
  if [ -f "$candidate" ] && [ -r "$candidate" ]; then
    profile=$candidate
    break
  fi
done

marker='# mort1s-update-check'
if [ -f "$profile" ] && grep -Fqx "$marker" "$profile"; then
  printf 'Termux 登录更新检查已启用。\n'
  exit 0
fi

{
  printf '\n%s\n' "$marker"
  printf 'if [ -t 1 ] && command -v node >/dev/null 2>&1 && [ -f %q ]; then\n' "$project_dir/updates.mjs"
  printf '  node %q || true\n' "$project_dir/updates.mjs"
  printf 'fi\n'
  printf '# end mort1s-update-check\n'
} >> "$profile"
printf 'Termux 登录更新检查已启用。下次打开 Bash 登录会话时生效。\n'
