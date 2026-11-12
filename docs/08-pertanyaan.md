# Yang masih perlu kamu konfirmasi

Daftar pendek, diurutkan menurut seberapa menghambat. Semuanya dibuat begini karena
menebak akan menghasilkan angka yang terlihat pasti padahal tidak.

Semua nilai yang belum dikonfirmasi sudah ada di aplikasi dengan label
**Asumsi Sheet** atau **Perlu verifikasi**, jadi aplikasinya tetap bisa dipakai
sambil menunggu.

---

## Menghambat — aplikasi tidak lengkap tanpa ini

### 1. Akses ke Google Sheet

Sheet sumber tidak dapat kubaca: akun Google yang tersambung ke sesi pembuatan
aplikasi ini (`medcoelnotifikasi@gmail.com`) ditolak dengan `401`, dan Drive-nya
tidak memuat spreadsheet apa pun. Jadi **rumus dan angka di dalamnya belum
diverifikasi satu per satu**.

Salah satu dari ini cukup:

- **a.** Bagikan Sheet (akses lihat saja) ke `medcoelnotifikasi@gmail.com`, atau
- **b.** Ekspor tiap tab ke CSV (File → Download → Comma-separated values) lalu
  unggah di **Pengaturan → Impor awal dari Google Sheet**.

Pilihan (b) bisa kamu lakukan sendiri sekarang; importer sudah siap dengan pemetaan
kolom yang dapat kamu periksa dan ubah sebelum menyimpan.

### 2. Tanggal awal periode

Satu-satunya nilai yang benar-benar hilang. Tanpa ini, blok lima hari dan rencana
top-up tidak dibuat sama sekali — aplikasi mengatakannya terus terang alih-alih
menebak tanggal.

> **Tanggal berapa blok lima hari pertamamu dimulai?**

Isi di **Anggaran → Ubah asumsi → Tanggal awal periode**.

### 3. Empat digit terakhir rekening

Pencocokan email tidak bisa membedakan rekeningmu dari rekening orang lain sebelum
ini terisi. Akibat nyatanya: transfer ke BCA milikmu dan transfer ke BCA orang lain
tidak dapat dibedakan otomatis.

> **Empat digit terakhir Mandiri Livin' dan BCA milikmu?**

Isi di **Pengaturan → Rekening**. Nomor penuh tidak disimpan.

### 4. Saldo terkonfirmasi hari ini

Saldo awal Rp200.000 dari Sheet adalah asumsi, bukan saldo bank, jadi tidak dipakai
sebagai titik tambat. Sampai ada rekonsiliasi, aplikasi menolak menyebut angka apa
pun sebagai saldo.

> **Berapa saldo Mandiri Livin' dan BCA hari ini?**

Isi di **Pengaturan → Rekening**, atau lebih baik: impor mutasi bank (baris saldo
terakhir otomatis menjadi titik tambat).

---

## Dibutuhkan untuk menyambungkan akun

### 5. Kredensial Google OAuth

`GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` dari Google Cloud Console.
Langkah lengkapnya di [docs/06-pasang-tencent.md](06-pasang-tencent.md) bagian 4a.
Akses Gmail dari percakapan AI lain tidak otomatis berlaku di sini — aplikasi ini
memakai alur OAuth-nya sendiri.

### 6. Token bot Telegram dan Chat ID

Token dari @BotFather. Chat ID akan diberitahukan sendiri oleh bot saat kamu mengirim
`/mulai` pertama kali.

### 7. Domain

Untuk HTTPS dan redirect OAuth. Bisa ditunda; sementara itu aplikasi dapat diakses
lewat terowongan SSH.

### 8. Hasil audit server Tencent

Aku tidak punya akses ke server Tencent-mu, jadi spesifikasi, pemakaian CPU/RAM/disk,
dan cara Hermes berjalan belum dapat kuperiksa sendiri.

```bash
bash deploy/scripts/audit-server.sh | tee audit-server.txt
```

Skrip itu hanya membaca. Kirimkan hasilnya kalau mau dibaca bersama.

---

## Keputusan keuangan yang hanya kamu yang tahu

### 9. IDCloudHost: siapa yang membayar lebih dulu?

Penanggung akhirnya company, tetapi dampaknya pada saldomu sangat berbeda:

- **Company bayar langsung** → saldomu tidak berubah sama sekali.
- **Kamu menalangi** → saldomu turun Rp410.700 sampai reimburse masuk.

Saat ini pembayarnya `belum jelas`, jadi aplikasi memilih yang konservatif
(menganggap kamu yang membayar) dan menandainya sebagai risiko.

> **Untuk tagihan 23 November 2026, dan untuk bulan-bulan berikutnya: siapa yang
> membayar lebih dulu?**

### 10. ChatGPT Plus: status setelah gagal bayar September 2026

Rp349.000 dan tanggal 17 adalah perkiraan Sheet. Ada laporan gagal bayar September.

> **Apakah langganan ini masih berjalan? Kalau ya, berapa nominal dan tanggal
> tagihan yang sebenarnya?**

Setelah Gmail tersambung dan sinkronisasi historis dijalankan, jawabannya mungkin
muncul sendiri dari kuitansi terbaru.

### 11. Claude Pro: pribadi, company, atau keduanya?

Keduanya ada di katalog sebagai layanan terpisah dan tidak akan digabung otomatis.
Tagihan dari Anthropic sengaja **tidak** dipetakan otomatis ke salah satunya; bot
akan bertanya setiap kali menemukan tagihan Anthropic.

> **Claude Pro pribadi: jadi diaktifkan 27 November 2026, atau masih dipertimbangkan?**
> **Claude Pro company: berapa nominalnya dan siapa yang membayar?**

### 12. Tencent Cloud dan Google AI Pro: periode manfaat

Keduanya tercatat sudah dibayar. Supaya periode yang sudah dibayar tidak ditagih
ulang dalam proyeksi, dan supaya dana cadangan perpanjangan muncul pada waktu yang
tepat:

> **Tencent Cloud: periode mana yang sudah dibayar, berapa biayanya, kapan
> perpanjangan berikutnya?**
> **Google AI Pro 5 TB: sampai kapan periode yang sudah dibayar?**

### 13. Tanggal pembatalan Cloudflare, Canva, ElevenLabs

Peringatan "dibatalkan tetapi masih tertagih" baru bisa bekerja setelah tanggal
pembatalannya diketahui.

> **Kapan masing-masing dihentikan?**

### 14. Biznet Gio: pola berulangnya

Satu pembayaran Rp198.690 pada 21 Oktober 2026 bukan bukti bahwa nominal dan
tanggalnya berulang tiap bulan.

> **Apakah tagihannya tetap Rp198.690 tiap bulan, dan selalu tanggal 21?**

### 15. Nilai yang masih asumsi Sheet

Semuanya sudah bisa dipakai, tetapi berlabel **Asumsi Sheet**:

| Nilai | Dari Sheet |
|---|---|
| Anggaran makan harian | Rp30.000 |
| Cadangan minimal | Rp100.000 |
| Nominal top-up | Rp350.000 |
| Interval top-up | 5 hari |
| Panjang periode | 5 hari |

> **Mana yang sudah benar, dan mana yang perlu diubah?**

Dua lagi yang belum ada nilainya: **target tabungan per bulan** (sekarang 0) dan
**perkiraan jeda reimburse** (sekarang 14 hari, dipakai hanya untuk proyeksi).

---

## Yang sudah diputuskan tanpa menunggumu

Supaya jelas apa yang kuputuskan sendiri, dan kenapa:

| Keputusan | Alasan |
|---|---|
| Rupiah disimpan sebagai bilangan bulat | Tidak ada pembulatan yang menyelinap |
| Transfer internal netral terhadap total uangmu | Memindahkan uang sendiri bukan untung atau rugi |
| Pembayar `belum_jelas` dianggap memotong saldomu | Konservatif: lebih baik memperingatkan daripada terlanjur kurang |
| Tagihan terlambat dibawa ke hari ini | Supaya proyeksi masa lalu tetap sama dengan realisasi, tetapi kewajibannya tidak hilang |
| Perkiraan reimburse ikut dihitung, tetapi ada angka tandingannya | "Saldo terendah tanpa reimburse" selalu ditampilkan berdampingan |
| Telegram memakai long polling | Tidak butuh domain atau port terbuka; paling tidak mengganggu Hermes |
| Sinkronisasi Gmail berkala, bukan Pub/Sub | Jeda 10 menit tidak mengubah keputusan apa pun; kerumitan Pub/Sub nyata |
| Katalog layanan tidak memotong saldo | Uang keluar hanya dari pembayaran yang terbukti |
| Seed tidak membuat transaksi apa pun | Supaya tidak ada rupiah palsu yang masuk ke saldo |

Kalau ada yang menurutmu keliru, semuanya dapat diubah dari Pengaturan tanpa
menyentuh kode.
