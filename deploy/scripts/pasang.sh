#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Memasang BUnih dengan Docker Compose.
#
#   bash deploy/scripts/pasang.sh
#
# Skrip berhenti bila ada yang belum siap, dan tidak pernah menimpa .env
# yang sudah ada. Tidak menyentuh Hermes.
# ---------------------------------------------------------------------------
set -euo pipefail

AKAR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENVFILE="${AKAR}/deploy/.env"

info()  { printf '\n[BUnih] %s\n' "$1"; }
gagal() { printf '\n[BUnih] GAGAL: %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || gagal 'Docker belum terpasang.'
docker compose version >/dev/null 2>&1 || gagal 'Plugin "docker compose" belum tersedia.'

if [ ! -f "${ENVFILE}" ]; then
  info 'Membuat deploy/.env dari contoh. Isi nilainya sebelum melanjutkan.'
  cp "${AKAR}/.env.example" "${ENVFILE}"
  chmod 600 "${ENVFILE}"

  if command -v openssl >/dev/null 2>&1; then
    KUNCI="$(openssl rand -hex 32)"
    SANDI="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
    sed -i "s|^BUNIH_SECRET_KEY=.*|BUNIH_SECRET_KEY=${KUNCI}|" "${ENVFILE}"
    sed -i "s|^BUNIH_WEB_PASSWORD=.*|BUNIH_WEB_PASSWORD=${SANDI}|" "${ENVFILE}"
    info "Kata sandi web dibuat otomatis: ${SANDI}"
    info 'Simpan kata sandi itu sekarang. Ia hanya ditampilkan sekali di sini.'
  fi

  printf '\nSekarang buka %s dan isi:\n' "${ENVFILE}"
  printf '  BUNIH_BASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,\n'
  printf '  GOOGLE_REDIRECT_URI, TELEGRAM_BOT_TOKEN\n'
  printf '\nSetelah itu jalankan skrip ini lagi.\n'
  exit 0
fi

chmod 600 "${ENVFILE}"

# Periksa nilai yang wajib ada.
for kunci in BUNIH_SECRET_KEY BUNIH_WEB_PASSWORD BUNIH_BASE_URL; do
  nilai="$(grep -E "^${kunci}=" "${ENVFILE}" | cut -d= -f2- || true)"
  [ -n "${nilai}" ] || gagal "${kunci} belum diisi di ${ENVFILE}"
done

info 'Membangun citra (beberapa menit pada pertama kali)...'
docker compose -f "${AKAR}/deploy/docker-compose.yml" build

info 'Menjalankan layanan...'
docker compose -f "${AKAR}/deploy/docker-compose.yml" up -d

info 'Menunggu layanan siap...'
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/api/kesehatan >/dev/null 2>&1; then
    info 'Layanan siap.'
    curl -fsS http://127.0.0.1:8787/api/kesehatan
    printf '\n'
    break
  fi
  sleep 2
  [ "${i}" -eq 30 ] && gagal 'Layanan tidak siap dalam 60 detik. Periksa: docker compose logs bunih'
done

info 'Membuat direktori cadangan /var/backups/bunih'
sudo install -d -m 0700 /var/backups/bunih 2>/dev/null || mkdir -p /var/backups/bunih || true

cat <<'PESAN'

Langkah berikutnya:
  1. Pasang nginx + HTTPS         : lihat docs/06-pasang-tencent.md bagian 6
  2. Pasang cadangan harian       : bash deploy/scripts/cadangkan.sh (uji sekali),
                                    lalu aktifkan systemd timer
  3. Buka web, masuk, lalu:
       - konfirmasi 4 digit rekening dan saldo terkonfirmasi
       - sambungkan Gmail (izin baca saja)
       - kirim /mulai ke bot Telegram untuk tahu Chat ID, isi di .env, mulai ulang
PESAN
