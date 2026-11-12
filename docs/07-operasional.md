# Operasional

## Memeriksa kesehatan

```bash
bash deploy/scripts/kesehatan.sh
```

Keluar dengan kode 0 bila sehat, 1 bila ada masalah — cocok dipasang di cron.
Yang diperiksa: HTTP menjawab, status Gmail dan Telegram, status kontainer/layanan,
kesalahan terakhir di log, umur cadangan terbaru (memberi peringatan bila > 48 jam),
dan sisa disk.

Pemeriksaan mandiri dari aplikasi:

```bash
curl -s https://keuangan.domainmu.id/api/kesehatan
```

```json
{"status":"ok","waktu":"2026-11-12T11:19:09+07:00","zona":"Asia/Jakarta",
 "migrasi":1,"jumlah_transaksi":27,"gmail":true,"telegram":true,"scheduler":true}
```

Pemeriksaan otomatis tiap jam dengan pemberitahuan lewat Telegram:

```bash
crontab -e
# 0 * * * * cd /path/ke/BUnih && bash deploy/scripts/kesehatan.sh >/tmp/bunih-sehat.txt 2>&1 || \
#   curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage" \
#     -d chat_id=<CHAT_ID> --data-urlencode "text=BUnih bermasalah: $(tail -5 /tmp/bunih-sehat.txt)"
```

---

## Cadangan

```bash
bash deploy/scripts/cadangkan.sh                    # ke /var/backups/bunih
bash deploy/scripts/cadangkan.sh /tujuan/lain       # ke tempat lain
BUNIH_SIMPAN_CADANGAN=60 bash deploy/scripts/cadangkan.sh   # simpan 60 berkas
```

Memakai `sqlite3 .backup`, jadi aman dijalankan selagi aplikasi berjalan.
Setiap cadangan diperiksa integritasnya **sebelum** cadangan lama dirotasi; bila
pemeriksaan gagal, tidak ada yang dihapus.

Cadangan juga bisa diambil dari dalam aplikasi:
**Pengaturan → Ekspor seluruh data (JSON)** berisi semua tabel dan dapat dibaca
tanpa SQLite.

Aturan praktis: cadangan yang hanya ada di server yang sama bukan cadangan.
Salin ke tempat lain secara berkala:

```bash
rsync -az pengguna@server:/var/backups/bunih/ ~/cadangan-bunih/
```

---

## Pemulihan

```bash
bash deploy/scripts/pulihkan.sh /var/backups/bunih/bunih-20261112-020000.sqlite
```

Skrip akan: memeriksa integritas cadangan, meminta kamu mengetik `PULIHKAN`,
menghentikan layanan, **memindahkan** database yang sedang dipakai ke berkas
`.sebelum-pulih-<waktu>` (tidak menghapusnya), menyalin cadangan, membersihkan berkas
WAL, lalu menjalankan layanan kembali.

Setelah itu periksa:

```bash
bash deploy/scripts/kesehatan.sh
```

Kalau ternyata pemulihannya salah, database sebelumnya masih ada dengan akhiran
`.sebelum-pulih-<waktu>`.

---

## Pembaruan

```bash
bash deploy/scripts/perbarui.sh
```

Urutannya: cadangkan → ambil kode terbaru → jalankan pengujian → bangun ulang →
jalankan → periksa kesehatan. Migrasi database dijalankan otomatis saat aplikasi start
dan dicatat di tabel `_migration`, jadi menjalankan ulang aman.

Kalau pembaruan bermasalah, pulihkan dari cadangan yang baru saja dibuat di langkah
pertama.

---

## Log

```bash
# Docker
docker compose -f deploy/docker-compose.yml logs -f bunih
docker logs --tail 200 bunih | grep -i error

# systemd
journalctl -u bunih -f
journalctl -u bunih --since "1 hour ago" | grep -i gagal
```

Log diredaksi: nomor panjang (rekening, referensi) hanya menampilkan 4 digit
terakhir, dan alamat email dipotong. Isi email tidak pernah ditulis ke log.

Rotasi log Docker sudah diatur di `docker-compose.yml` (maks 10 MB × 5 berkas).

---

## Tugas terjadwal

| Tugas | Jadwal bawaan | Yang dilakukan |
|---|---|---|
| Siklus cepat | tiap 10 menit | Sinkronisasi Gmail, bangun ulang rencana, kirim pertanyaan dan peringatan mendesak |
| Siklus harian | pukul 07.00 WIB | Bangun ulang rencana, tanyakan top-up yang lewat, kirim ringkasan harian |
| Siklus mingguan | Senin, bersama siklus harian | Pengingat reimburse terlambat |

Diatur lewat `BUNIH_GMAIL_SYNC_CRON_MINUTES` dan `BUNIH_DAILY_DIGEST_HOUR`.
Matikan seluruhnya dengan `BUNIH_ENABLE_SCHEDULER=false`.

---

## Mencabut akses

**Gmail** — Pengaturan → Koneksi Gmail → **Cabut akses**. Token dicabut di sisi
Google dan dihapus dari database. Bisa juga dari
<https://myaccount.google.com/permissions>.

**Telegram** — kosongkan `TELEGRAM_ALLOWED_CHAT_ID` lalu mulai ulang; bot berhenti
menjawab siapa pun. Untuk mematikan bot sepenuhnya, set `TELEGRAM_MODE=off`.
Untuk mencabut tokennya, pakai `/revoke` di @BotFather.

**Web** — ganti `BUNIH_WEB_PASSWORD` lalu mulai ulang. Semua sesi lama tetap berlaku
sampai kedaluwarsa (14 hari); untuk memutusnya seketika, ganti juga
`BUNIH_SECRET_KEY` — tetapi perhatikan bahwa itu membuat token Gmail tersimpan tidak
dapat dibaca lagi, jadi Gmail harus disambungkan ulang.

---

## Memindahkan ke server lain

```bash
# di server lama
bash deploy/scripts/cadangkan.sh /tmp
scp /tmp/bunih-*.sqlite pengguna@server-baru:/tmp/
scp deploy/.env pengguna@server-baru:/tmp/bunih.env

# di server baru
git clone https://github.com/khansazafiri-rgb/BUnih.git && cd BUnih
cp /tmp/bunih.env deploy/.env && chmod 600 deploy/.env
bash deploy/scripts/pasang.sh
bash deploy/scripts/pulihkan.sh /tmp/bunih-<waktu>.sqlite
```

`BUNIH_SECRET_KEY` harus ikut pindah, kalau tidak token Gmail tidak dapat dibaca
dan harus disambungkan ulang.

---

## Masalah yang sering muncul

| Gejala | Kemungkinan sebab | Tindakan |
|---|---|---|
| `/api/kesehatan` tidak menjawab | Kontainer mati | `docker compose logs bunih`; periksa `.env` lengkap |
| Gmail tidak tersinkron | Token kedaluwarsa atau dicabut | Pengaturan → sambungkan ulang. Periksa `error_terakhir` |
| Bot tidak menjawab | Chat ID salah | Kosongkan `TELEGRAM_ALLOWED_CHAT_ID`, kirim `/mulai`, isi ulang |
| Bot menjawab dobel | Dua proses berjalan | `docker ps`; pastikan hanya satu kontainer `bunih` |
| Saldo tampak salah | Titik tambat kedaluwarsa | Impor mutasi terbaru, atau catat saldo terkonfirmasi lagi |
| Transaksi dobel | Dua transaksi dengan nomor referensi berbeda | Buka detailnya; koreksi salah satu jadi `koreksi` |
| Proyeksi terlalu optimis | Perkiraan reimburse ikut dihitung | Lihat "saldo terendah tanpa reimburse" di Arus Harian |
| Blok periode kosong | `periode_mulai` belum diisi | Anggaran → Ubah asumsi |
| Build kehabisan memori | RAM < 1 GB | Tambah swap, atau bangun citra di komputermu |

---

## Yang TIDAK dilakukan aplikasi ini

- Tidak melakukan transfer atau pembayaran.
- Tidak pernah meminta OTP, PIN, atau kata sandi bank.
- Tidak mengirim, menghapus, atau mengubah email.
- Tidak mengubah Google Sheet-mu.
- Tidak mengirim datamu ke pihak ketiga mana pun. Ia hanya berbicara dengan
  Google (Gmail API) dan Telegram.
