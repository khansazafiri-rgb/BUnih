# BUnih Telegram-first

Seluruh pekerjaan harian bisa dilakukan dari Telegram: menerima notifikasi transaksi, memilih kategori
dengan satu klik, membuat kategori baru, mencatat, mencari dan mengoreksi transaksi, mengatur anggaran dan
target, melihat laporan, dan mengatur notifikasi. Dashboard web tetap dipakai untuk visualisasi dan analisis
mendalam, dan membaca database yang sama.

> Tidak ada yang di-deploy otomatis. Semua pengujian memakai database memori dan data sintetis.

## 1. Alur utama: dari Gmail sampai terkategorikan

1. Gmail menemukan transaksi bank baru yang valid → BUnih membuat transaksi dan **satu** notifikasi
   Telegram (dijamin satu per transaksi oleh indeks unik, walau email diproses ulang).
2. Pengguna menekan tombol kategori → transaksi **yang sama** diklasifikasikan. Tombol tidak pernah membuat
   transaksi baru; setiap tombol membawa id pesan (`n:<id>:...`), bukan nominal.
3. Notifikasi ditutup dan diganti ringkasan + tombol **Detail & Ubah**.

Contoh nyata (keluaran bot saat pengujian, data sintetis):

```
💸 Transaksi baru terdeteksi
Nominal: Rp85.000
Rekening: Mandiri Livin'
Merchant: Restoran ABC
Tanggal: 13 November 2026
Jenis: Pengeluaran pribadi
Status: Menunggu kategorisasi

Transaksi ini untuk apa?
[🍚 Makan] [🚌 Transport]
[🛒 Belanja bahan makanan] [🛍️ Belanja barang]
[📺 Langganan lain] [🤖 Langganan AI]
[➕ Kategori Baru] [📂 Semua Kategori]
[🔄 Ubah Jenis] [⏭️ Nanti Saja]
```

Bila kategori sudah dikenali (aturan merchant atau kebiasaan), bot menampilkan
**Kategori disarankan: …** dengan tombol **✅ Konfirmasi** dan **✏️ Ubah Kategori**.
Bila rekening tidak bisa dipastikan, rekening ditampilkan *belum teridentifikasi* dengan tombol **🏦 Pilih Rekening**;
bot tidak menebak rekening.

### Membuat kategori baru

```
Kamu   : (tekan ➕ Kategori Baru)
BUnih  : Kategori baru mau diberi nama apa?
Kamu   : pacaran
BUnih  : ➕ Kategori baru: Pacaran — Simpan dan pakai sekarang?
         [✅ Simpan & Pakai] [✏️ Ganti Nama] [❌ Batal]
Kamu   : (tekan ✅ Simpan & Pakai)
BUnih  : ✅ Kategori Pacaran disimpan.
         ✅ Transaksi ini dikategorikan Pacaran. Kategori ini akan muncul di pilihan berikutnya.
```

- Disimpan di tabel `category` yang sama dengan web (muncul di dashboard, analitik, anggaran).
- Tidak ada duplikat: "pacaran", "PACARAN", " Pa caran ", "páCARAN." dianggap satu nama. Kategori yang sudah
  diarsipkan diaktifkan lagi, bukan diduplikasi.
- Bisa membuat apa saja (Fee pekerjaan, Nongkrong, Pengembangan MEDCOEL, …); tidak ada daftar tetap.
- Kategori yang sering dipakai otomatis naik ke tombol cepat; yang belum punya riwayat diurutkan dari yang paling umum.
- Ganti nama, arsip, dan **gabung** ada di `/kategori`. Gabung memindahkan transaksi, potongan alokasi, anggaran, dan
  aturan merchant; kategori asal tidak dihapus (hanya nonaktif dan menunjuk tujuan gabungan), sehingga riwayat utuh.

### Ubah Jenis

Jenis (apa yang terjadi pada uang) dipisahkan dari kategori (untuk apa), merchant (ke siapa), dan penanggung
akhir (diturunkan dari potongan alokasi). Pilihan: pengeluaran pribadi, biaya company, company reimburse,
talangan teman, pembayaran bersama, transfer antarrekening sendiri, tabungan, hadiah, refund, pemasukan,
biaya layanan/fee, belum yakin. Setiap pilihan memperbarui `cash_event.kind` **dan** potongan `allocation`
dalam satu langkah, sehingga saldo, laporan, dan proyeksi konsisten. Pilihan yang tidak cocok dengan arah uang
(mis. reimburse untuk uang masuk) ditolak tanpa mengubah data.

## 2. Perintah

| Perintah | Fungsi |
|---|---|
| `/menu` | Menu utama berisi tombol ke semua bagian |
| `/catat` | Pengeluaran · Pemasukan · Transfer sendiri · Catat reimburse, bertahap (nominal → rekening → merchant → kategori → konfirmasi) |
| `/transaksi [kata kunci]` | Transaksi terbaru, atau pencarian: kategori, merchant, tanggal, rekening, nominal. Kartu transaksi punya tombol Kategori · Koreksi · Bagi Biaya · Reimburse · Jenis · Bukti · Berikutnya |
| `/kategori` | Daftar bertingkat halaman, buat/ganti nama/arsip/gabung |
| `/anggaran` | Daftar anggaran + ubah nominal + nonaktifkan; atau tulis "Buat anggaran Pacaran Rp500 ribu per bulan" |
| `/target` | Daftar target + progres; atau tulis "Target laptop Rp8 juta sebelum Juni 2027" |
| `/laporan` | Pengeluaran bulan ini · Analisis makanan · Merchant terbanyak · Perbandingan bulanan · Progress target |
| `/rekening` | Saldo dan umur konfirmasi tiap rekening; konfirmasi saldo dari chat |
| `/rencana` | Rencana uang 7 hari ke depan |
| `/tagihan` | Tagihan terdekat; tandai sudah dibayar |
| `/pengaturan` | Hidup/mati dan frekuensi setiap jenis notifikasi |
| `/bantuan` | Panduan |

Menu perintah Telegram didaftarkan otomatis saat bot start (`setMyCommands`). Kategori yang jumlahnya berubah-ubah
memakai inline keyboard dinamis dengan Sebelumnya/Berikutnya, **bukan** slash command.
Semua alur punya **Kembali / Batalkan / Menu Utama**.

Kalimat bebas juga dipahami. Contoh nyata:

```
Kamu  : Bayar makan 35rb di kantin pakai Mandiri.
BUnih : 💸 Mencatat pengeluaran
        Nominal: Rp35.000 · Rekening: Mandiri Livin' · Merchant: Kantin
        Kategori: 🍚 Makan (usulan) · Tanggal: 13 November 2026 (hari ini)
        Simpan transaksi ini?   [✅ Simpan] [🏪 Merchant] [📂 Kategori] [🏦 Rekening] [❌ Batalkan]
```

Tanpa menyebut rekening, bot **bertanya** rekening mana (atau "Belum Teridentifikasi" → tersimpan, ditandai
perlu verifikasi). Bot tidak lagi memilih rekening pertama secara otomatis.

## 3. Peringatan saldo yang tidak berulang dan bisa ditindaklanjuti

**Penyebab spam sebelumnya:** kunci deduplikasi `defisit:<tanggal>:<saldo terendah>` memuat saldo terendah, yang
berubah setiap ada transaksi → kunci baru → peringatan baru (default frekuensi `langsung`, dicek tiap 10 menit).

**Sekarang** (`server/src/notify/kontrol.ts`, diuji):
- Maksimal **satu peringatan per hari**. Pengecualian hanya untuk perubahan material: tingkat naik (saldo rendah →
  defisit), kekurangan naik ≥25% dan ≥Rp250.000, atau tanggal defisit maju ≥3 hari; dengan jeda ≥3 jam dan maksimal 3×/hari.
- Perubahan kecil pada angka proyeksi **tidak** memicu peringatan baru.
- Bila saldo dasar belum terverifikasi (asumsi awal / belum dikonfirmasi), pesan diberi judul
  **"Perkiraan — saldo belum diverifikasi"**, urgensi *Rendah*, tanpa pengecualian material, diulang paling cepat tiap 3 hari.
- Setiap peringatan memuat **Urgensi** dan **Kepastian**, serta tombol **🔍 Lihat Penyebab · ⏰ Ingatkan Nanti (6 jam) ·
  🔕 Bisukan 7 Hari** (dan **💳 Konfirmasi Saldo** bila belum terverifikasi).
- **Notifikasi transaksi baru berdiri sendiri** (`transaksi_baru`): tetap terkirim walau pengingat proyeksi dimatikan.
- Peringatan penting tidak dihilangkan: pembayaran gagal, tagihan jatuh tempo, dan langganan tertagih lagi tidak tersentuh.

### Rencana 7 hari, bukan "kekurangan berapa juta"

Angka seperti "kekurangan Rp2 juta" (proyeksi 30 hari) membingungkan. Peringatan dan `/rencana` kini menjawab:

```
🔴 Uang untuk 7 hari ke depan belum cukup

📅 Tenggat terdekat
• 15 Nov (2 hari lagi) — Biznet Rp300.000

💼 Harus siap 7 hari ke depan: Rp510.000
   tagihan Rp300.000 + makan Rp210.000
🎯 Uang yang sebaiknya sudah ada sekarang: Rp610.000
   (kebutuhan 7 hari + cadangan minimal Rp100.000)
💳 Saldo sekarang: Rp120.000

🗒️ Rencana: Batasi belanja di luar tagihan … tunda pembelian besar, dan siapkan pemasukan/top-up Rp490.000 sebelum 15 Nov.

📆 Menjelang 25 Nov (12 hari lagi) uangmu diperkirakan menipis.
Urgensi: Tinggi · Kepastian: Terverifikasi (saldo sudah dikonfirmasi)
```

(Contoh di atas ilustrasi format; angka dihitung dari tagihan terjadwal, anggaran makan, cadangan minimal, dan saldo.)
Bila 7 hari ke depan aman tetapi proyeksi menipis kemudian, judulnya "Aman 7 hari ke depan, tetapi … menipis setelahnya"
dan bot memberi **batas belanja harian** agar aman sampai tanggal itu. Bila saldo belum dikonfirmasi, bot berkata
belum bisa menyebut aman atau kurang, dan mengarahkan ke `/rekening`.

## 4. Arsitektur

- **Framework:** grammY yang sudah dipakai; handler lama (`d:`, `cat:`, `x:`, `kk:`, `an:`, `k:<id>` dari `/koreksi`) tetap berjalan.
- **Lapisan layar** (`telegram/ui/*`): setiap layar adalah data (`teks` + `tombol`), terpisah dari grammY sehingga seluruh
  alur diuji tanpa jaringan. Pembungkusnya `telegram/pasang.ts`.
- **State bertahan setelah restart:** tabel `tg_state` (per chat + slot, kedaluwarsa 45–60 menit). Handler lama yang dulu
  memakai `Map` kini memakai store yang sama.
- **Idempotensi:** `tg_callback_seen` (id callback yang sama diproses sekali); `tg_message` (status `aktif/selesai` per
  notifikasi, tombol lama pada pesan selesai hanya menampilkan ringkasan); indeks unik satu notifikasi per transaksi;
  kategori sama dua kali tidak menulis audit kedua; Simpan di `/catat` menghapus draft sebelum menyimpan.
- **Callback data** ≤64 byte (divalidasi di kode dan tes), singkat dan stabil: `n:<idPesan>:<aksi>`, `t:<aksi>:<idTransaksi>`, dst.
- **Keamanan:** penjaga `TELEGRAM_ALLOWED_CHAT_ID` untuk semua update (pesan dan callback); akun lain tidak mendapat jawaban.
  Log tidak mencetak isi pesan. Semua teks pengguna di-escape HTML.
- **Audit:** setiap perubahan lewat fungsi domain yang menulis `audit_log` (kategori, jenis, koreksi, anggaran, target).

## 5. Bug yang ditemukan dan diperbaiki sepanjang pekerjaan ini

| Bug | Dampak | Perbaikan |
|---|---|---|
| Parser Gmail: bila email tak punya label "Rekening Tujuan", `findAccountTail` mencari angka mask di **seluruh isi** → rekening tujuan = rekening sumber | Pembayaran ke merchant tercatat sebagai *transfer antar rekening sendiri* dan hilang dari pengeluaran | Tujuan tanpa label tidak lagi dicari di seluruh teks; tambahan penjaga di ingest (tujuan = sumber diabaikan) |
| `parseRupiah("Rp500 ribu")` → 500 | Anggaran/target/catatan salah 1000× | Awalan "Rp" boleh menempel pada angka bersatuan |
| Memberi kategori pada uang keluar `belum_dikategorikan` hanya mengisi kolom kategori; potongannya tetap "penyesuaian" | Kategori yang dipilih tidak pernah muncul di laporan | `recategorize` menjadikannya pengeluaran pribadi dengan potongan berkategori |
| `findReference` membaca kata "Referensi" sebagai nomor ("erensi") | Nomor referensi palsu bisa menggabungkan transaksi berbeda | Wajib memuat angka |
| Telegram memilih rekening pertama otomatis untuk catatan teks/foto | Saldo rekening salah | Tanpa rekening + ditandai perlu verifikasi |
| Kunci dedupe defisit memuat saldo terendah | Peringatan berulang | Lihat bagian 3 |

## 6. Migrasi 003 dan memperbarui aplikasi di Tencent

`server/src/db/migrations/003_telegram.sql` — aditif (tabel `tg_state`, `tg_message`, `tg_callback_seen`, kolom
`category.merged_into`). Tidak ada baris yang diubah atau dihapus. Rollback: `server/src/db/rollback/003_telegram.down.sql`
(diuji: data keuangan identik sebelum/sesudah).

**Hal yang berubah perilakunya setelah naik** — baca sebelum memasang:
- Setiap transaksi bank **baru** dari Gmail kini mengirim satu notifikasi interaktif (matikan lewat `/pengaturan` →
  "Transaksi baru dari Gmail"). Transaksi lama tidak dikirim ulang. Pertanyaan kategori lama yang masih berstatus `terbuka`
  (belum pernah terkirim) akan dikirim dalam format baru.
- Pesan teks seperti "makan 25 ribu" sekarang menampilkan kartu konfirmasi lebih dulu, tidak langsung tersimpan.
- Peringatan defisit lebih jarang dan berformat rencana 7 hari.

Langkah (manual, oleh orang yang berwenang; jangan menghentikan Hermes atau container lain):

```bash
# 1. Cadangkan dulu dan periksa hasilnya
bash deploy/scripts/cadangkan.sh
ls -lh /var/backups/bunih | tail -3

# 2. Ambil kode dan pasang (migrasi 003 berjalan otomatis saat aplikasi start)
git fetch && git checkout <commit-ini>
bash deploy/scripts/pasang.sh

# 3. Periksa
bash deploy/scripts/kesehatan.sh
```

Lalu di Telegram: kirim `/menu` (menu perintah ter-update otomatis), `/pengaturan`, dan tunggu transaksi berikutnya.
**Tidak perlu** mengganti OAuth, token bot, atau `.env`.

**Rollback:** pulihkan cadangan (`bash deploy/scripts/pulihkan.sh <berkas>`) lalu checkout commit sebelumnya.
Tanpa cadangan: hentikan aplikasi, `sqlite3 /data/bunih.sqlite < server/src/db/rollback/003_telegram.down.sql`,
lalu checkout commit sebelumnya. Kategori yang dibuat lewat Telegram tetap ada (kolom lama tidak berubah);
hanya `merged_into` dan status percakapan yang hilang.

## 7. Pengujian

`npm test` → **318 tes lulus** (`tests/telegram-first.test.ts`, `tests/regresi-telegram.test.ts`, ditambah suite lama),
`npm run typecheck` bersih. Bot grammY sungguhan diuji dengan transformer API palsu (`tests/bot-uji.ts`): update dikirim
lewat `bot.handleUpdate`, tanpa jaringan.

| # | Skenario | Tes |
|---|---|---|
| 1 | Gmail menemukan transaksi → notifikasi | "mengirim satu notifikasi interaktif…", "tetap terkirim walau pengingat proyeksi dimatikan" |
| 2–4 | Klik kategori; buat kategori baru; muncul di transaksi berikutnya; tanpa duplikat | "alur lengkap", "membuat kategori baru…", "tidak membuat kategori duplikat…" |
| 5 | Bertahan setelah restart | "kategori dan percakapan setengah jalan bertahan setelah bot dibuat ulang" |
| 6–7 | Ubah kategori; alokasi dan laporan ikut; audit | "mengubah kategori transaksi lama…" |
| 8 | Tekan dua kali | "callback yang sama dua kali…", "tombol pada notifikasi yang sudah selesai…" |
| 9 | Callback lama/rusak | "callback lama atau rusak tidak merusak data" |
| 10 | Pengguna tidak sah | "pengguna tidak sah tidak mendapat jawaban…" |
| 11 | Gmail dan Telegram tidak ganda | "catatan manual … lalu notifikasi bank…", "tekan Simpan dua kali…", "memproses ulang email…" |
| 12 | Defisit tidak berulang | seluruh blok "notifikasi defisit tidak berulang" (kebijakan + terintegrasi + mute/tunda/penyebab) |
| 13 | Merchant/rekening belum jelas | "email tanpa rekening…", "/catat dari kalimat tanpa rekening…" |
| 14 | Reimburse, transfer, bersama | blok "jenis transaksi tidak salah dihitung" |
| — | Migrasi 003 naik + rollback | "migrasi 003 aditif dan rollback-nya…" |
| — | Rencana 7 hari | "rencana uang 7 hari…", "aman 7 hari tetapi menipis kemudian…" |

## 8. Batasan yang diketahui

- Satu pengguna/chat (sesuai `TELEGRAM_ALLOWED_CHAT_ID`). Webhook mode memakai handler yang sama tetapi belum diuji sungguhan di server.
- Pemahaman bahasa berbasis aturan: kalimat yang sangat bebas memicu pertanyaan balik, bukan tebakan.
- "Catat Reimburse" di `/catat` mencatat pengeluaran yang kamu bayar dulu dan akan diganti company. Pelunasannya
  (uang masuk) ditangani lewat notifikasi uang masuk → pertanyaan pelunasan piutang yang sudah ada.
- Talangan dari tombol Ubah Jenis belum menanyakan nama orangnya (bisa dilengkapi lewat Bagi Biaya atau web).
- Pencarian `/transaksi` mengenali satu rekening dan satu kategori per kueri.
- "Kategori disarankan" mengikuti aturan merchant dan kategori yang sudah melekat; belum ada pembelajaran statistik.
- Notifikasi Gmail memakai polling tiap `BUNIH_GMAIL_SYNC_CRON_MINUTES` (default 10 menit), bukan push.
