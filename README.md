# BUnih

Pusat kendali keuangan pribadi: web + Gmail + bot Telegram.
Bahasa Indonesia, zona waktu Asia/Jakarta, rupiah.

Telegram adalah antarmuka utama untuk mencatat dan mengoreksi transaksi.
Web dipakai untuk gambaran besar, mengatur asumsi, meninjau bukti, dan memperbaiki
data yang rumit.

---

## Satu aturan yang menentukan seluruh rancangan

> **Satu rupiah hanya boleh punya satu makna.**

Dari aturan itu muncul semua yang lain:

| Kejadian | Yang dilakukan BUnih |
|---|---|
| Invoice masuk | Jadi kewajiban. **Tidak** memotong saldo. |
| Kuitansi masuk | Jadi bukti pembayaran, ditautkan ke transaksi bank yang sama. |
| Notifikasi bank masuk | Jadi perpindahan uang. Satu-satunya hal yang menggerakkan saldo. |
| Notifikasi bank datang dua kali | Digabung. Tetap satu transaksi. |
| Transfer Mandiri → BCA milikmu | Perpindahan uang sendiri. Bukan pengeluaran, bukan pendapatan. |
| Transfer ke BCA orang lain | Transaksi biasa. |
| Hanya satu sisi transfer terlihat | Ditandai `menunggu pasangan`. Uang tidak diciptakan, tidak dihilangkan. |
| Teman mengganti uang makan | Piutang berkurang. **Bukan** pemasukan baru. |
| Company membayar server langsung | Saldomu tidak berubah. |
| Kamu menalangi biaya company | Saldomu turun sampai reimburse benar-benar masuk. |
| Rencana top-up belum masuk | Belum jadi uang. Bisa ditandai `tidak diterima`. |
| Barang belum diketahui harganya | **Tidak** dianggap gratis. Muncul sebagai risiko yang belum terhitung. |
| Rencana makan vs makan beneran | Tidak dijumlahkan dua kali. Yang ditampilkan selisihnya. |

Setiap angka membawa labelnya: **Aktual**, **Rencana**, **Perkiraan**, atau
**Perlu verifikasi**. Saldo proyeksi tidak pernah disebut saldo bank.

---

## Menjalankan di komputer sendiri

```bash
npm install
npm run build
npm run migrate            # membuat database + katalog awal
node server/dist/index.js  # buka http://127.0.0.1:8787
```

Ingin melihat aplikasinya bekerja sebelum menyambungkan apa pun:

```bash
node server/dist/scripts/contoh.js          # isi contoh kasus nyata
node server/dist/scripts/contoh.js --hapus  # hapus lagi
```

Pengujian:

```bash
npm test     # 104 pengujian, termasuk seluruh kasus rawan hitung ganda
```

## Memasang di server

Lihat **[docs/06-pasang-tencent.md](docs/06-pasang-tencent.md)** — langkah demi langkah,
termasuk audit server Tencent Cloud yang sudah dipakai Hermes, pemisahan akses,
HTTPS, cadangan, dan pemulihan.

Ringkasnya:

```bash
bash deploy/scripts/audit-server.sh | tee audit-server.txt   # hanya membaca
bash deploy/scripts/pasang.sh                                # pasang
bash deploy/scripts/kesehatan.sh                             # periksa
```

---

## Dokumentasi

| Berkas | Isi |
|---|---|
| [docs/01-peta-sheet.md](docs/01-peta-sheet.md) | Peta tab Sheet → fitur aplikasi |
| [docs/02-audit-bukti.md](docs/02-audit-bukti.md) | Terverifikasi versus asumsi, per layanan |
| [docs/03-model-data.md](docs/03-model-data.md) | Model data dan mengapa bentuknya begitu |
| [docs/04-alur-telegram.md](docs/04-alur-telegram.md) | Perintah, tombol, dan percakapan bot |
| [docs/05-rancangan-layar.md](docs/05-rancangan-layar.md) | Rancangan sembilan layar web |
| [docs/06-pasang-tencent.md](docs/06-pasang-tencent.md) | **Langkah pemasangan ke server** |
| [docs/07-operasional.md](docs/07-operasional.md) | Cadangan, pemulihan, pembaruan, pemantauan |
| [docs/08-pertanyaan.md](docs/08-pertanyaan.md) | **Yang masih perlu kamu konfirmasi** |
| [docs/09-v2-audit-dan-rilis.md](docs/09-v2-audit-dan-rilis.md) | **v2: audit, migrasi, rilis, rollback, batasan** |
| [docs/10-telegram-first.md](docs/10-telegram-first.md) | **Telegram-first: notifikasi interaktif, kategori kustom, menu, rencana 7 hari, rollback** |

---

## Bentuk kode

```
server/src/
  domain/      aturan keuangan: ledger, proyeksi, periode, skenario, simulasi
  db/          skema SQLite + migrasi + katalog awal
  gmail/       OAuth, sinkronisasi, parser, penggabungan bukti
  telegram/    bot, pemahaman bahasa Indonesia, format pesan
  importer/    impor Sheet (CSV) dan mutasi bank
  api/         REST + sesi web
  notify/      pengingat dengan deduplikasi
  jobs/        tugas terjadwal
web/src/
  halaman/     sembilan layar
  components/  komponen dasar + grafik saldo
```

## Keamanan

- Izin Gmail minimum: `gmail.readonly`. Kata sandi Gmail tidak pernah diminta.
- Token Gmail disimpan terenkripsi (AES-256-GCM) dengan `BUNIH_SECRET_KEY`.
- Bot Telegram hanya menjawab satu Chat ID yang terdaftar.
- Nomor rekening penuh tidak disimpan maupun ditampilkan; hanya 4 digit terakhir.
- Log diredaksi: nomor panjang dan alamat email tidak ditulis utuh.
- Aplikasi ini **mencatat, mengingatkan, dan menganalisis**. Ia tidak melakukan
  transfer atau pembayaran, dan tidak pernah meminta OTP, PIN, atau kata sandi bank.
