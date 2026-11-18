# BUnih berdiri sendiri (tanpa Google Sheet)

Dokumen ini menjelaskan tiga masalah yang dilaporkan dan apa yang diubah.

## Masalah dan penyebabnya

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| Web menampilkan uang negatif (belasan juta) | Saldo dihitung dari saldo terkonfirmasi + semua transaksi yang **terlihat**. Email bank hanya memberi tahu uang keluar, jadi uang masuk tidak pernah terhitung. Sisa rencana dari Sheet lama (saldo awal, top-up, belanja) juga masih hidup di database. | Saldo negatif sekarang ditandai **tidak wajar** dan dijelaskan di Dashboard, Rekening, dan Telegram, bukan disajikan seperti fakta. Data Sheet dilepas (lihat bawah). |
| IDCloudHost tercatat 3 kali padahal bayar sekali | Satu pembayaran terlihat dari beberapa email (invoice, kuitansi, "terima kasih") dan notifikasi bank. Kuitansi kedua dan ketiga tidak mengenali pembayaran sementara dari kuitansi pertama, sehingga membuat transaksi baru. Tagihan tanpa nomor invoice juga dibuat berulang. | Kuitansi kini dicocokkan dengan pembayaran sementara sebelumnya; tagihan tanpa nomor yang sama (layanan + nominal + tanggal berdekatan) digabung. Data yang sudah terlanjur ganda digabung otomatis. |
| Email "Summary of failures for Google Apps Script" berulang | Itu **skrip di akun Google-mu**, bukan bagian BUnih (`gabungkanSheetsOtomatis`, pemicu berbasis waktu, gagal karena tidak punya izin ke dokumen). | Lihat "Menghentikan email Apps Script" di bawah. Ini harus dilakukan di akun Google. |

## Yang berubah di BUnih

- Seed tidak lagi menganggap database lama sebagai "warisan Sheet" (itu yang menghidupkan kembali
  rencana Sheet tiap aplikasi dinyalakan).
- Proyeksi tidak lagi memakai `saldo_awal_sheet`. Tanpa saldo yang kamu konfirmasi, awalnya nol dan diberi label.
- Impor Google Sheet dihapus dari web dan API (impor mutasi bank tetap ada).
- Saat start, **sekali per database**, BUnih:
  1. menyalin database ke `<BUNIH_DATA_DIR>/cadangan/sebelum-mandiri-<waktu>.sqlite`,
  2. menghapus data perencanaan dari Sheet yang tidak punya bukti nyata: asumsi bersumber `sheet`,
     rencana top-up/belanja hasil impor, tagihan seed tanpa bukti, dan layanan katalog yang tidak pernah
     punya transaksi atau bukti email,
  3. menggabungkan pembayaran langganan ganda dari Gmail (layanan + nominal sama dalam 7 hari).

Tidak disentuh: transaksi yang kamu catat, transaksi bank, rekening, saldo terkonfirmasi, kategori,
anggaran, tujuan, bukti email. Dua transaksi dengan nomor referensi bank berbeda tidak pernah digabung,
dan catatan manual/Telegram tidak pernah digabung otomatis.

## Membatalkan

```bash
# hentikan aplikasi, lalu
cp /var/lib/bunih/cadangan/sebelum-mandiri-<waktu>.sqlite /var/lib/bunih/bunih.sqlite
# dan lewati pembersihan di start berikutnya
echo 'BUNIH_PEMBERSIHAN_OTOMATIS=false' >> .env
```

## Supaya saldo benar

1. Konfirmasi saldo hari ini (Telegram: `/rekening` → Konfirmasi saldo, atau web → Pengaturan).
2. Catat uang masuk: di Telegram cukup ketik `gaji 3jt` atau `terima 500rb dari ibu`.

Setelah itu BUnih menghitung dari angka yang benar. Selama pemasukan tidak dicatat, saldo hasil hitung
akan selalu lebih rendah dari saldo bank.

## Menghentikan email Apps Script

Buka [script.google.com](https://script.google.com) → proyek **Untitled project** → ikon jam
(**Pemicu / Triggers**) → hapus pemicu `gabungkanSheetsOtomatis`. BUnih tidak memakainya.
Bila ingin tetap memakai skripnya: jalankan manual sekali dan setujui izin akses ke dokumennya,
atau minta pemilik dokumen memberi akses.
