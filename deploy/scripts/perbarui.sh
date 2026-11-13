#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Memperbarui BUnih ke versi terbaru.
#
#   bash deploy/scripts/perbarui.sh
#
# Urutannya: cadangkan dulu, baru perbarui. Bila gagal, cadangan sudah ada.
# ---------------------------------------------------------------------------
set -euo pipefail

AKAR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${AKAR}"

printf '\n[1/5] Mencadangkan database lebih dulu...\n'
bash deploy/scripts/cadangkan.sh

printf '\n[2/5] Mengambil kode terbaru...\n'
git pull --ff-only

printf '\n[3/5] Menjalankan pengujian...\n'
if command -v npm >/dev/null 2>&1; then
  npm ci --no-audit --no-fund >/dev/null
  npm test
else
  printf 'npm tidak ada di host; pengujian dilewati (akan tetap dijalankan di CI).\n'
fi

printf '\n[4/5] Membangun ulang dan menjalankan...\n'
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -qx bunih; then
  docker compose -f deploy/docker-compose.yml build
  docker compose -f deploy/docker-compose.yml up -d
else
  npm run build
  sudo systemctl restart bunih
fi

printf '\n[5/5] Memeriksa kesehatan...\n'
sleep 6
bash deploy/scripts/kesehatan.sh

printf '\nPembaruan selesai. Migrasi database dijalankan otomatis saat aplikasi start.\n'
printf 'Bila ada masalah, pulihkan dengan: bash deploy/scripts/pulihkan.sh <berkas-cadangan>\n'
