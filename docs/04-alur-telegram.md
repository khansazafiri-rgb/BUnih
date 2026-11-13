# Alur Telegram

Bot hanya menjawab satu Chat ID yang terdaftar di `TELEGRAM_ALLOWED_CHAT_ID`.
Pesan dari akun lain diabaikan tanpa balasan.

Mode bawaan **long polling**: tidak butuh domain, sertifikat, atau port terbuka,
jadi paling sederhana dan paling tidak mengganggu layanan lain di server yang sama.
Mode webhook tersedia (`TELEGRAM_MODE=webhook`) kalau kamu ingin balasan lebih cepat
dan sudah punya HTTPS. Alasannya ditulis di [docs/06-pasang-tencent.md](06-pasang-tencent.md).

---

## Perintah

| Perintah | Isinya |
|---|---|
| `/hari` | Saldo terverifikasi per rekening, proyeksi akhir hari, makan aktual vs anggaran, tagihan hari ini, saldo terendah 14 hari, tagihan terdekat, dan jumlah hal yang perlu dijawab |
| `/minggu` | Pemasukan aktual dan rencana, makan, tagihan, belanja, biaya company, saldo akhir minggu, hari yang perlu perhatian |
| `/bulan` | Arus kas, biaya pribadi neto, transfer internal, tabungan, piutang, pengeluaran company, tagihan belum dibayar |
| `/5hari` | Posisi blok lima hari berjalan: rencana, aktual, selisih makan, sisa dana, status risiko |
| `/tagihan` | Jatuh tempo, nominal, penanggung, siapa yang membayar, kepastian, dana yang perlu disiapkan |
| `/anggaran` | Pemakaian versus batas, plus daftar asumsi yang sedang dipakai |
| `/tabungan` | Setoran, penarikan, neto, saldo BCA, dan penjelasan bila saldonya belum dapat diverifikasi |
| `/reimburse` | Sisa piutang per orang dan per company, serta yang sudah terlambat |
| `/belanja` | Tambah pembelian; langsung menampilkan dampaknya pada proyeksi |
| `/simulasi` | "Kalau aku beli barang RpX hari ini, bagaimana?" |
| `/skenario` | Bandingkan tanpa vs dengan Claude Pro pribadi |
| `/koreksi` | Daftar 10 transaksi terakhir, pilih satu, lalu ubah |
| `/bantuan` | Daftar kemampuan dengan contoh bahasa sehari-hari |

---

## Transaksi baru yang belum jelas

Pesan yang dikirim memuat: tanggal dan jam, nominal, rekening, merchant/penerima,
kategori tebakan, dan tautan bukti bila ada. Tombolnya:

```
[ Benar ]            [ Ganti kategori ]
[ Bagi biaya ]       [ Reimburse ]
[ Transfer sendiri ] [ Hadiah ]
[ Lainnya ]
```

| Tombol | Yang terjadi |
|---|---|
| **Benar** | Transaksi dikunci terkonfirmasi. |
| **Ganti kategori** | Muncul papan kategori. |
| **Bagi biaya** | Bot menanyakan pembagiannya; kamu boleh menjawab "aku 30rb, 3 teman" atau "berempat". |
| **Reimburse** | Jadi klaim reimburse company. Saldomu tetap turun sampai uangnya kembali. |
| **Transfer sendiri** | Jadi transfer internal / setoran tabungan, dan dicocokkan dengan sisi pasangannya. |
| **Hadiah** | Tetap biaya pribadimu, bukan piutang. |
| **Lainnya** | Talangan, company bayar langsung, setoran tabungan, reimburse. |

Transaksi rutin yang sangat yakin (cocok aturan merchant dengan persetujuan otomatis)
dikelompokkan sendiri dan hanya muncul di ringkasan harian. Merchant baru, nilai besar
(≥ Rp500.000 diprioritaskan), transfer baru, pembelian di luar rencana, dan klaim
reimburse selalu diminta keputusannya.

## Uang masuk yang mungkin pelunasan

Kalau ada piutang terbuka yang nominalnya mendekati, bot menawarkan:

```
Uang masuk Rp30.000. Ini pelunasan piutang dari Rizki?
[ Ya, dari Rizki (sisa Rp30.000) ]
[ Bukan, ini pemasukan biasa ]
[ Ini top-up ]
```

Memilih pelunasan akan mengurangi piutang — bukan menambah pemasukan.
Memilih top-up akan memasangkannya dengan rencana top-up terdekat dan menghitung
ulang proyeksi.

---

## Bahasa sehari-hari

Tidak perlu perintah. Yang dipahami, antara lain:

| Yang kamu tulis | Yang terjadi |
|---|---|
| "makan 25 ribu" | Dicatat sebagai pengeluaran kategori makan |
| "itu makan berempat, aku cuma bayar 30 ribu" | Transaksi terakhir dibagi: Rp30.000 pribadimu, Rp90.000 piutang |
| "server ini direimburse company" | Jadi klaim reimburse company |
| "company yang bayar" | Jadi biaya company langsung; saldomu tidak berubah |
| "ini hadiah" | Tetap biaya pribadimu |
| "nalangin dulu buat Rizki" | Uang keluar + piutang |
| "transfer 500 ribu ke rekening aku sendiri" | Transfer internal, bukan pengeluaran |
| "nabung 300 ribu ke BCA" | Setoran tabungan |
| "kalau aku beli hp 3 juta hari ini gimana?" | Simulasi dampak lengkap |
| "top up hari ini tidak masuk" | Rencana ditandai tidak diterima; proyeksi dihitung ulang |
| "siapa yang belum bayar?" | Ringkasan piutang |
| "tagihan apa yang dekat?" | Daftar jatuh tempo |

Nominal dipahami dalam bentuk sehari-hari: `30 ribu`, `25rb`, `1,5jt`, `Rp350.000`.
Jumlah orang dipahami dari `berempat`, `bertiga`, `3 teman`.

Bila bot tidak yakin, ia **bertanya**, tidak menebak.

## Uang tunai, foto, dan catatan

- Pencatatan tunai: tulis saja nominalnya; kalau tidak ada rekening yang cocok,
  transaksinya ditandai tunai.
- Foto kuitansi: disimpan sebagai bukti. Kalau keterangan fotonya memuat nominal,
  bot menampilkan hasil bacaannya lebih dulu untuk kamu konfirmasi sebelum menjadi
  transaksi final. Tanpa nominal, bot meminta angkanya dan menautkan fotonya ke
  transaksi yang kemudian kamu catat.

  Catatan jujur: pembacaan teks otomatis dari gambar (OCR) belum dipasang, jadi
  bot tidak akan berpura-pura membaca angka dari fotonya.

---

## Pengingat

| Jenis | Bawaan | Isi |
|---|---|---|
| `transaksi_baru` | langsung | Transaksi yang perlu dikategorikan |
| `ringkasan_harian` | harian | Posisi hari ini + saldo terendah 14 hari |
| `tagihan_mendekat` | harian | H-7, H-3, dan hari H |
| `pembayaran_gagal` | langsung | Tagihan berstatus gagal bayar |
| `topup_belum_diterima` | harian | Rencana top-up lewat tanggal yang belum dikonfirmasi |
| `saldo_di_bawah_cadangan` | langsung | Proyeksi menembus cadangan minimal atau defisit |
| `reimburse_terlambat` | mingguan | Piutang lewat perkiraan tanggal kembali |
| `langganan_tertagih_lagi` | langsung | Layanan dibatalkan tetapi masih tertagih |
| `pembelian_ganggu_tagihan` | langsung | Pembelian baru membuat tagihan AI/server berisiko |
| `sinkronisasi_gagal` | harian | Gmail gagal disinkronkan |

Tiap jenis bisa dimatikan atau diubah frekuensinya (langsung / harian / mingguan / mati)
di **Pengaturan → Notifikasi**.

**Tidak ada notifikasi ganda.** Setiap pengingat punya kunci deduplikasi yang dicatat
di `notification_log`; pengingat dengan kunci sama tidak dikirim dua kali. Tagihan yang
sama memakai kunci berbeda untuk H-7, H-3, dan hari H, sehingga tetap mengingatkan
tiga kali tanpa menjadi spam harian.
