#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Audit server SEBELUM memasang BUnih.
#
# Skrip ini HANYA MEMBACA. Ia tidak mengubah apa pun dan tidak menyentuh Hermes.
# Jalankan di server Tencent Cloud, lalu kirimkan hasilnya kalau perlu dibaca
# bersama-sama:
#
#   bash deploy/scripts/audit-server.sh | tee audit-server.txt
# ---------------------------------------------------------------------------
set -uo pipefail

garis() { printf '\n== %s ==\n' "$1"; }
ada()   { command -v "$1" >/dev/null 2>&1; }

printf 'Audit server untuk BUnih — %s\n' "$(date -Is)"

garis "Sistem operasi"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  printf 'Distribusi : %s %s\n' "${NAME:-?}" "${VERSION:-?}"
fi
printf 'Kernel     : %s\n' "$(uname -r)"
printf 'Arsitektur : %s\n' "$(uname -m)"
printf 'Zona waktu : %s\n' "$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo '?')"
printf 'Uptime     : %s\n' "$(uptime -p 2>/dev/null || echo '?')"

garis "CPU"
printf 'Jumlah inti : %s\n' "$(nproc 2>/dev/null || echo '?')"
if ada lscpu; then lscpu | grep -E 'Model name|CPU\(s\):|MHz' | head -4; fi
printf 'Beban 1/5/15 menit : %s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '?')"
printf '\nCatatan: beban rata-rata di atas jumlah inti berarti CPU sudah penuh.\n'

garis "RAM dan swap"
free -h 2>/dev/null || echo 'perintah free tidak tersedia'
printf '\nBUnih butuh sekitar 150-300 MB RAM saat berjalan, dan sampai ~1 GB sementara saat membangun citra.\n'

garis "Disk"
df -h / /var /opt 2>/dev/null | sed 's/^/  /'
printf '\nBUnih butuh ~500 MB untuk citra + node_modules, dan database tumbuh pelan (beberapa MB per tahun).\n'
if ada docker; then
  printf '\nPemakaian disk oleh Docker:\n'
  docker system df 2>/dev/null | sed 's/^/  /' || printf '  (tidak dapat dibaca tanpa izin docker)\n'
fi

garis "Docker"
if ada docker; then
  printf 'docker  : %s\n' "$(docker --version 2>/dev/null)"
  printf 'compose : %s\n' "$(docker compose version 2>/dev/null || echo 'plugin compose tidak ada')"
  printf '\nKontainer yang sedang berjalan:\n'
  docker ps --format '  {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null \
    || printf '  (tidak dapat dibaca; coba dengan sudo)\n'
  printf '\nVolume:\n'
  docker volume ls --format '  {{.Name}}' 2>/dev/null | head -30
else
  printf 'Docker belum terpasang. Lihat docs/06-pasang-tencent.md bagian "Tanpa Docker"\n'
  printf 'atau pasang Docker lebih dulu.\n'
fi

garis "Node.js"
if ada node; then printf 'node : %s\n' "$(node --version)"; else printf 'node : belum terpasang\n'; fi
if ada npm;  then printf 'npm  : %s\n' "$(npm --version)";  else printf 'npm  : belum terpasang\n'; fi
printf '\nBUnih butuh Node.js 22 atau lebih baru bila dijalankan tanpa Docker.\n'

garis "Hermes agent (jangan diganggu)"
ditemukan=0
if ada docker; then
  hermes_kontainer="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i hermes || true)"
  if [ -n "${hermes_kontainer}" ]; then
    ditemukan=1
    printf 'Kontainer Docker bernama Hermes:\n'
    printf '%s\n' "${hermes_kontainer}" | sed 's/^/  /'
  fi
fi
if ada systemctl; then
  hermes_unit="$(systemctl list-units --type=service --no-legend 2>/dev/null | grep -i hermes || true)"
  if [ -n "${hermes_unit}" ]; then
    ditemukan=1
    printf 'Layanan systemd bernama Hermes:\n'
    printf '%s\n' "${hermes_unit}" | sed 's/^/  /'
  fi
fi
# Show executable NAME only, never process arguments: argv may contain API tokens.
hermes_proses="$(ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pmem 2>/dev/null | grep -i hermes | grep -v grep || true)"
if [ -n "${hermes_proses}" ]; then
  ditemukan=1
  printf 'Proses dengan nama executable Hermes (tanpa argumen rahasia):\n'
  printf '%s\n' "${hermes_proses}" | sed 's/^/  /'
fi
if [ "${ditemukan}" -eq 0 ]; then
  printf 'Tidak ditemukan kontainer, layanan, atau proses bernama hermes.\n'
  printf 'Kalau Hermes memang berjalan di sini dengan nama lain, catat namanya sebelum memasang.\n'
fi

garis "Port yang sudah dipakai"
if ada ss; then
  ss -tlnp 2>/dev/null | sed 's/^/  /' | head -40
elif ada netstat; then
  netstat -tlnp 2>/dev/null | sed 's/^/  /' | head -40
fi
printf '\nBUnih memakai 127.0.0.1:8787. Pastikan port itu belum dipakai.\n'

garis "nginx dan HTTPS"
if ada nginx; then
  printf 'nginx : %s\n' "$(nginx -v 2>&1)"
  printf 'Konfigurasi aktif:\n'
  ls -1 /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | sed 's/^/  /' || printf '  (tidak ada)\n'
else
  printf 'nginx belum terpasang.\n'
fi
if ada certbot; then
  printf '\nSertifikat Let\''s Encrypt:\n'
  certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry' | sed 's/^/  /' \
    || printf '  (tidak dapat dibaca tanpa sudo)\n'
else
  printf '\ncertbot belum terpasang.\n'
fi

garis "Firewall"
if ada ufw; then ufw status 2>/dev/null | sed 's/^/  /'; fi
if ada firewall-cmd; then firewall-cmd --list-all 2>/dev/null | sed 's/^/  /'; fi
printf '\nCatatan: grup keamanan Tencent Cloud juga perlu mengizinkan port 80 dan 443.\n'

garis "Keluar internet"
for host in registry.npmjs.org oauth2.googleapis.com gmail.googleapis.com api.telegram.org; do
  if ada curl; then
    kode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://${host}" 2>/dev/null || echo 'gagal')"
    printf '  %-28s %s\n' "${host}" "${kode}"
  fi
done
printf '\nSemua host di atas harus dapat dihubungi. api.telegram.org wajib untuk bot.\n'

garis "Pencadangan yang sudah ada"
ls -lh /var/backups 2>/dev/null | sed 's/^/  /' | head -10 || printf '  /var/backups tidak ada\n'

garis "Ringkasan keputusan"
inti="$(nproc 2>/dev/null || echo 0)"
ram_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
disk_mb="$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
printf 'Inti CPU         : %s  (BUnih cukup dengan 1 inti bersama)\n' "${inti}"
printf 'RAM total        : %s MB (butuh >= 1024 MB total agar aman bersama Hermes)\n' "${ram_mb}"
printf 'Disk kosong di / : %s MB (butuh >= 2000 MB untuk membangun citra)\n' "${disk_mb}"
printf '\n'
if [ "${ram_mb}" -lt 1024 ] 2>/dev/null; then
  printf 'PERHATIAN: RAM di bawah 1 GB. Bangun citra di mesin lain lalu kirim citranya,\n'
  printf 'atau tambahkan swap 1 GB sebelum membangun. Lihat docs/06-pasang-tencent.md.\n'
fi
if [ "${disk_mb}" -lt 2000 ] 2>/dev/null; then
  printf 'PERHATIAN: disk kosong di bawah 2 GB. Bersihkan dulu atau tambah volume.\n'
fi
printf '\nAudit selesai. Tidak ada yang diubah di server ini.\n'
