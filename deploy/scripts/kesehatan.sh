#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pemeriksaan kesehatan BUnih.
#
#   bash deploy/scripts/kesehatan.sh [url]
#
# Keluar dengan kode 0 bila sehat, 1 bila ada masalah. Cocok untuk cron.
# ---------------------------------------------------------------------------
set -uo pipefail

URL="${1:-http://127.0.0.1:8787}"
masalah=0

periksa() {
  printf '%-34s' "$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'OK\n'
  else
    printf 'BERMASALAH\n'
    masalah=1
  fi
}

printf 'Pemeriksaan BUnih — %s\n\n' "$(date -Is)"

periksa 'HTTP menjawab' curl -fsS --max-time 10 "${URL}/api/kesehatan"

jawaban="$(curl -fsS --max-time 10 "${URL}/api/kesehatan" 2>/dev/null || echo '{}')"
printf '\nRincian dari aplikasi:\n'
printf '%s\n' "${jawaban}" | sed 's/,/,\n  /g' | sed 's/^/  /'

if printf '%s' "${jawaban}" | grep -q '"gmail":false'; then
  printf '\nCatatan: Gmail belum tersambung. Transaksi dari email tidak akan masuk.\n'
fi
if printf '%s' "${jawaban}" | grep -q '"telegram":false'; then
  printf 'Catatan: bot Telegram tidak aktif. Pengingat tidak akan terkirim.\n'
fi

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx bunih; then
  printf '\nStatus kontainer:\n'
  docker ps --filter name=bunih --format '  {{.Names}}\t{{.Status}}'
  printf '\nKesalahan terakhir di log:\n'
  docker logs --tail 200 bunih 2>&1 | grep -iE 'error|gagal|exception' | tail -5 | sed 's/^/  /' \
    || printf '  (tidak ada)\n'
elif command -v systemctl >/dev/null 2>&1; then
  printf '\nStatus layanan:\n'
  systemctl is-active bunih 2>/dev/null | sed 's/^/  /'
fi

printf '\nCadangan terbaru:\n'
ls -1t /var/backups/bunih/bunih-*.sqlite 2>/dev/null | head -3 | sed 's/^/  /' \
  || printf '  BELUM ADA CADANGAN\n'

terbaru="$(ls -1t /var/backups/bunih/bunih-*.sqlite 2>/dev/null | head -1 || true)"
if [ -n "${terbaru}" ]; then
  umur=$(( ($(date +%s) - $(stat -c %Y "${terbaru}")) / 3600 ))
  printf '  Umur cadangan terbaru: %s jam\n' "${umur}"
  if [ "${umur}" -gt 48 ]; then
    printf '  PERHATIAN: cadangan terakhir lebih dari 48 jam lalu.\n'
    masalah=1
  fi
else
  masalah=1
fi

printf '\nSisa disk:\n'
df -h / | tail -1 | sed 's/^/  /'

printf '\n'
if [ "${masalah}" -eq 0 ]; then
  printf 'Semua pemeriksaan lolos.\n'
else
  printf 'Ada pemeriksaan yang bermasalah. Lihat di atas.\n'
fi
exit "${masalah}"
