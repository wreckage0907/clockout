#!/bin/sh
# Installs the packed package the way npm users get it, then runs the installed `clockout`:
# that the tarball has what it needs, the bin is linked, and its dependencies resolve.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/clockout-smoke-XXXXXX")
trap 'rm -rf "$work"' EXIT
fail() {
  echo "smoke: $*" >&2
  exit 1
}

cd "$root"
pnpm -s build >/dev/null 2>&1
pnpm pack --pack-destination "$work" >/dev/null
npm install --global --prefix "$work/prefix" --no-audit --no-fund "$work"/clockout-cli-*.tgz >/dev/null
bin="$work/prefix/bin/clockout"

expected=$(node -p "require('./package.json').version")
[ "$("$bin" --version)" = "$expected" ] || fail "--version isn't $expected"

export HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" XDG_DATA_HOME="$work/home/.local/share"
mkdir -p "$XDG_CONFIG_HOME/clockout"
if out=$("$bin" today --plain 2>&1); then fail "ran without a config"; fi
case "$out" in *"Run \`clockout init\` first."*) ;; *) fail "no-config message: $out" ;; esac

# A day from the fixtures, through the installed copy and its own node_modules.
cat >"$XDG_CONFIG_HOME/clockout/config.toml" <<TOML
[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "Asia/Kolkata"

[ai]
backend = "none"

[[sources]]
type = "claude-code"
projects_dir = "$root/test/fixtures/claude/projects"

[[sources]]
type = "calendar"
method = "ics"
url = "file://$root/test/fixtures/ics/calendar.ics"
TOML
rows=$("$bin" day 2026-10-16 --json --no-ai | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).rows.length))')
[ "$rows" -gt 0 ] || fail "the fixture day has no rows"

echo "smoke: clockout-cli $expected installs and runs ($rows rows on the fixture day)"
