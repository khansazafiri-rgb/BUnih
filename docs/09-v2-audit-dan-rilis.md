# BUnih v2 — audit, rancangan, migrasi, dan cara merilis

Dokumen ini menyertai PR v2. Isinya: temuan audit v1, apa yang berubah, bagaimana data lama
dijaga, cara memasang dengan aman, cara membatalkan, dan batasan yang masih ada.

> **Tidak ada yang otomatis di-deploy.** PR ini tidak menyentuh server produksi, database
> produksi, Hermes, n8n, Qdrant, container lain, atau routing Tailscale. Semua pengujian memakai
> database memori dan data sintetis. Tidak ada rahasia produksi atau catatan keuangan pribadi di
> log maupun fixture.

---

## 1. Audit v1 (dikerjakan sebelum mengubah apa pun)

Setiap temuan punya tes di [`server/tests/audit-v2.test.ts`](../server/tests/audit-v2.test.ts).
Tes ditulis lebih dulu dan **gagal di kode v1**, lalu lulus setelah perbaikan.

| # | Temuan | Dampak | Perbaikan |
|---|---|---|---|
| T1 | Mengganti kategori hanya mengubah `cash_event.category_id`, sedangkan laporan membaca `allocation.category_id` | Laporan bulanan tidak berubah setelah kategori diganti; dua tempat menyimpan kebenaran yang berbeda | `recategorize()` ditulis ulang: memperbarui kedua tempat dalam satu transaksi dan mencatat riwayat. Semua laporan membaca alokasi |
| T2 | Dua pembelian manual identik di hari yang sama digabung diam-diam (kunci dedupe mengabaikan sumber) | Pengeluaran sungguhan hilang | Manual/Telegram tanpa nomor referensi hanya digabung bila terjadi dalam jendela 120 detik (kirim ganda); bukti bank/CSV melengkapi tepat satu entri manual yang cocok |
| T3 | Dua uang masuk nominal sama tanpa referensi bisa menyelesaikan satu piutang dengan satu uang | Piutang tampak lunas padahal belum | Kunci dedupe unik per entri manual; pelunasan menunjuk transaksi tertentu |
| T4 | Membagi ulang transaksi yang sudah melunasi piutang bisa melunasi dua kali | Piutang negatif / uang terhitung dua kali | Pembagian ulang ditolak bila ada `receivable_settlement` pada transaksi itu |

Temuan lain yang diperbaiki sebagai bagian dari v2:

- Konsep "Claude Pro pribadi" tertanam di antarmuka bawaan. Sekarang skenario itu disembunyikan
  (kolom `hidden`), tidak dihapus, dan default perbandingan memakai skenario dasar.
- Instalasi baru tidak bisa dipakai tanpa Google Sheet (angka awal berasal dari Sheet). Sekarang ada
  profil seed `bersih` yang tidak membutuhkan Sheet sama sekali.
- Skrip contoh v1 menghitung satu pelunasan dua kali. Diganti data sintetis baru.

## 2. Prinsip yang dijaga

1. **Satu rupiah, satu makna.** Hanya `cash_event` yang memindahkan uang. Potongan `allocation`
   wajib berjumlah sama dengan nominal transaksi. Anggaran, tujuan, tagihan, dan perkiraan **tidak
   pernah** menggerakkan uang.
2. **Satu definisi pengeluaran pribadi** di [`spend.ts`](../server/src/domain/spend.ts):
   alokasi `biaya_pribadi` dan `kredit_layanan`, dikurangi `refund`. Transfer sendiri, tabungan,
   piutang, pelunasan, biaya company langsung, dan transaksi batal tidak dihitung. Analitik,
   anggaran, laporan, insight, dan Telegram semuanya membaca dari sini, sehingga angka di layar
   mana pun sama dan bisa dihitung ulang.
3. **Aktual vs perkiraan dipisah dan diberi label.** Perkiraan akhir periode, proyeksi, dan laju
   menabung selalu bertanda "estimasi"; tidak ditampilkan bila datanya belum cukup.
4. **Terverifikasi vs perkiraan vs belum dikategorikan** terlihat jelas. Saldo hanya ditampilkan bila
   ada rekening yang sudah dikonfirmasi; bila tidak, dashboard berkata "belum diketahui", bukan
   mengarang angka.
5. **Riwayat dipertahankan.** Revisi anggaran memakai tabel revisi; kategori/merchant dinonaktifkan,
   bukan dihapus; setiap koreksi tercatat di audit.
6. **Pembanding yang adil.** Bulan berjalan dibandingkan dengan jumlah hari yang sama di bulan
   sebelumnya, bukan seluruh bulan lalu.

## 3. Yang baru

**Web** (navigasi: Dashboard · Transaksi · Analitik · Anggaran · Tujuan · Tagihan & Langganan ·
Reimburse · Rekening & Tabungan · Kategori & Tempat · Proyeksi & Simulasi · Pengaturan)

- **Dashboard** menjawab empat pertanyaan dengan bahasa sehari-hari: *Berapa uangku? Berapa yang
  sudah kupakai? Uangku dipakai buat apa? Anggaranku masih cukup?* Dimulai dari satu kartu jawaban
  dengan wajah dan satu kata (Aman / Hati-hati / Perlu perhatian). Batang bertingkat berurutan,
  meter anggaran dengan garis "seharusnya sampai sini", toples tujuan. Status tidak pernah hanya
  lewat warna (ada ikon + teks).
- **Analitik** — enam tab (Ringkasan, Kategori, Tempat belanja, Makanan, Tren, Langganan), pilihan
  periode, dan *drill-down*: ketuk kategori/merchant untuk melihat transaksi pembentuk angkanya.
- **Anggaran** — harian/mingguan/bulanan/rentang kustom, per kategori atau keseluruhan, berulang
  atau sekali, *rollover* opsional, ubah nominal tanpa menghapus riwayat.
- **Tujuan** — banyak tujuan; menyisihkan uang **hanya penanda** (tidak ada transaksi). Transfer
  tabungan sungguhan bisa ditautkan ke tujuan.
- **Kategori & Tempat belanja** — kategori dan subkategori buatan sendiri; merchant dengan alias
  ("GOFOOD BAKSO PAK KUMIS" → satu tempat), kategori otomatis per tempat, gabung duplikat.
- **Catat** (tombol global) — pengeluaran/pemasukan/pindah/refund; pecah ke beberapa kategori;
  patungan & talangan; reimburse company; hadiah; proyek; pelunasan piutang.
- **Transaksi** — bisa diubah (tempat, kategori, catatan, "ingat untuk tempat ini"), filter kategori
  dan tanggal.
- **Pengaturan** — impor Google Sheet kini bagian opsional yang tertutup.

**Telegram**

- Pertanyaan: "berapa pengeluaran makan bulan ini?", "paling banyak habis buat apa minggu ini?",
  "bandingkan bulan ini dengan bulan lalu", "berapa belanja di Gojek bulan ini?"
- Jawaban dihitung dari fungsi domain yang sama dengan web. Data kosong dijawab jujur.
- Bila ambigu (mis. "langganan" cocok dengan dua kategori), bot **bertanya dengan tombol**, tidak menebak.
- Buat tujuan: "buat tujuan laptop 8 juta 6 bulan lagi"; bila nama/target kurang, bot bertanya.
- "makan 25 ribu di Kantin Kampus #skripsi" → tempat dan proyek ikut tercatat.
- `/anggaran` memakai modul anggaran; `/tujuan` baru.
- Pengingat baru `anggaran_berisiko` dan `tujuan_berisiko` (satu kali per anggaran/periode/tingkat).

## 4. Migrasi database

File: [`002_v2.sql`](../server/src/db/migrations/002_v2.sql), pembatalan:
[`rollback/002_v2.down.sql`](../server/src/db/rollback/002_v2.down.sql).

- **Aditif.** Hanya menambah kolom dan tabel: `category` (parent/active/sort/icon), `cash_event`
  (merchant_id, project), tabel `merchant`, `merchant_alias`, `budget`, `budget_revision`, `goal`,
  `goal_contribution`, `app_setting`, kolom `scenario.hidden`.
- Tidak ada baris yang dihapus atau ditimpa. Backfill merchant hanya untuk nama yang persis sama
  setelah normalisasi (huruf kecil, tanpa tanda baca/angka acak).
- Seed memakai `INSERT OR IGNORE`; menjalankan ulang tidak mengubah apa pun.
- Database lama (sudah berisi layanan/asumsi) otomatis diperlakukan sebagai `warisan`: katalog
  lama tetap ada. Database kosong memakai `BUNIH_SEED_PROFILE` (default `bersih`).
- Diuji: `tests/migrasi-v2.test.ts` memuat database bergaya v1 berisi data, menjalankan migrasi,
  memeriksa semua baris asli utuh, lalu menjalankan skrip pembatalan.

## 5. Memasang ke produksi (manual, bertahap)

Tidak ada yang berjalan otomatis. Lakukan oleh orang yang berwenang:

```bash
# 1. Cadangkan DULU dan periksa hasilnya
bash deploy/scripts/cadangkan.sh
ls -lh /var/backups/bunih | tail -3

# 2. Ambil kode, bangun, lalu terapkan (migrasi berjalan saat aplikasi start)
git fetch && git checkout <commit-v2>
bash deploy/scripts/pasang.sh      # skrip yang sama dengan v1; tidak menyentuh container lain

# 3. Periksa
bash deploy/scripts/kesehatan.sh
```

Setelah naik, buka Dashboard dan **bandingkan beberapa angka dengan v1** (total bulan ini, saldo).
Perbedaan yang wajar: pengeluaran yang sebelumnya salah kategori kini muncul di kategori yang benar.

## 6. Membatalkan (rollback)

Cara teraman: pulihkan cadangan dari langkah 1.

```bash
bash deploy/scripts/pulihkan.sh /var/backups/bunih/<berkas-cadangan>.sqlite
git checkout <commit-v1> && bash deploy/scripts/pasang.sh
```

Tanpa cadangan: hentikan aplikasi, lalu `sqlite3 /data/bunih.sqlite < server/src/db/rollback/002_v2.down.sql`.
Skrip ini hanya menghapus yang ditambahkan 002; tabel asli tidak tersentuh. **Data yang dibuat
lewat fitur v2** (anggaran, tujuan, alias merchant) ikut hilang pada pembatalan ini — itu sebabnya
cadangan lebih dianjurkan.

## 7. Pengujian

`npm test` → **265 tes lulus**, `npm run typecheck` bersih untuk server dan web.

Cakupan v2: audit T1–T4; CRUD kategori & hierarki; normalisasi dan alias merchant; pembuatan dan
perubahan transaksi manual; pembagian kategori mempertahankan total; transfer & tabungan bukan
pengeluaran; reimburse & talangan bukan pemasukan; refund tidak dihitung ganda; pencegahan duplikat;
anggaran (jendela, rollover, revisi, perkiraan); tujuan (penyisihan tanpa uang berpindah); analitik
dengan dataset yang dapat dihitung manual; keadaan data kosong; API; migrasi + pembatalan; Telegram
(waktu, ambiguitas, tujuan, merchant/proyek, pengingat).

Tangkapan layar (data sintetis, desktop, ponsel, mode gelap): [`docs/screenshots/`](screenshots/).
Untuk mengisi data contoh sendiri di lingkungan uji:

```bash
BUNIH_DATA_DIR=/tmp/bunih-demo BUNIH_ENABLE_SCHEDULER=false \
  npx tsx server/src/scripts/contoh.ts          # menolak berjalan bila sudah ada data asli
```

## 8. Batasan yang diketahui

- **Perkiraan masih sederhana.** Perkiraan akhir periode adalah ekstrapolasi laju harian; tidak
  memahami pola mingguan (mis. belanja besar tiap akhir pekan). Diberi label estimasi.
- **Pembanding bulan pendek** (sedikit hari berjalan) bisa menghasilkan persentase besar. Insight
  menyertakan angka mentahnya; sistem tidak menyembunyikannya.
- **Kategori default** masih mengandung istilah pengembang (Langganan AI, Server & hosting).
  Semuanya bisa diganti nama atau dinonaktifkan di Kategori & Tempat.
- **NLU Telegram berbasis aturan**, bukan model bahasa: sengaja agar hasilnya dapat dijelaskan,
  tetapi kalimat yang sangat bebas akan memicu pertanyaan balik.
- **Pecah kategori & patungan** dibuat dari formulir web; di Telegram baru lewat alur bagi biaya yang lama.
- **Skenario Claude** disembunyikan, belum bisa dimunculkan lagi dari UI (datanya tetap ada).
- Tidak ada ekspor anggaran/tujuan ke CSV (ekspor transaksi tetap ada di Pengaturan).
- Tampilan sudah diperiksa di Chromium (desktop, ponsel 390px, mode gelap); belum diuji di Safari iOS.
