#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Cadangan database BUnih.
#
#   bash deploy/scripts/cadangkan.sh [direktori-tujuan]
#
# Memakai perintah .backup milik SQLite sehingga aman dilakukan selagi aplikasi
# berjalan. Menyimpan 30 cadangan terakhir, sisanya dihapus.
# ---------------------------------------------------------------------------
set -euo pipefail

TUJUAN="${1:-/var/backups/bunih}"
SIMPAN="${BUNIH_SIMPAN_CADANGAN:-30}"
CAP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "${TUJUAN}"
chmod 700 "${TUJUAN}"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx bunih; then
  # Mode Docker: salin lewat kontainer agar jalur data selalu benar.
  docker exec bunih sqlite3 /data/bunih.sqlite ".backup '/tmp/bunih-${CAP}.sqlite'"
  docker cp "bunih:/tmp/bunih-${CAP}.sqlite" "${TUJUAN}/bunih-${CAP}.sqlite"
  docker exec bunih sh -c "rm -f /tmp/bunih-${CAP}.sqlite"
else
  # Mode systemd / langsung.
  DB="${BUNIH_DB_FILE:-/var/lib/bunih/bunih.sqlite}"
  [ -f "${DB}" ] || { printf 'Database tidak ditemukan di %s\n' "${DB}" >&2; exit 1; }
  sqlite3 "${DB}" ".backup '${TUJUAN}/bunih-${CAP}.sqlite'"
fi

chmod 600 "${TUJUAN}/bunih-${CAP}.sqlite"

# Periksa cadangan benar-benar dapat dibuka sebelum merotasi yang lama.
if ! sqlite3 "${TUJUAN}/bunih-${CAP}.sqlite" 'PRAGMA integrity_check;' | grep -qx ok; then
  printf 'Cadangan %s gagal pemeriksaan integritas. Yang lama TIDAK dihapus.\n' "${CAP}" >&2
  exit 1
fi

printf 'Cadangan dibuat: %s/bunih-%s.sqlite\n' "${TUJUAN}" "${CAP}"

# Rotasi: sisakan ${SIMPAN} berkas terbaru.
jumlah="$(ls -1 "${TUJUAN}"/bunih-*.sqlite 2>/dev/null | wc -l | tr -d ' ')"
if [ "${jumlah}" -gt "${SIMPAN}" ]; then
  ls -1t "${TUJUAN}"/bunih-*.sqlite | tail -n "+$((SIMPAN + 1))" | while read -r lama; do
    printf 'Menghapus cadangan lama: %s\n' "${lama}"
    rm -f -- "${lama}"
  done
fi

printf 'Cadangan tersimpan: %s berkas di %s\n' \
  "$(ls -1 "${TUJUAN}"/bunih-*.sqlite 2>/dev/null | wc -l | tr -d ' ')" "${TUJUAN}"
