# Model data

Satu kalimat yang menjelaskan seluruh skema:

> **`cash_event` adalah satu-satunya hal yang menggerakkan uang. Semua yang lain
> menjelaskan, merencanakan, atau membuktikan.**

```
  bukti (evidence)                  rencana (obligation, topup_plan, purchase)
        |                                        |
        | menautkan                              | direalisasikan menjadi
        v                                        v
  +------------------------------------------------------+
  |                    cash_event                         |   <- uang bergerak
  |          satu perpindahan uang yang nyata             |
  +------------------------------------------------------+
        |
        | dipecah tanpa sisa menjadi
        v
   allocation[]  -- jumlahnya WAJIB sama dengan nominal induk
        |
        +--> biaya_pribadi            -> biaya pribadi neto
        +--> piutang_teman/company    -> receivable
        +--> biaya_company_langsung   -> biaya company, tidak menyentuh saldoku
        +--> transfer_internal/tabungan -> netral terhadap total uangku
        +--> pelunasan_piutang        -> mengurangi receivable, BUKAN pemasukan
        +--> pemasukan / refund / kredit_layanan / penyesuaian
```

## Mengapa pakai alokasi

Satu transaksi bisa berarti beberapa hal sekaligus. Makan Rp120.000 berempat adalah
satu kali uang keluar, tetapi tiga maknanya:

| Alokasi | Nominal | Muncul di laporan sebagai |
|---|---|---|
| `biaya_pribadi` | Rp30.000 | pengeluaran pribadiku |
| `piutang_teman` × 3 | Rp90.000 | piutang |
| | **Rp120.000** | arus kas keluar |

Jumlah alokasi diperiksa setiap kali ditulis. Jika tidak sama persis dengan nominal
induknya, penulisan ditolak dengan pesan yang menjelaskan selisihnya — tidak ada
rupiah yang bisa hilang atau terhitung dua kali tanpa ketahuan.

## Tabel

### Uang yang benar-benar bergerak

| Tabel | Isi |
|---|---|
| `cash_event` | Satu perpindahan uang. Punya arah, nominal, rekening, jenis, status, sumber, dan kunci deduplikasi unik. |
| `allocation` | Pemecahan makna sebuah `cash_event`. |
| `account` | Rekening. Hanya nama + 4 digit terakhir; nomor penuh tidak disimpan. |
| `reconciliation` | Titik tambat saldo. **Tanpa ini saldo tidak diklaim.** |

Saldo rekening dihitung: `saldo titik tambat + semua cash_event sesudahnya`.
Tidak ada kolom saldo yang disimpan, jadi saldo tidak mungkin melenceng dari
transaksinya.

### Bukti

| Tabel | Isi |
|---|---|
| `evidence` | Email, foto kuitansi, baris mutasi, atau catatan manual. Unik menurut `(sumber, hash isi)`. |
| `cash_event_evidence` | Banyak bukti untuk satu transaksi, masing-masing dengan perannya. |
| `invoice_evidence` | Bukti yang menempel pada tagihan. |

### Kewajiban dan rencana

| Tabel | Isi |
|---|---|
| `service` | Katalog langganan. Membawa tingkat kepastian nominal dan tanggalnya. |
| `invoice` | Tagihan konkret dengan nomor, periode, jatuh tempo, dan status. |
| `invoice_status_event` | Riwayat status berurutan waktu kejadian. |
| `obligation` | Rencana pengeluaran yang dihasilkan dari layanan/tagihan/belanja. Idempoten lewat `generation_key`. |
| `topup_plan` | Pasangan rencana dan aktual pemasukan. |
| `purchase` | Belanja terencana maupun mendadak, termasuk yang harganya belum diketahui. |

`obligation` tidak pernah memotong saldo. Ia hanya dibaca mesin proyeksi, dan
dilewati begitu tagihannya punya `cash_event` tertaut.

### Piutang

| Tabel | Isi |
|---|---|
| `receivable` | Uang yang harus kembali: dari teman atau company. |
| `receivable_settlement` | Pelunasan, menunjuk ke `cash_event` uang masuknya. |

Pelunasan yang melebihi sisa piutang ditolak; kelebihannya harus dicatat terpisah
sebagai pemasukan, supaya tidak muncul piutang negatif.

### Asumsi dan skenario

| Tabel | Isi |
|---|---|
| `assumption` | Nilai berversi dengan masa berlaku. |
| `scenario` | Tag yang diaktifkan + override asumsi. |

Membaca asumsi selalu disertai tanggal: `assumptionAt(kunci, tanggal)`. Itu sebabnya
laporan historis tidak berubah ketika kamu mengubah anggaran hari ini.

### Operasional

| Tabel | Isi |
|---|---|
| `pending_decision` | Pertanyaan untukmu. Idempoten lewat `dedupe_key`. |
| `notification_setting` / `notification_log` | Jenis pengingat, frekuensinya, dan apa yang sudah terkirim. |
| `merchant_rule` | Aturan pengelompokan otomatis. |
| `audit_log` | Setiap perubahan: entitas, aksi, pelaku, nilai sebelum dan sesudah. |
| `import_run` / `import_item` | Riwayat impor dan keputusan per baris. |
| `oauth_token` | Token Gmail, terenkripsi. |
| `gmail_state` | Titik riwayat sinkronisasi. |
| `telegram_user` | Akun Telegram yang diizinkan. |

## Nilai uang

Semua nominal adalah bilangan bulat dalam satuan terkecil.

- IDR: 1 satuan = Rp1
- USD/EUR/SGD: 1 satuan = 1 sen

Tidak ada operasi uang yang memakai bilangan pecahan. Pembagian rata memakai
`splitEvenly`, yang membagikan sisa rupiah ke bagian paling awal sehingga totalnya
selalu utuh.

## Waktu

Tanggal sipil disimpan sebagai `YYYY-MM-DD`, waktu sebagai
`YYYY-MM-DDTHH:mm:ss+07:00`. Semua perhitungan kalender memakai Asia/Jakarta dan
tidak bergantung pada zona waktu server. Waktu tanpa zona dianggap sudah waktu Jakarta.

## Penelusuran angka

Setiap angka di laporan dapat ditelusuri asalnya:

- **transaksi aktual** → `cash_event` → `evidence` (tautan buka di Gmail)
- **rencana** → `obligation` / `topup_plan` → `service` atau `assumption`
- **asumsi** → `assumption` dengan masa berlaku dan catatannya
- **hasil kalkulasi** → daftar `drivers` pada tiap hari proyeksi

Antarmuka menampilkan sumber dan tingkat kepastiannya, dan halaman detail transaksi
menampilkan riwayat koreksi dari `audit_log`.
