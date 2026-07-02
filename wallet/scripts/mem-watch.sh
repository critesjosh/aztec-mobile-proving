#!/usr/bin/env bash
# Sample total PSS for the wallet app process AND its WebView sandboxed
# renderer during flows, via adb dumpsys. Records the peak of each and of the
# sum. Memory is a first-class concern for this wallet (wallet/PLAN.md M3
# gate); the in-app MemoryInfo module cannot see the WebView process, so this
# is the authoritative whole-app measurement.
#
# Usage: ./mem-watch.sh [package] [interval_seconds]
#   package defaults to foundation.aztec.wallet
# Stop with Ctrl-C; peaks print on exit and stream to stdout continuously.
set -u

pkg="${1:-foundation.aztec.wallet}"
interval="${2:-1}"

peak_app=0
peak_webview=0
peak_total=0

pss_of() {
  # dumpsys meminfo -s <proc>: "TOTAL PSS:   123456" (kB)
  adb shell dumpsys meminfo -s "$1" 2>/dev/null | awk '/TOTAL PSS:/ {print $3; exit}'
}

webview_proc() {
  # The sandboxed renderer shows up as <pkg>:sandboxed_process0 (suffix varies).
  adb shell ps -A -o NAME 2>/dev/null | grep -m1 "^${pkg}:sandboxed" || true
}

trap 'echo; echo "PEAKS  app=${peak_app}kB  webview=${peak_webview}kB  total=${peak_total}kB"; exit 0' INT TERM

echo "watching $pkg (+ WebView renderer) every ${interval}s — Ctrl-C to stop"
while true; do
  app=$(pss_of "$pkg"); app=${app:-0}
  wv_name=$(webview_proc)
  wv=0
  if [ -n "$wv_name" ]; then
    wv=$(pss_of "$wv_name"); wv=${wv:-0}
  fi
  total=$((app + wv))
  [ "$app" -gt "$peak_app" ] && peak_app=$app
  [ "$wv" -gt "$peak_webview" ] && peak_webview=$wv
  [ "$total" -gt "$peak_total" ] && peak_total=$total
  printf '%s app=%skB webview=%skB total=%skB (peaks %s/%s/%s)\n' \
    "$(date +%H:%M:%S)" "$app" "$wv" "$total" "$peak_app" "$peak_webview" "$peak_total"
  sleep "$interval"
done
