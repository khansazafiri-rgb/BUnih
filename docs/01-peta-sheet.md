# Peta Sheet → fitur aplikasi

## Status pembacaan Sheet

**Sheet sumber belum dapat dibaca langsung.** Tautan
`docs.google.com/spreadsheets/d/14E9VN622Va6AOCNEuaQRkzgw7I45Q1AaByxB62OHYRg`
menolak akses dari akun Google yang tersambung ke sesi pembuatan aplikasi ini
(`medcoelnotifikasi@gmail.com` — balasan `401`, dan pencarian Drive tidak
menemukan spreadsheet apa pun).

Akibatnya **rumus, relasi antar sel, dan angka di dalam Sheet belum diverifikasi
satu per satu.** Peta di bawah dibangun dari uraian tab yang kamu tuliskan, dan
importer dibuat berbasis pemetaan kolom supaya Sheet yang sebenarnya dapat
ditelan tanpa mengubah kode.

Dua cara membereskannya (salah satu cukup), ada di
[docs/08-pertanyaan.md](08-pertanyaan.md) nomor 1:

1. Bagikan Sheet (akses lihat) ke `medcoelnotifikasi@gmail.com`, atau
2. Ekspor tiap tab ke CSV lalu unggah di **Pengaturan → Impor awal dari Google Sheet**.

Sheet aslimu tidak pernah diubah oleh aplikasi ini. Importer hanya membaca salinan CSV.

---

## RINGKASAN → Beranda

| Di Sheet | Di aplikasi |
|---|---|
| Total biaya, pemasukan, belanja, tagihan | Kartu di Beranda + `GET /api/beranda` |
| Saldo akhir proyeksi | `ringkasan.saldo_akhir_minor` |
| Saldo terendah proyeksi | `ringkasan.saldo_terendah_minor` + tanggalnya |
| Risiko | Daftar `risiko[]` dengan jenis dan nominal |

Perbedaan penting: Beranda menampilkan **dua angka yang berbeda dan berlabel**.

- **Realisasi** — dari transaksi yang benar-benar terbukti (ada `cash_event`).
- **Proyeksi** — realisasi ditambah rencana (anggaran makan, top-up, tagihan).

Kartu "Dana tersedia terverifikasi" hanya menjumlahkan rekening yang punya titik
tambat rekonsiliasi. Tanpa itu, angkanya ditulis "Belum dapat dipastikan" — bukan nol,
bukan tebakan.

## PENGATURAN → tabel `assumption` (berversi)

Setiap asumsi disimpan dengan masa berlaku: `effective_from` … `effective_to`.
Mengubah anggaran makan hari ini **tidak** mengubah laporan bulan lalu, karena
laporan historis membaca asumsi yang berlaku saat itu.

| Kunci | Nilai awal dari Sheet | Status |
|---|---|---|
| `anggaran_makan_harian` | Rp30.000 | asumsi Sheet |
| `cadangan_minimal` | Rp100.000 | asumsi Sheet |
| `topup_nominal` | Rp350.000 | asumsi Sheet |
| `topup_interval_hari` | 5 | asumsi Sheet |
| `periode_panjang_hari` | 5 | asumsi Sheet |
| `saldo_awal_sheet` | Rp200.000 | asumsi Sheet, **bukan** saldo bank |
| `periode_mulai` | — | **belum ada, wajib kamu isi** |
| `reimburse_lag_hari` | 14 | perkiraan |
| `target_tabungan_bulanan` | 0 | belum ditentukan |

`saldo_awal_sheet` sengaja tidak dipakai sebagai saldo bank. Saldo baru diklaim
setelah ada rekonsiliasi (impor mutasi atau input manual di Pengaturan).

Tanpa `periode_mulai`, blok lima hari dan rencana top-up **tidak dibuat** dan
aplikasi mengatakannya terus terang, bukan menebak tanggal.

## PERIODE 5 HARI → halaman Periode

Blok terbentuk otomatis dari `periode_mulai` + `periode_panjang_hari`.
Tiap blok menampilkan: tanggal mulai/akhir, pemasukan terencana, pemasukan aktual,
makan rencana vs aktual beserta selisihnya, belanja, tagihan, biaya company,
saldo akhir, sisa dana, status risiko, dan hari-hari yang `RENDAH`/`DEFISIT`.

Panjang blok dapat diubah; rekapnya ikut berubah tanpa mengubah kode.

## ARUS HARIAN → halaman Arus Harian

Satu baris per hari: saldo pembuka, pemasukan (aktual dan rencana dipisah),
pengeluaran rutin, belanja tambahan, tagihan, transfer antar rekening, reimburse,
saldo penutup, dan status `AMAN` / `RENDAH` / `DEFISIT`.

Skenario "tanpa Claude pribadi" dan "dengan Claude pribadi" tersedia sebagai pilihan
dan dapat ditumpuk di grafik yang sama (garis kedua digambar putus-putus supaya tetap
terbaca saat dua garis berimpit).

Perlakuan makan — ini yang paling sering salah di spreadsheet:

| Hari | Yang dihitung |
|---|---|
| Masa lalu | Realisasi saja. Rencana tidak ditambahkan. |
| Hari ini | Realisasi + **sisa** anggaran (`maks(0, anggaran − realisasi)`) |
| Masa depan | Anggaran penuh |

Jadi makan Rp18.000 hari ini dengan anggaran Rp30.000 menghasilkan rencana Rp12.000 —
bukan Rp30.000 lagi di atas Rp18.000.

Ketuk satu hari untuk melihat daftar penyebab perubahan saldonya, lengkap dengan
label aktual/rencana dan tingkat kepastian masing-masing.

## TOPUP → tabel `topup_plan`

Pasangan rencana dan aktual dipertahankan.

| Status | Arti | Pengaruh pada proyeksi |
|---|---|---|
| `rencana` | Belum ada bukti masuk | Dihitung hanya untuk tanggal ≥ hari ini |
| `diterima` | Terbukti masuk | Dipakai nilai aktualnya; rencana tidak dihitung lagi |
| `sebagian` | Masuk dengan jumlah berbeda | Nilai aktual dipakai untuk masa lalu |
| `tidak_diterima` | Dikonfirmasi tidak masuk | Hilang dari proyeksi seketika |

Rencana yang tanggalnya sudah lewat tetapi belum dikonfirmasi **tidak** dihitung
sebagai uang; ia muncul sebagai risiko `topup_belum_dikonfirmasi` dan bot menanyakannya.

## BELANJA → tabel `purchase`

Menyimpan nama, jumlah, harga satuan, total, tanggal, kategori, pemilik barang,
penanggung akhir, dan status pembayaran. Terencana maupun mendadak.

Barang tanpa harga disimpan dengan `total_minor = NULL` dan `price_unknown = 1`.
Ia **tidak** dihitung nol: ia muncul di `risiko_belum_terhitung` pada hari itu dan
di daftar risiko proyeksi.

## LANGGANAN → tabel `service` + `invoice`

Tab LANGGANAN menjadi **katalog awal**, bukan kebenaran akhir. Tiap layanan membawa:

- nominal + tingkat kepastiannya (`terverifikasi` / `perkiraan` / `asumsi_sheet`)
- tanggal tagihan + tingkat kepastiannya
- penanggung akhir (pribadi / company) **dan** siapa yang membayar lebih dulu
- status (aktif, opsional skenario, sudah dibayar, akan diperpanjang, dibatalkan,
  tidak dilanjutkan, perlu verifikasi, kandidat)
- tag skenario, untuk layanan yang hanya aktif di skenario tertentu

Katalog **tidak pernah memotong saldo**. Ia hanya menghasilkan kewajiban
(`obligation`) dan proyeksi. Uang keluar baru tercatat saat ada `cash_event`.

Satu layanan boleh punya penanggung, periode, dan status berbeda dari layanan lain
dengan vendor sama — karena itu Claude Pro pribadi dan Claude Pro company adalah
dua baris terpisah yang tidak pernah digabung otomatis.

Rincian per layanan ada di [docs/02-audit-bukti.md](02-audit-bukti.md).

## Impor ulang yang aman

Setiap baris impor punya kunci alami (nama layanan, tanggal top-up, nama+tanggal
belanja). Menjalankan impor dua kali **memperbarui**, tidak menduplikasi.
Nominal yang sudah kamu tandai `terverifikasi` tidak akan ditimpa oleh asumsi Sheet.

Sebelum mengimpor, halaman Pengaturan menampilkan:
pemetaan kolom usulan (bisa kamu ubah), contoh lima baris pertama, kolom yang tidak
terpakai, dan daftar data yang tidak jelas. Ada tombol **uji coba** yang menghitung
hasilnya tanpa menyimpan apa pun.
