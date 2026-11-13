# Audit bukti: terverifikasi versus asumsi

## Status audit Gmail

**Belum ada email yang dibaca.** Sesi pembuatan aplikasi ini tidak punya akses ke
kotak masuk Gmail-mu, dan memang tidak seharusnya punya: aplikasi memakai alur
OAuth sendiri dengan izin `gmail.readonly` yang kamu setujui sekali di halaman
Pengaturan.

Jadi tabel di bawah menyatakan, per layanan, **apa yang masih berupa pernyataan
atau asumsi** dan **bukti apa yang akan membuatnya terverifikasi**. Setelah Gmail
tersambung dan sinkronisasi historis dijalankan, kolom "status sekarang" akan
berubah sendiri.

Semua baris ini sudah ada di katalog aplikasi dengan status dan catatannya.

---

## Katalog awal

| Layanan | Nominal | Tanggal | Penanggung | Status sekarang | Yang membuatnya terverifikasi |
|---|---|---|---|---|---|
| ChatGPT Plus (pribadi) | Rp349.000 | tanggal 17 | pribadi | **perlu verifikasi** | Kuitansi OpenAI/Stripe terbaru. Ada laporan gagal bayar September 2026 — status terbarunya harus dicari lebih dulu. |
| Biznet Gio (pribadi) | Rp198.690 | 21 Okt 2026 | pribadi | **perlu verifikasi** | Satu pembayaran bukan bukti pola. Butuh ≥ 2 kuitansi untuk memastikan nominal dan tanggal berulang. |
| Claude Pro (pribadi) | Rp370.000 | mulai 27 Nov 2026 | pribadi | **opsional skenario** | Konfirmasi aktivasi + tagihan pertama. Sampai itu ada, hanya muncul di skenario "dengan Claude Pro pribadi". |
| IDCloudHost VPS | Rp410.700 | 23 tiap bulan | **company** | aktif, **pembayar belum jelas** | Untuk SETIAP pembayaran: company bayar langsung, atau kamu menalangi lalu direimburse. Dua hal ini berbeda dampaknya pada saldomu. |
| Claude Pro (company) | belum diketahui | belum diketahui | company | **perlu verifikasi** | Nominal dan status terbaru. Tidak akan dicampur dengan Claude Pro pribadi. |
| Google AI Pro 5 TB | belum diketahui | belum diketahui | pribadi | **sudah dibayar periode ini** | Periode manfaat dan tanggal perpanjangan. Periode yang sudah dibayar tidak akan ditagih ulang. |
| Tencent Cloud (Hermes) | belum diketahui | tahunan | pribadi | **sudah dibayar periode ini** | Periode, biaya, tanggal perpanjangan. Pembayaran tahunan yang sudah lewat tidak memotong saldo bulanan; dana cadangan perpanjangan ditampilkan sebagai rencana terpisah. |
| Cloudflare Pro | riwayat disimpan | — | pribadi | **dibatalkan** | Tanggal pembatalan. Setelah itu, pembayaran apa pun memicu peringatan. |
| Canva Pro | riwayat disimpan | — | pribadi | **tidak dilanjutkan** | Tanggal berhenti. |
| ElevenLabs Starter | riwayat disimpan | — | pribadi | **tidak dilanjutkan** | Tanggal berhenti. |
| OpenRouter Credits | sesuai pemakaian | — | pribadi | aktif | Tidak membuat tagihan bulanan tetap. Hanya dicatat saat pembelian kredit benar-benar terjadi. |

### Invoice konkret yang sudah ada di sistem

| Layanan | Jatuh tempo | Nominal | Status | Catatan |
|---|---|---|---|---|
| IDCloudHost VPS | 23 Okt 2026 | Rp410.700 | perlu verifikasi | Dinyatakan lunas, tetapi bukti dan pembayarnya belum ditautkan. |
| IDCloudHost VPS | 23 Nov 2026 | Rp410.700 | jatuh tempo | Pembayar belum ditentukan. |
| Biznet Gio | 21 Okt 2026 | Rp198.690 | perlu verifikasi | Perlu ditautkan ke kuitansi agar menjadi lunas terkonfirmasi. |

**Tidak ada satu pun transaksi kas yang dibuat dari katalog ini.** Katalog hanya
membuat kewajiban. Karena itu saldo awal aplikasi kosong sampai kamu melakukan
rekonsiliasi atau mengimpor mutasi — itu disengaja.

---

## Daftar ini tidak dianggap lengkap

Halaman **Tagihan → Layanan belum teridentifikasi** mengumpulkan kandidat dari bukti:

- pengeluaran berulang ke merchant yang sama yang belum terhubung ke layanan mana pun
  (nominal khas dan rentang tanggalnya ditampilkan);
- email invoice atau kuitansi yang tidak cocok dengan vendor mana pun di katalog.

Kandidat tetap kandidat. Aturan berulang baru dibuat setelah kamu mengonfirmasi.

---

## Cara parser menilai sebuah email

1. **Identitas pengirim diperiksa lebih dulu**, bukan subjeknya. Setiap parser punya
   daftar domain pengirim yang diterima.
2. **Email promosi ditolak.** Penilaiannya memakai label Gmail, header surat massal,
   dan kata khas promosi. Tetapi tanda transaksi yang kuat (≥ 2 penanda *dan* ada
   nominal) mengalahkan tanda promosi, karena kuitansi asli sering juga membawa
   header berlangganan.
3. **Jenis dokumen ditentukan dengan urutan tetap**: gagal bayar → pembatalan →
   refund → kuitansi → perpanjangan → invoice. Jadi "your subscription will renew"
   tidak pernah salah dibaca sebagai kuitansi.
4. **Invoice tidak berarti sudah dibayar.** Statusnya `tagihan_baru`.
5. **Setiap hasil membawa tingkat keyakinan.** Di bawah 0,8 transaksinya ditandai
   `perlu_verifikasi` dan bot menanyakannya, bukan diam-diam dianggap benar.
6. **Nominal dan kurs tidak pernah dikarang.** Nominal mata uang asing disimpan apa
   adanya; rupiah aktual hanya diisi kalau ada bukti pendebitannya.

### Status tagihan mengikuti urutan peristiwa

Setiap perubahan dicatat di `invoice_status_event` dengan waktu kejadiannya.
Status akhir adalah peristiwa dengan **waktu kejadian terbaru**, bukan yang terakhir
masuk ke sistem. Jadi: gagal bayar 17 September, lalu kuitansi 19 September →
status akhir **lunas**, walaupun kuitansinya baru tersinkron belakangan.

### Satu pembayaran, banyak bukti

Kunci deduplikasi sengaja **tidak memuat sumber data**:

- ada nomor referensi → `ref:<nomor>:<nominal>`
- tidak ada → `tx:<rekening>:<tanggal>:<arah>:<nominal>:<merchant>`

Jadi notifikasi bank, kuitansi vendor, dan baris mutasi CSV untuk pembayaran yang
sama akan runtuh menjadi satu `cash_event` dengan beberapa bukti tertaut.

Nomor referensi yang **berbeda** tetap menghasilkan dua transaksi — dua pembelian
serupa di hari yang sama tidak akan salah digabung.

### Kuitansi yang datang tanpa notifikasi bank

Uangnya memang sudah keluar, tetapi rekening pendebitannya belum diketahui.
Sistem mencatat pembayaran dengan `account_id = NULL` dan status `perlu_verifikasi`,
sehingga **tidak memotong saldo rekening mana pun**, lalu bertanya lewat Telegram:
"Rekening mana yang terdebit?"

Ketika notifikasi banknya menyusul, ia **melengkapi** pembayaran itu
(mengisi rekening dan nominal rupiah aktualnya) alih-alih membuat transaksi baru.

### Gmail tidak cukup untuk saldo

Gmail mungkin tidak memuat semua mutasi. Karena itu saldo **hanya** diklaim bila ada
titik tambat rekonsiliasi: impor mutasi CSV/PDF, atau input saldo terkonfirmasi.
Tanpa itu, saldo rekening bernilai `null` dan antarmuka menjelaskan alasannya.

Halaman Pengaturan menampilkan kapan tiap rekening terakhir direkonsiliasi dan
berapa umurnya.
