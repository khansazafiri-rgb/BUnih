# Langkah pemasangan ke server

Panduan ini untuk memasang BUnih di **Tencent Cloud yang sudah kamu pakai untuk
Hermes agent**, tanpa mengganggu Hermes dan tanpa memberi Hermes akses ke token
Gmail maupun database keuanganmu.

Ikuti berurutan. Setiap bagian menyebutkan apa yang berubah di server.

| Bagian | Isi |
|---|---|
| [0](#0-sebelum-mulai) | Yang perlu kamu siapkan |
| [1](#1-audit-server-dulu) | **Audit server — hanya membaca, tidak mengubah apa pun** |
| [2](#2-membaca-hasil-audit) | Cukup atau tidak, dengan angkanya |
| [3](#3-bagaimana-bunih-dipisahkan-dari-hermes) | Pemisahan akses |
| [4](#4-menyiapkan-kredensial) | Google OAuth dan bot Telegram |
| [5](#5-memasang) | Pemasangan |
| [6](#6-domain-dan-https) | nginx + sertifikat |
| [7](#7-cadangan-otomatis) | Cadangan harian |
| [8](#8-penyiapan-pertama-di-aplikasi) | Konfirmasi rekening, saldo, Gmail, Telegram |
| [9](#9-kalau-tencent-tidak-cukup) | Alternatif beserta perkiraan biayanya |
| [10](#10-tanpa-docker) | Pemasangan langsung dengan systemd |

---

## 0. Sebelum mulai

Yang kamu butuhkan:

- Akses SSH ke server Tencent Cloud, dengan `sudo`.
- Satu nama domain atau subdomain yang mengarah ke IP server, misalnya
  `keuangan.domainmu.id`. (Bisa ditunda; aplikasi tetap jalan di localhost dulu.)
- Akun Google tempat email transaksi masuk.
- Telegram di ponselmu.

Yang **tidak** dibutuhkan: OTP, PIN, atau kata sandi bank. BUnih tidak pernah
memintanya dan tidak melakukan transfer apa pun.

Perkiraan waktu: 30–45 menit, ditambah menunggu pembangunan citra pertama.

---

## 1. Audit server dulu

Kamu memintaku memeriksa dulu sebelum memasang. Aku **tidak punya akses ke server
Tencent-mu**, jadi pemeriksaannya dibungkus sebagai skrip yang kamu jalankan sendiri.
Skrip itu **hanya membaca** — tidak memasang, tidak mengubah, tidak menyentuh Hermes.

```bash
git clone https://github.com/khansazafiri-rgb/BUnih.git
cd BUnih
bash deploy/scripts/audit-server.sh | tee audit-server.txt
```

Yang diperiksanya:

| Bagian | Kenapa penting |
|---|---|
| OS, kernel, arsitektur, zona waktu | Memastikan Docker/Node didukung; zona waktu memengaruhi jadwal |
| CPU: jumlah inti dan beban | Beban di atas jumlah inti berarti CPU sudah penuh |
| RAM dan swap | Pembangunan citra butuh sampai ~1 GB sementara |
| Disk: sisa di `/`, pemakaian Docker | Butuh ≥ 2 GB kosong untuk membangun |
| Docker dan Compose | Menentukan cara pemasangan |
| Node.js | Hanya perlu untuk mode tanpa Docker |
| **Hermes** | Mendaftar kontainer, layanan systemd, dan proses bernama hermes, beserta pemakaian memorinya |
| Port yang terpakai | Memastikan 8787 bebas |
| nginx dan sertifikat | Apakah sudah ada yang bisa dipakai bersama |
| Firewall | ufw/firewalld; ingat grup keamanan Tencent juga |
| Keluar internet | npm, Google OAuth, Gmail API, Telegram API |
| Cadangan yang sudah ada | Apakah ada pola yang bisa diikuti |

Simpan `audit-server.txt`. Kalau mau dibaca bersama, kirimkan isinya.

---

## 2. Membaca hasil audit

Bagian terakhir keluaran skrip sudah menyimpulkannya. Patokannya:

| Sumber daya | Minimum | Nyaman | Dipakai BUnih |
|---|---|---|---|
| Inti CPU | 1 (berbagi) | 2 | < 5% saat diam; naik sebentar tiap sinkronisasi |
| RAM | 1 GB total mesin | 2 GB | 150–300 MB saat jalan |
| RAM saat membangun | +1 GB sementara | | hanya saat `docker build` |
| Disk | 2 GB kosong | 5 GB | ~500 MB citra, database beberapa MB per tahun |

**Kalau RAM mesin di bawah 1 GB**, jangan membangun citra di server. Dua jalan keluar:

*a. Tambah swap 1 GB sementara* (aman, bisa dicabut lagi):

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
# setelah selesai membangun:  sudo swapoff /swapfile
```

*b. Bangun di komputermu, kirim citranya:*

```bash
# di komputermu
docker build -f deploy/Dockerfile -t bunih:latest .
docker save bunih:latest | gzip > bunih.tar.gz
scp bunih.tar.gz pengguna@server:/tmp/

# di server
gunzip -c /tmp/bunih.tar.gz | sudo docker load
```

**Kalau disk kosong di bawah 2 GB**, bersihkan dulu:

```bash
docker system df          # lihat apa yang memakan tempat
docker image prune -a     # hapus citra yang tidak dipakai kontainer mana pun
journalctl --vacuum-time=7d
```

Periksa lebih dulu dengan `docker ps -a` bahwa citra Hermes sedang dipakai, supaya
tidak ikut terhapus.

**Kalau salah satu host di bagian "Keluar internet" gagal dihubungi**, perbaiki itu
sebelum lanjut. `api.telegram.org` wajib untuk bot; `oauth2.googleapis.com` dan
`gmail.googleapis.com` wajib untuk Gmail.

---

## 3. Bagaimana BUnih dipisahkan dari Hermes

Pemisahannya disengaja dan berlapis:

| Lapis | Pemisahan |
|---|---|
| Proses | Kontainer sendiri (`bunih`), atau pengguna systemd sendiri (`bunih`) |
| Data | Volume Docker sendiri (`bunih_data`), tidak pernah di-mount ke kontainer lain |
| Jaringan | Jaringan Docker sendiri (`bunih_net`); Hermes tidak ada di dalamnya |
| Port | Hanya terikat ke `127.0.0.1:8787`, tidak ke `0.0.0.0` |
| Kredensial | `deploy/.env` dengan hak akses `600` milik pengguna layanan |
| Hak istimewa | `no-new-privileges`, berjalan sebagai pengguna `node` (bukan root) |
| Sumber daya | Dibatasi 0,75 CPU dan 512 MB RAM, supaya Hermes tidak terdesak |
| Log | Dirotasi (maks 10 MB × 5), tidak memenuhi disk |

**Yang tidak boleh dilakukan:**

- Jangan menambahkan Hermes ke `bunih_net`.
- Jangan me-mount `bunih_data` ke kontainer Hermes.
- Jangan menaruh `BUNIH_SECRET_KEY`, token Gmail, atau token Telegram di berkas
  environment yang dibaca Hermes.
- Jangan menjalankan BUnih sebagai pengguna yang sama dengan Hermes.

Sebaliknya, pemasangan ini tidak menyentuh apa pun milik Hermes: tidak mengubah
kontainer, volume, layanan, atau konfigurasi nginx yang sudah ada.

Untuk memastikan Hermes tetap sehat, catat keadaannya sebelum dan sesudah:

```bash
docker ps                      # sebelum memasang
# ... pasang BUnih ...
docker ps                      # sesudah: Hermes harus tetap Up dengan uptime yang sama
```

---

## 4. Menyiapkan kredensial

### 4a. Google OAuth (untuk membaca Gmail)

Izin yang diminta hanya `gmail.readonly` — membaca, tidak mengirim, tidak menghapus.
Kata sandi Gmail tidak pernah diminta.

1. Buka <https://console.cloud.google.com/> dan buat proyek baru, misalnya "BUnih".
2. **APIs & Services → Library** → cari **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - Isi nama aplikasi, email dukungan, email pengembang
   - **Scopes** → tambahkan `https://www.googleapis.com/auth/gmail.readonly`
   - **Test users** → tambahkan alamat Gmail-mu sendiri
   - Biarkan dalam mode **Testing**; itu cukup untuk pemakaian pribadi
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: `https://keuangan.domainmu.id/api/gmail/callback`
   - Simpan **Client ID** dan **Client secret**

> Belum punya domain? Pakai `http://127.0.0.1:8787/api/gmail/callback` dan sambungkan
> Gmail lewat terowongan SSH (`ssh -L 8787:127.0.0.1:8787 pengguna@server`), lalu ganti
> redirect URI-nya setelah domainmu siap.

### 4b. Bot Telegram

1. Buka **@BotFather** di Telegram → `/newbot` → ikuti petunjuknya.
2. Simpan tokennya (bentuknya `123456789:AA...`).
3. Chat ID-mu diisi nanti — bot akan memberitahukannya di langkah 8.

---

## 5. Memasang

```bash
cd ~/BUnih           # atau di mana pun kamu meng-clone
bash deploy/scripts/pasang.sh
```

Jalan pertama akan membuat `deploy/.env`, membuatkan `BUNIH_SECRET_KEY` dan kata
sandi web secara acak, lalu berhenti dan menampilkan kata sandinya.
**Simpan kata sandi itu sekarang; ia hanya ditampilkan sekali.**

Buka `deploy/.env` dan isi sisanya:

```ini
BUNIH_BASE_URL=https://keuangan.domainmu.id
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=....
GOOGLE_REDIRECT_URI=https://keuangan.domainmu.id/api/gmail/callback
TELEGRAM_BOT_TOKEN=123456789:AA....
TELEGRAM_ALLOWED_CHAT_ID=        # diisi di langkah 8
TELEGRAM_MODE=polling
```

Jalankan lagi:

```bash
bash deploy/scripts/pasang.sh
```

Skrip akan membangun citra, menjalankan layanan, dan menunggu sampai
`/api/kesehatan` menjawab. Periksa:

```bash
curl -s http://127.0.0.1:8787/api/kesehatan
docker ps                      # Hermes harus tetap Up seperti sebelumnya
```

### Kenapa long polling untuk Telegram

Bawaannya `TELEGRAM_MODE=polling`. Alasannya:

- Tidak butuh domain, sertifikat, atau port terbuka — jadi bot sudah bisa dipakai
  sebelum HTTPS siap.
- Tidak menambah permukaan serangan di mesin yang juga menjalankan Hermes.
- Biaya sumber daya untuk satu pengguna dapat diabaikan.

Setelah HTTPS siap dan kamu ingin balasan sedikit lebih cepat, ganti ke
`TELEGRAM_MODE=webhook`, isi `TELEGRAM_WEBHOOK_SECRET` dengan teks acak, mulai ulang,
lalu daftarkan webhook-nya:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://keuangan.domainmu.id/api/telegram/webhook/<SECRET>"
```

### Kenapa sinkronisasi Gmail berkala, bukan Pub/Sub

Versi pertama memakai sinkronisasi berkala (bawaan tiap 10 menit) dengan `historyId`,
dan jatuh kembali ke pencarian beberapa hari terakhir bila titik riwayatnya
kedaluwarsa — jadi tidak ada email yang terlewat diam-diam.

Gmail API + Pub/Sub memang memberi notifikasi dalam hitungan detik, tetapi menuntut
proyek Google Cloud dengan topik dan langganan Pub/Sub, endpoint push ber-HTTPS yang
terverifikasi, dan perpanjangan `watch` tiap 7 hari. Untuk catatan keuangan pribadi,
jeda sepuluh menit tidak mengubah keputusan apa pun, sementara kerumitan operasinya
nyata. Pindah ke Pub/Sub bisa dilakukan belakangan tanpa mengubah model data.

---

## 6. Domain dan HTTPS

**Syarat sebelum langkah ini:** hasil audit memastikan nginx **di host** sudah
menangani port 80/443 atau dapat dipasang tanpa berbenturan dengan Hermes.
Periksa dulu dengan `ss -tlnp | grep -E ':(80|443)([[:space:]]|$)'` dan daftar proses/kontainer
dari audit. **Jangan memasang nginx baru** bila Hermes memakai Caddy, Traefik,
nginx di Docker, atau proxy lain yang sudah mengikat port tersebut. Untuk
kasus itu, tambahkan *virtual host/upstream* baru di proxy **yang sama**,
arahkannya ke `http://127.0.0.1:8787`, dan terbitkan HTTPS menggunakan
mekanisme proxy tersebut. Jangan ubah konfigurasi Hermes.

Jika nginx **di host** adalah proxy yang benar:

1. Buat A record nama domainmu menuju IP publik server. Pastikan port 80 dan
   443 bisa diakses di firewall host dan Tencent Cloud security group.
2. Pasang Certbot bila belum ada. Pada server yang sudah memiliki nginx,
   jangan lakukan instal ulang yang bisa memengaruhi layanan lain.
3. **Bootstrap HTTP tanpa sertifikat** terlebih dahulu. Konfigurasi produksi
   `deploy/nginx/bunih.conf` tidak boleh dipakai sebelum sertifikat tersedia.

```bash
# Di server, dari akar repo BUnih. Ganti domain contoh di kedua perintah sed.
DOMAIN=keuangan.domainmu.id
sudo apt-get install -y certbot
sudo install -d -m 0755 /var/www/letsencrypt
sudo cp deploy/nginx/bunih-bootstrap.conf /etc/nginx/conf.d/bunih.conf
sudo sed -i "s/keuangan.contoh.id/$DOMAIN/g" /etc/nginx/conf.d/bunih.conf
sudo nginx -t && sudo systemctl reload nginx

# Minta sertifikat dengan challenge HTTP-01, tanpa Certbot mengubah conf Hermes.
sudo certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN"

# Sertifikat sudah ada: baru gunakan konfigurasi HTTPS produksi.
sudo cp deploy/nginx/bunih.conf /etc/nginx/conf.d/bunih.conf
sudo sed -i "s/keuangan.contoh.id/$DOMAIN/g" /etc/nginx/conf.d/bunih.conf
sudo nginx -t && sudo systemctl reload nginx

curl -fsS "https://$DOMAIN/api/kesehatan"
```

**Penting:** jika `sudo nginx -t` gagal, **jangan reload**. Periksa
pesan galat dan kembalikan konfigurasi bootstrap di atas bila perlu;
proses Hermes yang sudah berjalan tetap tidak diubah. Jangan menyalin
berkas baru ke `/etc/nginx/conf.d/bunih.conf` bila jalur itu sudah
digunakan layanan lain—periksa dahulu.

Bila nginx pada host belum ada dan port 80/443 benar-benar bebas,
pasang terlebih dulu dengan `sudo apt-get install -y nginx` lalu ikuti
langkah di atas. Bila memakai ufw, buka 80/443 **hanya setelah**
konfirmasi tidak ada kebijakan Hermes yang bertentangan.

Setelah HTTPS hidup, ubah `BUNIH_BASE_URL` dan
`GOOGLE_REDIRECT_URI` pada `deploy/.env` menjadi HTTPS sesuai domain,
kemudian:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

> Perubahan nilai `deploy/.env` dan sertifikat harus dilakukan di server saja.
> Jangan mengunggahnya ke GitHub atau mengirimkannya ke chat.

---

## 7. Cadangan otomatis

Uji dulu secara manual:

```bash
sudo install -d -m 0700 /var/backups/bunih
bash deploy/scripts/cadangkan.sh
ls -lh /var/backups/bunih
```

Skrip memakai `sqlite3 .backup`, jadi aman dijalankan selagi aplikasi berjalan.
Ia memeriksa integritas cadangan sebelum merotasi yang lama, dan menyimpan 30 berkas
terakhir.

Pasang jadwal harian pukul 02.00 WIB:

```bash
sudo cp deploy/systemd/bunih-cadangan.service /etc/systemd/system/
sudo cp deploy/systemd/bunih-cadangan.timer  /etc/systemd/system/
sudo sed -i "s|/opt/bunih|$(pwd)|" /etc/systemd/system/bunih-cadangan.service
sudo sed -i "s|^User=bunih|User=$USER|;s|^Group=bunih|Group=$USER|" /etc/systemd/system/bunih-cadangan.service
sudo systemctl daemon-reload
sudo systemctl enable --now bunih-cadangan.timer
systemctl list-timers bunih-cadangan.timer
```

Atau lewat cron:

```bash
crontab -e
# 0 2 * * * cd /path/ke/BUnih && bash deploy/scripts/cadangkan.sh >> /var/log/bunih-cadangan.log 2>&1
```

**Cadangan yang hanya ada di server yang sama bukan cadangan.** Salin ke tempat lain:

```bash
# dari komputermu, misalnya mingguan
rsync -az pengguna@server:/var/backups/bunih/ ~/cadangan-bunih/
```

Pemulihan ada di [docs/07-operasional.md](07-operasional.md).

---

## 8. Penyiapan pertama di aplikasi

Buka `https://keuangan.domainmu.id`, masuk dengan kata sandi dari langkah 5.

**a. Konfirmasi rekening** — Pengaturan → Rekening:
isi 4 digit terakhir Mandiri Livin' dan BCA. Pencocokan email baru bisa membedakan
rekeningmu dari rekening orang lain setelah ini terisi.

**b. Catat saldo terkonfirmasi** — di halaman yang sama, isi saldo masing-masing
rekening hari ini. Ini menjadi titik tambat; sebelum ada, aplikasi menolak menyebut
angka apa pun sebagai saldo bank.

Lebih baik lagi: impor mutasi bank (Pengaturan → Impor mutasi). Baris saldo terakhir
otomatis menjadi titik tambat, dan transaksi yang sudah dikenal dari email akan
digabung, bukan diduplikasi.

**c. Isi tanggal awal periode** — Anggaran → Ubah asumsi → "Tanggal awal periode".
Tanpa ini, blok lima hari dan rencana top-up tidak dibuat.

Sambil di situ, konfirmasi juga nilai yang sekarang masih berupa asumsi Sheet:
anggaran makan harian, cadangan minimal, nominal dan interval top-up.

**d. Sambungkan Gmail** — Pengaturan → Koneksi Gmail → **Sambungkan Gmail**.
Setujui izin baca-saja. Lalu jalankan **sinkronisasi historis** dengan rentang yang
kamu pilih (misalnya sejak 1 Januari tahun ini).

**e. Hubungkan Telegram** — kirim `/mulai` ke botmu. Karena `TELEGRAM_ALLOWED_CHAT_ID`
masih kosong, bot membalas dengan Chat ID-mu. Isi nilai itu ke `deploy/.env`, lalu:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

Kirim `/hari` untuk memastikan bot sudah mengenalimu.

**f. Impor Sheet** — Pengaturan → Impor awal dari Google Sheet. Ekspor tiap tab
sebagai CSV, unggah, periksa pemetaan kolomnya, jalankan **uji coba** dulu, baca
daftar "data tidak jelas", baru jalankan impor.

**g. Jawab pertanyaan yang menumpuk** — Beranda → Perlu tindakan, atau langsung dari
Telegram.

---

## 9. Kalau Tencent tidak cukup

Sebelum menyarankan beli server baru, urutan yang lebih murah:

1. **Tambah swap 1 GB** — gratis, cukup untuk mengatasi kendala RAM saat membangun.
2. **Bangun citra di komputermu lalu kirim** — gratis, menghilangkan kebutuhan RAM
   puncak di server (lihat bagian 2).
3. **Bersihkan disk** — `docker image prune -a`, `journalctl --vacuum-time=7d`.
4. **Tingkatkan paket Tencent yang sudah ada** — biasanya lebih murah daripada
   menambah instance kedua, dan tidak menambah pekerjaan operasional.

Baru kalau pemisahan aksesnya sendiri yang tidak bisa dijamin — misalnya Hermes
berjalan sebagai root dan punya akses ke seluruh berkas, atau kamu tidak dapat
membuat pengguna/volume terpisah — barulah mesin terpisah masuk akal.

Perkiraan biaya untuk server kecil terpisah (1 vCPU / 1 GB / 25 GB SSD), per bulan:

| Penyedia | Perkiraan |
|---|---|
| Tencent Cloud Lighthouse (Jakarta/Singapura) | sekitar Rp55.000 – Rp90.000 |
| Alibaba Cloud ECS (Jakarta) | sekitar Rp70.000 – Rp120.000 |
| Biznet Gio (kamu sudah punya akun) | sekitar Rp75.000 – Rp150.000 |
| IDCloudHost (kamu sudah punya akun) | sekitar Rp60.000 – Rp120.000 |
| Hetzner CX22 (Jerman, latensi ~170 ms) | sekitar Rp65.000 |

Angka-angka ini **perkiraan kasar per November 2026 dan belum diverifikasi** —
harga dan kurs berubah. Periksa langsung sebelum memutuskan, dan ingat bahwa
BUnih tidak butuh latensi rendah: ia hanya menarik email dan menjawab Telegram.

Satu catatan: kamu sudah membayar IDCloudHost VPS (ditanggung company) dan
Biznet Gio (pribadi). Sebelum menambah langganan, periksa apakah salah satunya
punya sisa kapasitas. Setelah nominal dan status keduanya terverifikasi di aplikasi,
halaman Tagihan akan memperlihatkan berapa sebenarnya yang kamu bayar untuk server
tiap bulan.

---

## 10. Tanpa Docker

Kalau kamu lebih suka proses biasa:

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs sqlite3

# pengguna dan direktori khusus
sudo useradd --system --home /opt/bunih --shell /usr/sbin/nologin bunih
sudo install -d -o bunih -g bunih -m 0750 /opt/bunih /var/lib/bunih

sudo cp -r . /opt/bunih && cd /opt/bunih
sudo chown -R bunih:bunih /opt/bunih

sudo -u bunih npm ci --no-audit --no-fund
sudo -u bunih npm run build

sudo -u bunih cp .env.example .env
sudo chmod 600 .env
sudo -u bunih nano .env       # isi seperti langkah 5, BUNIH_DATA_DIR=/var/lib/bunih

sudo cp deploy/systemd/bunih.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bunih
sudo systemctl status bunih
journalctl -u bunih -f
```

Berkas layanannya sudah diperketat: `ProtectSystem=strict`, `ProtectHome=true`,
`NoNewPrivileges=true`, dan hanya `/var/lib/bunih` yang dapat ditulis. Batas 512 MB
RAM dan 75% CPU menjaga agar Hermes tidak terdesak.

---

## Ringkasan perintah

```bash
bash deploy/scripts/audit-server.sh      # periksa server (hanya membaca)
bash deploy/scripts/pasang.sh            # pasang
bash deploy/scripts/kesehatan.sh         # periksa kesehatan
bash deploy/scripts/cadangkan.sh         # cadangkan sekarang
bash deploy/scripts/pulihkan.sh BERKAS   # pulihkan dari cadangan
bash deploy/scripts/perbarui.sh          # perbarui ke versi terbaru

docker compose -f deploy/docker-compose.yml logs -f bunih   # log langsung
docker compose -f deploy/docker-compose.yml restart bunih   # mulai ulang
```
