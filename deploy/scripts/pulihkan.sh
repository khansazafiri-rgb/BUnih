#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Memulihkan database BUnih dari cadangan.
#
#   bash deploy/scripts/pulihkan.sh /var/backups/bunih/bunih-20261112-020000.sqlite
#
# Database yang sedang dipakai TIDAK dihapus: ia dipindahkan ke berkas
# bernama .sebelum-pulih-<waktu> supaya masih bisa dikembalikan.
# ---------------------------------------------------------------------------
set -euo pipefail

SUMBER="${1:-}"
[ -n "${SUMBER}" ] || { printf 'Pakai: pulihkan.sh <berkas-cadangan>\n' >&2; exit 1; }
[ -f "${SUMBER}" ] || { printf 'Berkas %s tidak ada.\n' "${SUMBER}" >&2; exit 1; }

printf 'Memeriksa integritas cadangan...\n'
sqlite3 "${SUMBER}" 'PRAGMA integrity_check;' | grep -qx ok \
  || { printf 'Cadangan rusak. Pemulihan dibatalkan.\n' >&2; exit 1; }

printf '\nIni akan mengganti database yang sedang dipakai dengan isi cadangan.\n'
printf 'Ketik PULIHKAN untuk melanjutkan: '
read -r jawab
[ "${jawab}" = 'PULIHKAN' ] || { printf 'Dibatalkan.\n'; exit 0; }

CAP="$(date +%Y%m%d-%H%M%S)"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx bunih; then
  printf 'Menghentikan kontainer...\n'
  docker stop bunih >/dev/null
  docker run --rm -v bunih_data:/data -v "$(cd "$(dirname "${SUMBER}")" && pwd)":/masuk:ro \
    bunih:latest sh -c "
      if [ -f /data/bunih.sqlite ]; then mv /data/bunih.sqlite /data/bunih.sebelum-pulih-${CAP}.sqlite; fi;
      cp /masuk/$(basename "${SUMBER}") /data/bunih.sqlite;
      rm -f /data/bunih.sqlite-wal /data/bunih.sqlite-shm"
  printf 'Menjalankan kontainer kembali...\n'
  docker start bunih >/dev/null
else
  DB="${BUNIH_DB_FILE:-/var/lib/bunih/bunih.sqlite}"
  printf 'Menghentikan layanan...\n'
  sudo systemctl stop bunih
  [ -f "${DB}" ] && sudo mv "${DB}" "${DB}.sebelum-pulih-${CAP}"
  sudo cp "${SUMBER}" "${DB}"
  sudo rm -f "${DB}-wal" "${DB}-shm"
  sudo chown bunih:bunih "${DB}"
  printf 'Menjalankan layanan kembali...\n'
  sudo systemctl start bunih
fi

printf '\nPemulihan selesai. Database lama disimpan dengan akhiran .sebelum-pulih-%s\n' "${CAP}"
printf 'Periksa dengan: bash deploy/scripts/kesehatan.sh\n'
