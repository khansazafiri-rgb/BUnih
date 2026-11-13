# Rancangan sembilan layar

Prinsip tampilan: tenang, bersih, terbaca di ponsel, dan terasa seperti pusat kendali.
Angka besar untuk keputusan penting. Label `Aktual` / `Rencana` / `Perkiraan` /
`Perlu verifikasi` selalu terlihat di samping angkanya.

**Risiko tidak pernah disampaikan lewat warna saja.** Status selalu berupa
ikon + teks: `✔ AMAN`, `▲ RENDAH`, `■ DEFISIT`. Grafik pun menandai hari berisiko
dengan bentuk (segitiga untuk rendah, kotak untuk defisit), bukan warna saja, dan
seri pembanding digambar putus-putus supaya tetap terbaca saat dua garis berimpit.

Navigasi: bilah samping di layar lebar; di ponsel, lima tujuan utama di bawah
(Beranda, Transaksi, Anggaran, Tagihan, Lainnya) dengan bilah aksi cepat
**Tanya pembelian** dan **Catat / koreksi** tepat di atasnya.

Tabel lebar berubah menjadi kartu di bawah 720px — angka penting tidak pernah
tersembunyi di balik gulir horizontal.

---

## 1. Beranda

```
┌─────────────────────────────┬─────────────────────────────┐
│ DANA TERSEDIA TERVERIFIKASI │ CUKUP UNTUK TAGIHAN TERDEKAT│
│ Rp2.191.610     [Aktual]    │ Belum cukup                 │
│ diperbarui 12 November 2026 │ IDCloudHost  Rp410.700      │
│ • Mandiri ••4821  Rp491.610 │ 23 Okt — sudah lewat        │
│ • BCA ••7733    Rp1.700.000 │ penanggung company          │
│ ℹ Rp300.000 dalam perjalanan│ Dana 30 hari: Rp1.191.400   │
└─────────────────────────────┴─────────────────────────────┘

Hari ini
┌─────────────┬─────────────┬─────────────┐
│ POSISI HARI │ TOP-UP      │ REIMBURSE   │
│ Rp1.750.910 │ Rp350.000   │ Rp440.700   │
│ [Proyeksi]  │ [Rencana]   │ Teman   30rb│
│ ✔ AMAN      │ 15 Nov      │ Company 410k│
└─────────────┴─────────────┴─────────────┘

Proyeksi dan periode
┌─────────────────────────────┬─────────────────────────────┐
│ ── Tanpa Claude Pro pribadi │ PERIODE 10 NOV – 14 NOV     │
│    Rp1.690.910 terendah     │ ✔ AMAN                      │
│ ─ ─ Dengan Claude Pro       │ Rencana / aktual masuk      │
│    Rp1.320.910 terendah     │ Makan: Rp90.000 / Rp68.000  │
│ Cadangan minimal Rp100.000  │ Sisa dana Rp1.990.910       │
└─────────────────────────────┴─────────────────────────────┘

Yang menunggu kamu
┌─────────────────────────────┬─────────────────────────────┐
│ PERLU TINDAKAN              │ RISIKO                      │
│ 1 transfer menunggu pasangan│ Top-up 10 Nov belum         │
│ 8 asumsi belum terverifikasi│   dikonfirmasi   Rp350.000  │
│ 3 layanan perlu verifikasi  │ IDCloudHost terlambat …     │
└─────────────────────────────┴─────────────────────────────┘
```

Hierarki ini mengikuti urutan yang kamu minta: dana terverifikasi, tagihan terdekat,
posisi 5 hari, proyeksi dua skenario, lalu daftar yang perlu dijawab.

## 2. Arus Harian

Penyaring tanggal dan skenario, dengan kotak centang "tampilkan pembanding".
Grafik garis saldo penutup: satu sumbu nilai, garis cadangan minimal sebagai acuan
putus-putus, penanda hari ini, crosshair + tooltip saat disentuh.

Tiga kartu ringkas: saldo terendah (dengan dan tanpa perkiraan reimburse),
saldo akhir rentang (proyeksi dan realisasi), kebutuhan tambahan (agar tidak defisit
dan agar cadangan aman).

Lalu tabel harian. Ketuk **Rincian** pada satu hari untuk melihat setiap penyebab
perubahan saldo hari itu — tiap baris membawa label aktual/rencana, tingkat kepastian,
penanda terlambat, dan keterangan bila sesuatu tidak memengaruhi saldomu.

## 3. Periode 5 Hari

Satu kartu per blok: rencana, realisasi, selisih makan, sisa dana, status, dan daftar
hari yang rendah/defisit. Blok yang sedang berjalan diberi penanda.

Kalau `periode_mulai` belum diisi, halaman ini menampilkan keadaan kosong yang
menjelaskan sebabnya dan tombol menuju Anggaran — bukan tabel kosong.

## 4. Transaksi

Di atas: pertanyaan yang perlu dijawab, lengkap dengan tombol pilihannya — jadi
semua yang bisa dilakukan di Telegram juga bisa diselesaikan di web.

Penyaring: pencarian bebas, status, jenis, rekening.
Tabel: tanggal, keterangan, rekening, jenis, status, nominal.

Panel detail menampilkan: pembagian biaya, pasangan transfer, daftar bukti dengan
tautan buka di Gmail, riwayat koreksi, dan tombol tindakan (bagi biaya, reimburse
company, company bayar langsung, hadiah, talangan, setoran tabungan, transfer sendiri).

## 5. Anggaran & Simulasi

Kiri: asumsi yang sedang dipakai, masing-masing dengan label kepastian, tanggal
berlaku, dan catatannya. Kanan: formulir mengubah asumsi, dengan peringatan bahwa
versi lama tetap tersimpan.

Perbandingan skenario berdampingan: saldo terendah, saldo akhir, tanggal defisit,
tambahan yang dibutuhkan, total tagihan, biaya company, dan **asumsi yang membentuk
hasil itu** ditampilkan sebagai chip.

**Bolehkah aku beli ini?** — isi barang, harga (atau centang "harga belum diketahui"),
tanggal, jenis (pribadi / hadiah / talangan / company / bersama), bagian yang akan
kembali, dan apakah bisa ditunda. Hasilnya berupa putusan + kalimat konkret, misalnya:

> Kalau dibeli 12 November 2026, saldo terendah sebelum top-up 15 November 2026
> menjadi Rp250.000, di bawah batas Rp500.000 sebesar Rp250.000.

Ditambah tabel sebelum/sesudah, dampak pada tagihan terdekat dan piutang, daftar
hal yang belum pasti, dan saran.

## 6. Tagihan & Langganan

Tiga kartu ringkas: dana yang perlu disiapkan, jumlah tagihan terlambat, jumlah
tagihan terencana. Lalu daftar jatuh tempo dengan penanggung, pembayar, dan kepastian.

Daftar invoice menampilkan nominal mata uang asli **dan** rupiah aktual secara
terpisah, status, serta tautan buktinya.

Katalog layanan: satu kartu per layanan, bisa dibuka untuk mengubah nominal,
tanggal, siklus, penanggung, pembayar, dan status. Menyimpan akan membangun ulang
proyeksi.

Di bawahnya, **Layanan belum teridentifikasi**.

Peringatan "dibatalkan tetapi masih tertagih" muncul paling atas kalau ada.

## 7. Reimburse & Talangan

Tiga angka besar: total belum kembali, dari teman, dari company.
Ringkasan per orang, lalu rincian: nominal awal, sudah kembali, sisa, tanggal,
umur, status, bukti, dan tombol tandai diklaim / hapuskan.

## 8. Tabungan

Saldo rekening tabungan (atau penjelasan mengapa belum dapat diverifikasi),
setoran dan penarikan, neto, pencapaian terhadap target bulanan, daftar transfer
yang masih menunggu pasangan, dan riwayat lengkapnya.

## 9. Pengaturan

Rekening (konfirmasi 4 digit, catat saldo terkonfirmasi), koneksi Gmail (langkah
penyambungan, status, sinkronisasi historis, cabut akses), bot Telegram, impor Sheet
dengan pemetaan kolom, impor mutasi bank, notifikasi per jenis, keamanan dan ekspor,
serta tema.

---

## Keadaan khusus

| Keadaan | Yang ditampilkan |
|---|---|
| Sedang memuat | Garis berdenyut, dengan pengumuman untuk pembaca layar |
| Gagal memuat | Pesan jelas + tombol coba lagi |
| Kosong | Ikon, judul, penjelasan, dan tombol langkah berikutnya |
| Data belum lengkap | Catatan bergaris tepi, bukan angka diam-diam nol |
| Saldo belum terverifikasi | Tulisan "Belum dapat dipastikan" + alasannya |
| Sinkronisasi gagal | Pesan kesalahan di Pengaturan + pengingat Telegram |
