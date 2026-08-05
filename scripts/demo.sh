#!/usr/bin/env bash
#
# Demo driver for the resilient-article-cache exercise.
#
#   ./scripts/demo.sh help          # what you can do
#   ./scripts/demo.sh serve         # terminal 1: boot the server
#   ./scripts/demo.sh peek down     # terminal 2: drive it
#
# Config comes from .env if present, else the defaults in .env.example. Any var
# can be overridden inline:
#
#   PORT=3005 ./scripts/demo.sh peek
#
# The two-server exercise uses the --no-webhook flag rather than overrides:
#
#   ./scripts/demo.sh serve --no-webhook     # terminal 3
#   ./scripts/demo.sh --no-webhook correct   # terminal 2
#
# Pairs with docs/MANUAL_TESTING.md — each exercise there is one command here.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# .env values become real environment variables (not just shell vars) because
# `next start` reads PORT from the process env at CLI-parse time, before it
# loads any dotenv file. Inline overrides win: set -a export assignments, but
# `${VAR:-default}` below leaves an already-exported VAR alone.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-3000}"
REVALIDATE_SECRET="${REVALIDATE_SECRET:-demo-secret}"
DEMO_ARTICLE="${DEMO_ARTICLE:-investing/2026/07/22/should-you-buy-spacex-stock-before-aug-4}"
DEMO_LOG="${DEMO_LOG:-/tmp/demo.log}"

# --no-webhook is a global flag, valid before or after the command: it points
# every command at the second server (PORT+1, its own log) instead of the main
# one. `serve --no-webhook` starts that server; `--no-webhook logs versions`
# reads it. Keeps the two-server exercise to one flag instead of two overrides.
NO_WEBHOOK=""
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-webhook" ]]; then NO_WEBHOOK=1; else ARGS+=("$arg"); fi
done
set -- ${ARGS[@]+"${ARGS[@]}"}

if [[ -n "$NO_WEBHOOK" ]]; then
  PORT=$((PORT + 1))
  DEMO_LOG="${DEMO_LOG%.log}-nowebhook.log"
fi

BASE="http://localhost:${PORT}"

STATS_URL="$BASE/api/_internal/cache-stats"
BODY="$(mktemp -t demo-body)"
trap 'rm -f "$BODY"' EXIT

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

die() { echo "error: $*" >&2; exit 1; }

# Pretty-print JSON from stdin. python3 ships with macOS and every CI image we
# use, so no jq dependency (jq is optional, and only used by `tail`).
pretty() { python3 -m json.tool; }

# Pull one value out of a JSON object on stdin, by dotted path.
json_get() {
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value[key]
print(value)
' "$1"
}

require_server() {
  curl -fsS -o /dev/null --max-time 5 "$STATS_URL" 2>/dev/null && return 0
  die "no server on $BASE. Start one with \`./scripts/demo.sh serve\` (or PORT=$PORT ... for another port)."
}

require_log() {
  [[ -f "$DEMO_LOG" ]] || die "no log at $DEMO_LOG. \`./scripts/demo.sh serve\` tees the server's output there."
}

# One request to an article, summarized in a single line: status, wall-clock,
# cache status + age from the rendered <article>, and the version the reader saw.
#
# The cache status rides on the HTML rather than a header because a server
# component can't set response headers. The `v<!-- -->2` weirdness is React
# splitting the "v" prefix and the number into two text nodes.
peek_once() {
  local mode="${1:-}" url="$BASE/articles/$DEMO_ARTICLE"
  [[ -n "$mode" && "$mode" != "healthy" ]] && url="$url?source=$mode"
  [[ -n "${DEMO_VERBOSE:-}" ]] && echo "+ curl -s '$url'" >&2

  curl -s -o "$BODY" -w 'http=%{http_code} time=%{time_total}s ' --max-time 30 "$url" || true
  local status age version
  status="$(grep -o 'data-cache-status="[A-Z]*"' "$BODY" | head -1 | sed 's/.*"\(.*\)"/\1/')"
  age="$(grep -o 'data-cache-age="[0-9]*"' "$BODY" | head -1 | sed 's/.*"\(.*\)"/\1/')"
  version="$(grep -o 'v<!-- -->[0-9]*' "$BODY" | head -1 | sed 's/<!-- -->//')"
  printf '%-11s age=%-6s %s\n' "${status:-?}" "${age:-?}ms" "${version:-?}"
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

cmd_help() {
  cat <<EOF
scripts/demo.sh — drive the article cache by hand

  target                $BASE   log=$DEMO_LOG
  article               $DEMO_ARTICLE

  serve                 build if needed, start the server, tee logs to \$DEMO_LOG

  peek [mode]           one article request: status, time, cache status, age, version
  modes                 peek all five failure modes: healthy slow down hang corrupt
  stale [mode] [n]      n reads 0.5s apart (default: down, 8) — catches STALE serves
  articles              list the four seeded article paths

  stats                 /api/_internal/cache-stats, pretty-printed
  breaker               circuit breaker state only
  metrics               cache hit/stale/miss breakdown + upstream latency percentiles
  trip                  six failing reads, then the breaker state

  headers               CDN response headers on a warm article
  cold                  never-cached path against a failing CMS (the 503 case)
  missing               two requests to a real 404 (shows the negative cache)

  revalidate            the push-invalidation auth gate: no secret, then the secret
  correct               publish a correction, then read it back

  logs [what]           grep \$DEMO_LOG. what = reads | upstream | warn | breaker |
                        versions | prewarm | background, or any pattern
  tail                  live-tail user-facing cache reads (needs jq)

  --no-webhook          global flag: target a second server on PORT+1 with push
                        invalidation off, with its own log. Start it with
                        \`serve --no-webhook\`, then read it with
                        \`--no-webhook logs versions\`.

Config: .env if present, else .env.example's defaults. Override inline —
  PORT=3005 ./scripts/demo.sh peek
Set DEMO_VERBOSE=1 to echo the underlying curl for peek.

Full runbook with expected output: docs/MANUAL_TESTING.md
EOF
}

cmd_serve() {
  [[ $# -eq 0 ]] || die "serve: unknown option $1"

  # Dev-mode timing (on-demand compilation, no minification) is not
  # representative of the latency behavior being demoed — always serve a build.
  if [[ ! -d .next ]]; then
    echo "==> no .next, building first"
    npm run build
  fi

  if [[ -n "$NO_WEBHOOK" ]]; then
    # PORT and DEMO_LOG were already shifted by the global flag, so this server
    # runs alongside the main one: a separate process means a separate in-memory
    # CMS, cache and breaker.
    unset CMS_WEBHOOK_URL
    echo "==> push invalidation OFF (no CMS_WEBHOOK_URL) — corrections arrive via the refresher"
  else
    # Derive rather than hardcode, so a PORT override can't leave the webhook
    # pointing at a different server.
    export CMS_WEBHOOK_URL="${CMS_WEBHOOK_URL:-$BASE/api/internal/revalidate}"
    echo "==> push invalidation ON -> $CMS_WEBHOOK_URL"
  fi

  export PORT REVALIDATE_SECRET
  echo "==> $BASE   logs -> $DEMO_LOG"
  echo

  # tee, because the structured logs *are* the observability story and you'll
  # want to grep them mid-demo. 2>&1 is load-bearing: logger.warn/error use
  # console.warn/error, which go to stderr, so a bare pipe silently drops every
  # circuit_transition and every warn-level line.
  npm run start 2>&1 | tee "$DEMO_LOG"
}

cmd_peek() {
  require_server
  peek_once "${1:-}"
}

cmd_modes() {
  require_server
  local mode
  for mode in healthy slow down hang corrupt; do
    printf '%-8s ' "$mode"
    peek_once "$mode"
  done
}

cmd_stale() {
  require_server
  local mode="${1:-down}" count="${2:-8}" i
  echo "==> $count reads with ?source=$mode, 0.5s apart"
  for ((i = 0; i < count; i++)); do
    peek_once "$mode"
    sleep 0.5
  done
}

cmd_articles() {
  require_server
  curl -s "$BASE/api/cms/content" | python3 -c '
import json, sys
for article in json.load(sys.stdin)["articles"]:
    print(" ", article["path"])
'
}

cmd_stats() {
  require_server
  curl -s "$STATS_URL" | pretty
}

cmd_breaker() {
  require_server
  curl -s "$STATS_URL" | json_get circuitBreaker.state
}

cmd_metrics() {
  require_server
  echo "==> cache reads by status and caller"
  curl -s "$STATS_URL" | python3 -c '
import json, sys
for counter in json.load(sys.stdin)["metrics"]["counters"]:
    if counter["name"] == "cache_reads":
        print(" ", counter["tags"], counter["value"])
'
  echo
  echo "==> upstream latency by outcome"
  curl -s "$STATS_URL" | python3 -c '
import json, sys
for h in json.load(sys.stdin)["metrics"]["histograms"]:
    if h["name"] == "upstream_latency_ms":
        print(" ", h["tags"], "p50", h["p50"], "p95", h["p95"], "max", h["max"])
'
}

cmd_trip() {
  require_server

  # The breaker opens on three CONSECUTIVE failures, and any success resets the
  # count. The refresher succeeds against the real CMS every
  # REFRESH_INTERVAL_MS, so failures spread over seconds get their counter
  # wiped mid-run. Two things make this land reliably:
  #   - distinct paths, because single-flight collapses concurrent reads of the
  #     SAME path into one upstream call, i.e. one failure instead of three
  #   - concurrent, so every failure lands inside one refresher gap
  local paths
  paths="$(curl -s "$BASE/api/cms/content" | python3 -c '
import json, sys
for article in json.load(sys.stdin)["articles"]:
    print(article["path"])
')"
  [[ -n "$paths" ]] || die "could not list articles from $BASE/api/cms/content"

  echo "==> concurrent failing reads, one per seeded article"
  local attempt path state=""
  for attempt in 1 2 3 4 5 6; do
    for path in $paths; do
      curl -s -o /dev/null --max-time 30 "$BASE/articles/$path?source=down" &
    done
    wait
    state="$(curl -s "$STATS_URL" | json_get circuitBreaker.state)"
    [[ "$state" == "open" ]] && break
    # A round can score zero failures: if the refresher revalidated everything
    # a moment ago, every entry is still inside the 1s fresh window, so those
    # reads were HITs that never called upstream. Wait out FRESH_TTL_MS and go
    # again rather than reporting a state the reads never had a chance to set.
    sleep 1.1
  done

  echo "breaker: $state  (round $attempt)"
  if [[ "$state" == "open" ]]; then
    echo "(open for BREAKER_COOLDOWN_MS = 5s — nothing can close it early, not even"
    echo " the refresher, so a poll inside that window always catches it.)"
  else
    echo "(never reached three consecutive failures: the refresher talks to the real"
    echo " CMS every REFRESH_INTERVAL_MS and every success resets the count. Restart"
    echo " with REFRESH_INTERVAL_MS=60000 to widen the gap.)"
  fi
  echo "\`./scripts/demo.sh logs breaker\` shows every transition."
}

cmd_headers() {
  require_server
  curl -sI "$BASE/articles/$DEMO_ARTICLE" | grep -iE '^HTTP|^cache-control|^surrogate'
}

cmd_cold() {
  require_server
  # A path that has never been cached, against a failing CMS: nothing to fall
  # back on, so this is the one case with no good answer.
  local path="never-cached/demo-$$-$RANDOM"
  echo "==> GET /articles/$path?source=down"
  curl -sI "$BASE/articles/$path?source=down" | grep -iE '^HTTP|^cache-control'
}

cmd_missing() {
  require_server
  local path="nope/not-a-real-article"
  echo -n "==> first request:  "
  curl -s -o /dev/null -w '%{http_code}\n' "$BASE/articles/$path"
  echo -n "==> second request: "
  curl -s -o /dev/null -w '%{http_code}\n' "$BASE/articles/$path"
  echo
  require_log
  echo "==> log lines for $path (expect one upstream call, not two)"
  grep "$path" "$DEMO_LOG" || echo "(none — the negative cache answered before any logging)"
}

cmd_revalidate() {
  require_server
  local url="$BASE/api/internal/revalidate?path=$DEMO_ARTICLE"
  curl -s -o /dev/null -w 'no secret     -> %{http_code}\n' -X POST "$url"
  curl -s -o /dev/null -w 'wrong secret  -> %{http_code}\n' -X POST \
    -H "x-revalidate-secret: not-the-secret" "$url"
  echo -n 'right secret  -> '
  curl -s -X POST -H "x-revalidate-secret: $REVALIDATE_SECRET" "$url"
  echo
}

cmd_correct() {
  require_server
  echo -n "==> publish: "
  curl -s -X POST "$BASE/api/cms/admin?publish-correction=$DEMO_ARTICLE"
  echo
  echo -n "==> read:    "
  peek_once
  echo
  echo "==> propagation"
  if [[ -f "$DEMO_LOG" ]]; then
    grep version_changed "$DEMO_LOG" | tail -2 || echo "(no version_changed yet — give the refresher ~2s)"
  else
    echo "(no log at $DEMO_LOG — start the server with \`./scripts/demo.sh serve\`)"
  fi
}

cmd_logs() {
  require_log
  local what="${1:-}"
  case "$what" in
    reads)      grep '"message":"cache_read"'    "$DEMO_LOG" | tail -5 ;;
    upstream)   grep '"message":"upstream_call"' "$DEMO_LOG" | tail -5 ;;
    warn)       grep '"level":"warn"'            "$DEMO_LOG" ;;
    breaker)    grep circuit_transition          "$DEMO_LOG" ;;
    versions)   grep version_changed             "$DEMO_LOG" ;;
    prewarm)    grep prewarm_run "$DEMO_LOG" ;;
    # Prewarm happens once at boot, so show it in full; refresh cycles are every
    # 2s forever, so show only the latest few.
    background) grep prewarm_run "$DEMO_LOG"; grep refresh_cycle "$DEMO_LOG" | tail -3 ;;
    "")         tail -20 "$DEMO_LOG" ;;
    *)          grep -- "$what" "$DEMO_LOG" ;;
  esac
}

cmd_tail() {
  require_log
  command -v jq > /dev/null || die "tail needs jq (brew install jq). \`./scripts/demo.sh logs reads\` works without it."
  # Filter to caller=="read": the refresher logs every 2s, so an unfiltered
  # tail is too noisy to demo against.
  echo "==> live cache reads (ctrl-c to stop)" >&2
  tail -f "$DEMO_LOG" | jq -c 'select(.message=="cache_read" and .caller=="read")
    | {status, ageMs, upstreamOutcome, circuitState, version}'
}

# ---------------------------------------------------------------------------

command="${1:-help}"
[[ $# -gt 0 ]] && shift
case "$command" in
  help|-h|--help) cmd_help ;;
  serve)      cmd_serve "$@" ;;
  peek)       cmd_peek "$@" ;;
  modes)      cmd_modes ;;
  stale)      cmd_stale "$@" ;;
  articles)   cmd_articles ;;
  stats)      cmd_stats ;;
  breaker)    cmd_breaker ;;
  metrics)    cmd_metrics ;;
  trip)       cmd_trip ;;
  headers)    cmd_headers ;;
  cold)       cmd_cold ;;
  missing)    cmd_missing ;;
  revalidate) cmd_revalidate ;;
  correct)    cmd_correct ;;
  logs)       cmd_logs "$@" ;;
  tail)       cmd_tail ;;
  *)          echo "unknown command: $command" >&2; echo >&2; cmd_help >&2; exit 1 ;;
esac
