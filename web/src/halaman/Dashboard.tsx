import { api, type DataDashboard } from '../api';
import { hariLagi, rupiah, tanggal, tanggalHari, tanggalSingkat } from '../format';
import { Catatan, ChipAktual, Kosong, useApi, Wadah } from '../components/dasar';
import {
  BarisPeringkat, Celengan, KolomBatang, KunciMeter, MeterAnggaran, Perubahan, Wajah,
} from '../components/viz';
import { bukaCatat } from '../components/FormCatat';

const pergi = (hash: string) => {
  window.location.hash = hash;
};

function Hero({ d }: { d: DataDashboard }) {
  const j = d.jawaban;
  return (
    <section className={`hero hero-${j.wajah}`} aria-live="polite" aria-label="Keadaanmu sekarang">
      <Wajah jenis={j.wajah} />
      <div>
        <p className="hero-judul">{j.judul}</p>
        <p className="hero-kalimat">{j.kalimat}</p>
        {j.alasan.map((a, i) => (
          <p className="hero-alasan" key={i}>{a}</p>
        ))}
        {j.wajah === 'kosong' && (
          <div style={{ marginTop: 12 }}>
            <button className="tombol-catat" onClick={() => bukaCatat()}>＋ Catat pengeluaran pertama</button>
          </div>
        )}
      </div>
    </section>
  );
}

function PanduanMulai({ d, muat }: { d: DataDashboard; muat: () => void }) {
  if (d.mulai.ditutup || d.mulai.selesai) return null;
  const selesai = d.mulai.langkah.filter((l) => l.selesai).length;
  return (
    <section className="mulai" aria-label="Panduan mulai">
      <h2 style={{ margin: 0, fontSize: 19 }}>Mulai cepat — {selesai} dari {d.mulai.langkah.length} langkah</h2>
      <p className="penjelas" style={{ marginTop: 4 }}>Tidak perlu punya spreadsheet. Isi sedikit demi sedikit; BUnih bekerja dengan data yang ada.</p>
      <ul className="mulai-langkah">
        {d.mulai.langkah.map((l) => (
          <li key={l.kunci}>
            <a href={l.tautan}>
              <span className={`centang ${l.selesai ? 'ok' : ''}`} aria-hidden="true">{l.selesai ? '✓' : ''}</span>
              <span className={l.selesai ? 'selesai-teks' : ''}>{l.label}</span>
              {l.selesai && <span className="sembunyi-visual"> (sudah)</span>}
            </a>
          </li>
        ))}
      </ul>
      <button className="tombol tombol-kecil" style={{ marginTop: 10 }} onClick={async () => { await api.post('/onboarding/tutup'); muat(); }}>
        Sembunyikan panduan
      </button>
    </section>
  );
}

export default function Dashboard() {
  const keadaan = useApi(() => api.get<DataDashboard>('/dashboard'), []);

  return (
    <Wadah keadaan={keadaan}>
      {(d) => {
        const p = d.pemakaian;
        const baris = p.kategori.map((k) => ({
          kunci: String(k.category_id ?? 'kosong'),
          ikon: k.ikon,
          nama: k.nama,
          nilai_minor: k.jumlah_minor,
          ket: <span>{Math.round(k.persen)}% dari semua pengeluaran</span>,
          jenis: k.belum_dikategorikan ? ('netral' as const) : ('pengeluaran' as const),
        }));
        if (p.lainnya_minor > 0) {
          baris.push({ kunci: 'lainnya', ikon: '…', nama: `Lainnya (${p.lainnya_jumlah} kategori)`, nilai_minor: p.lainnya_minor, ket: <span>Lihat semuanya di Analitik</span>, jenis: 'netral' as const });
        }
        const rataTujuh = Math.round(d.tujuh_hari.reduce((s, x) => s + x.jumlah_minor, 0) / 7);

        return (
          <div className="tumpuk">
            <p className="sapaan">{tanggalHari(d.hari_ini)}</p>

            <Hero d={d} />
            <PanduanMulai d={d} muat={keadaan.muatUlang} />

            <div className="dua-kolom">
              <section className="kartu kartu-besar" aria-labelledby="h-uang">
                <p className="tanya" id="h-uang">Berapa uangku sekarang?</p>
                {d.uang.saldo_terverifikasi_minor === null ? (
                  <>
                    <div className="angka-hero angka-hero-kecil">Belum diketahui</div>
                    <p className="penjelas">Aku belum bisa menyebut saldo karena belum ada saldo rekening yang kamu konfirmasi. Mengarang angka itu tidak jujur.</p>
                    <a className="tautan-kartu" href="#/pengaturan">Isi saldo rekening →</a>
                  </>
                ) : (
                  <>
                    <div className="angka-hero">{rupiah(d.uang.saldo_terverifikasi_minor)}</div>
                    <p className="penjelas"><ChipAktual /> total dari rekening yang sudah dikonfirmasi</p>
                    <ul className="daftar" style={{ marginTop: 10 }}>
                      {d.uang.rekening.map((r) => (
                        <li key={r.nama}>
                          <div className="isi">{r.nama}{r.last4 ? ` ••${r.last4}` : ''}{r.tabungan ? ' · tabungan' : ''}</div>
                          <div className="nilai">{r.saldo_minor === null ? <span className="kecil">belum dikonfirmasi</span> : rupiah(r.saldo_minor)}</div>
                        </li>
                      ))}
                    </ul>
                    {d.uang.dalam_perjalanan_minor > 0 && <Catatan>{rupiah(d.uang.dalam_perjalanan_minor)} sedang dalam perjalanan antar rekeningmu. Uangnya tidak hilang.</Catatan>}
                  </>
                )}
              </section>

              <section className="kartu kartu-besar" aria-labelledby="h-pakai">
                <p className="tanya" id="h-pakai">Berapa yang sudah kupakai?</p>
                <div className="angka-hero">{rupiah(p.total_minor)}</div>
                <p className="penjelas">{d.bulan}, hari ke-{p.hari_berjalan} dari {p.hari_dalam_bulan}</p>
                <div style={{ margin: '10px 0 4px' }}><Perubahan persen={p.perubahan_persen} /></div>
                <p className="penjelas">
                  {p.perubahan_persen === null ? `Belum ada pembanding dari ${p.sebelumnya_label}.` : `Pada waktu yang sama di ${p.sebelumnya_label} kamu memakai ${rupiah(p.sebelumnya_minor)}.`}
                </p>
                <p className="penjelas" style={{ marginTop: 6 }}>Rata-rata <b>{rupiah(p.rata_per_hari_minor)}</b> per hari.</p>
              </section>
            </div>

            <section className="kartu kartu-besar" aria-labelledby="h-apa">
              <p className="tanya" id="h-apa">Uangku dipakai buat apa?</p>
              {baris.length === 0 ? (
                <Kosong ikon="🧾" judul="Belum ada pengeluaran bulan ini" pesan="Catat pengeluaran pertamamu, lalu di sini akan terlihat mana yang paling besar." aksi={<button className="tombol-catat" onClick={() => bukaCatat()}>＋ Catat</button>} />
              ) : (
                <>
                  <p className="kartu-sub">Diurutkan dari yang paling besar. Ketuk satu baris untuk melihat transaksinya.</p>
                  <BarisPeringkat
                    baris={baris}
                    onPilih={(b) => pergi(b.kunci === 'lainnya' ? '#/analitik' : b.kunci === 'kosong' ? '#/analitik?rincian=kosong' : `#/analitik?rincian=kategori:${b.kunci}`)}
                  />
                  <a className="tautan-kartu" href="#/analitik">Lihat analisis lengkap →</a>
                </>
              )}
            </section>

            <div className="dua-kolom">
              <section className="kartu kartu-besar" aria-labelledby="h-anggaran">
                <p className="tanya" id="h-anggaran">Anggaranku, masih cukup?</p>
                {d.anggaran.length === 0 ? (
                  <Kosong ikon="🎯" judul="Belum ada anggaran" pesan="Anggaran adalah batas uang untuk sesuatu, misalnya makan Rp900.000 sebulan. Dengan itu BUnih bisa mengingatkan sebelum kamu kebablasan." aksi={<a className="tombol tombol-utama" href="#/anggaran">Buat anggaran</a>} />
                ) : (
                  <>
                    <div className="meter-daftar">
                      {d.anggaran.map((b) => <MeterAnggaran key={b.id} b={b} onKlik={() => pergi('#/anggaran')} />)}
                    </div>
                    <KunciMeter />
                    <a className="tautan-kartu" href="#/anggaran">Kelola anggaran →</a>
                  </>
                )}
              </section>

              <section className="kartu kartu-besar" aria-labelledby="h-tujuh">
                <p className="tanya" id="h-tujuh">7 hari terakhir</p>
                <KolomBatang
                  judul="Pengeluaran 7 hari terakhir"
                  data={d.tujuh_hari.map((x) => ({ kunci: x.tanggal, label: x.hari_ini ? 'Ini' : x.label, nilai: Math.max(0, x.jumlah_minor), sorot: x.hari_ini }))}
                />
                <p className="penjelas">Rata-rata <b>{rupiah(rataTujuh)}</b> per hari. Batang berwarna = hari ini.</p>
              </section>
            </div>

            <div className="dua-kolom">
              <section className="kartu kartu-besar" aria-labelledby="h-tagihan">
                <p className="tanya" id="h-tagihan">Tagihan apa yang dekat?</p>
                {d.tagihan.daftar.length === 0 ? (
                  <p className="penjelas">Tidak ada tagihan dalam 14 hari ke depan. 🎉</p>
                ) : (
                  <ul className="daftar">
                    {d.tagihan.daftar.map((t) => {
                      const sisa = hariLagi(t.tanggal, d.hari_ini);
                      const kelas = t.terlambat ? 'lewat' : sisa <= 3 ? 'dekat' : '';
                      return (
                        <li key={t.obligation_id} style={{ alignItems: 'center' }}>
                          <span className={`hitung-mundur ${kelas}`} aria-label={t.terlambat ? 'Sudah lewat jatuh tempo' : `${sisa} hari lagi`}>
                            <b>{t.terlambat ? '!' : sisa}</b>
                            <span>{t.terlambat ? 'lewat' : 'hari'}</span>
                          </span>
                          <div className="isi">
                            <div style={{ fontWeight: 700 }}>{t.label}</div>
                            <div className="kecil">{tanggal(t.tanggal)} · {t.pembayar === 'saya' ? 'aku yang bayar' : t.pembayar === 'company' ? 'company yang bayar' : 'pembayar belum jelas'}</div>
                          </div>
                          <div className="nilai">{rupiah(t.nominal_minor)}</div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {d.tagihan.dana_14_hari_minor > 0 && <p className="penjelas" style={{ marginTop: 10 }}>Siapkan <b>{rupiah(d.tagihan.dana_14_hari_minor)}</b> untuk 14 hari ke depan.</p>}
                {d.tagihan.tanpa_nominal > 0 && <Catatan peringatan>{d.tagihan.tanpa_nominal} tagihan belum punya nominal, jadi angkanya belum lengkap.</Catatan>}
                <a className="tautan-kartu" href="#/tagihan">Semua tagihan →</a>
              </section>

              <section className="kartu kartu-besar" aria-labelledby="h-tujuan">
                <p className="tanya" id="h-tujuan">Tabunganku untuk apa saja?</p>
                {d.tujuan.length === 0 ? (
                  <Kosong ikon="🐷" judul="Belum ada tujuan" pesan="Buat tujuan, misalnya laptop Rp5.000.000, lalu lihat berapa lagi yang dibutuhkan." aksi={<a className="tombol tombol-utama" href="#/tujuan">Buat tujuan</a>} />
                ) : (
                  <>
                    <div className="tujuan-daftar">
                      {d.tujuan.map((g) => (
                        <div className="tujuan-baris" key={g.id}>
                          <Celengan persen={g.persen} ikon={g.ikon ?? '🐷'} />
                          <div>
                            <p className="tujuan-nama">{g.nama}</p>
                            <p className="tujuan-angka">{rupiah(g.terkumpul_minor)} dari {rupiah(g.target_minor)}</p>
                            <p className="tujuan-tegas">{g.penjelasan}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <a className="tautan-kartu" href="#/tujuan">Kelola tujuan →</a>
                  </>
                )}
              </section>
            </div>

            <div className="dua-kolom">
              <section className="kartu kartu-besar" aria-labelledby="h-perhatian">
                <p className="tanya" id="h-perhatian">Ada yang perlu kuurus?</p>
                {d.perlu_perhatian.length === 0 ? (
                  <p className="penjelas">Tidak ada yang perlu diurus sekarang. ✔</p>
                ) : (
                  <ul className="perhatian">
                    {d.perlu_perhatian.map((x) => (
                      <li key={x.tipe}><a href={x.tautan}><span className="ikon-p" aria-hidden="true">⚠️</span>{x.teks}</a></li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="kartu kartu-besar" aria-labelledby="h-insight">
                <p className="tanya" id="h-insight">Yang menarik dari datamu</p>
                {d.insight.length === 0 ? (
                  <p className="penjelas">Belum ada cukup data untuk menyimpulkan apa pun. Terus catat; kesimpulan hanya muncul bila angkanya cukup.</p>
                ) : (
                  <ul className="insight">
                    {d.insight.map((i) => (
                      <li key={i.kunci}>
                        <span className="ikon-i" aria-hidden="true">{i.tingkat === 'perhatian' ? '⚠️' : i.tingkat === 'baik' ? '🎉' : '💡'}</span>
                        <div>
                          {i.teks}
                          {i.rincian && <div><button onClick={() => pergi(i.rincian!.kategori_id ? `#/analitik?rincian=kategori:${i.rincian!.kategori_id}` : i.rincian!.tanpa_kategori ? '#/analitik?rincian=kosong' : i.rincian!.merchant_id ? `#/analitik?rincian=merchant:${i.rincian!.merchant_id}` : '#/analitik')}>Lihat transaksinya</button></div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <a className="tautan-kartu" href="#/analitik">Semua analisis →</a>
              </section>
            </div>
            <p className="kecil-redup" style={{ textAlign: 'center' }}>Periode {tanggalSingkat(p.dari)} – {tanggalSingkat(p.sampai)}. Perkiraan selalu diberi label dan tidak pernah dicampur dengan angka yang sudah terjadi.</p>
          </div>
        );
      }}
    </Wadah>
  );
}
