import { useEffect, useState } from 'react';
import { api, type BarisRincian, type DataAnalitik, type DataRincian } from '../api';
import { jam, LABEL_JENIS, rupiah, tanggal, tanggalSingkat } from '../format';
import { Catatan, ChipVerifikasi, Kosong, useApi, Wadah } from '../components/dasar';
import { BarisPeringkat, GarisTren, KolomBatang, MeterAnggaran, Perubahan } from '../components/viz';

type Preset = 'bulan_ini' | 'bulan_lalu' | '7_hari' | '30_hari' | '90_hari' | 'tahun_ini' | 'kustom';
const PRESET: Array<[Preset, string]> = [
  ['bulan_ini', 'Bulan ini'],
  ['bulan_lalu', 'Bulan lalu'],
  ['7_hari', '7 hari'],
  ['30_hari', '30 hari'],
  ['90_hari', '90 hari'],
  ['tahun_ini', 'Tahun ini'],
  ['kustom', 'Pilih tanggal'],
];
const TAB = ['Ringkasan', 'Kategori', 'Tempat belanja', 'Makanan', 'Tren', 'Langganan'] as const;
type NamaTab = (typeof TAB)[number];

type Spek = { judul: string; query: string };

function bacaRincianDariHash(): string | null {
  const q = window.location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get('rincian') : null;
}

function Stat({ tanya, nilai, ket, chip }: { tanya: string; nilai: string; ket?: React.ReactNode; chip?: React.ReactNode }) {
  return (
    <section className="kartu kartu-besar">
      <p className="tanya">{tanya}</p>
      <div className="angka-hero angka-hero-kecil">{nilai}</div>
      {chip && <div style={{ margin: '4px 0' }}>{chip}</div>}
      {ket && <p className="penjelas">{ket}</p>}
    </section>
  );
}

/** Transaksi di balik sebuah angka. Memakai definisi pengeluaran yang sama dengan analitik. */
function PanelRincian({ spek, dari, sampai, tutup }: { spek: Spek; dari: string; sampai: string; tutup: () => void }) {
  const data = useApi(() => api.get<DataRincian>(`/analitik/rincian?dari=${dari}&sampai=${sampai}&${spek.query}`), [spek.query, dari, sampai]);
  return (
    <dialog open className="kartu" style={{ position: 'fixed', inset: 'auto 0 0 0', margin: '0 auto', maxHeight: '82vh', overflow: 'auto', zIndex: 60, width: 'min(720px, 100vw)', borderRadius: '22px 22px 0 0' }} aria-label="Rincian transaksi">
      <div className="renteng" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>{spek.judul}</h2>
          <p className="kecil" style={{ margin: 0 }}>{tanggalSingkat(dari)} – {tanggalSingkat(sampai)}</p>
        </div>
        <button className="tombol tombol-kecil" onClick={tutup}>Tutup</button>
      </div>
      <Wadah keadaan={data}>
        {(d) => (
          <>
            <p className="angka-hero angka-hero-kecil">{rupiah(d.total_minor)}</p>
            <p className="penjelas">dari {d.jumlah_transaksi} transaksi{d.terpotong ? ' (daftar dipotong, urut dari yang terbaru)' : ''}.</p>
            {d.baris.length === 0 ? (
              <Kosong ikon="🔍" judul="Tidak ada transaksi" pesan="Tidak ada transaksi yang cocok pada rentang ini." />
            ) : (
              <ul className="daftar">
                {d.baris.map((b: BarisRincian) => (
                  <li key={b.alokasi_id}>
                    <div className="isi">
                      <div style={{ fontWeight: 650 }}>{b.merchant}{b.refund ? ' (refund)' : ''}</div>
                      <div className="kecil">
                        {tanggalSingkat(b.tanggal)} {jam(b.waktu)} · {b.kategori} · {LABEL_JENIS[b.kind] ?? b.kind}
                        {b.project ? ` · proyek ${b.project}` : ''}
                        {b.rekening ? ` · ${b.rekening}` : ''}
                      </div>
                      {b.status !== 'terkonfirmasi' && <ChipVerifikasi teks={b.status.replace(/_/g, ' ')} />}
                    </div>
                    <div className="nilai">
                      <div>{b.jumlah_minor < 0 ? '−' : ''}{rupiah(Math.abs(b.jumlah_minor))}</div>
                      <a className="kecil" href={`#/transaksi?id=${b.cash_event_id}`} onClick={tutup}>Buka</a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Wadah>
    </dialog>
  );
}

export default function Analitik() {
  const [preset, setPreset] = useState<Preset>('bulan_ini');
  const [dari, setDari] = useState('');
  const [sampai, setSampai] = useState('');
  const [tab, setTab] = useState<NamaTab>('Ringkasan');
  const [rincian, setRincian] = useState<Spek | null>(null);
  const [terbuka, setTerbuka] = useState<string | null>(null);

  const query = preset === 'kustom' && dari && sampai ? `dari=${dari}&sampai=${sampai}` : `preset=${preset === 'kustom' ? 'bulan_ini' : preset}`;
  const data = useApi(() => api.get<DataAnalitik>(`/analitik?${query}`), [query]);

  // Dibuka dari kartu Dashboard: #/analitik?rincian=kategori:12
  useEffect(() => {
    const r = bacaRincianDariHash();
    if (!r || !data.data) return;
    const [jenis, nilai] = r.split(':');
    if (jenis === 'kategori' && nilai) {
      const nama = data.data.kategori.find((k) => String(k.category_id) === nilai)?.nama ?? 'Kategori';
      setRincian({ judul: nama, query: `kategori=${nilai}` });
      setTab('Kategori');
    } else if (jenis === 'merchant' && nilai) {
      const nama = [...data.data.merchant.paling_sering, ...data.data.merchant.paling_besar_total].find((m) => String(m.merchant_id) === nilai)?.nama ?? 'Merchant';
      setRincian({ judul: nama, query: `merchant=${nilai}` });
      setTab('Tempat belanja');
    } else if (r === 'kosong') {
      setRincian({ judul: 'Belum dikategorikan', query: 'tanpa_kategori=1' });
      setTab('Kategori');
    }
    window.history.replaceState(null, '', '#/analitik');
  }, [data.data]);

  return (
    <>
      <h1>Analitik</h1>
      <p className="subjudul">Ke mana uangmu pergi, dengan angka yang bisa ditelusuri sampai ke transaksinya.</p>

      <div className="gulir-x" style={{ marginBottom: 10 }}>
        <div className="segmen" role="group" aria-label="Rentang waktu">
          {PRESET.map(([id, nama]) => (
            <button key={id} aria-pressed={preset === id} onClick={() => setPreset(id)}>{nama}</button>
          ))}
        </div>
      </div>
      {preset === 'kustom' && (
        <div className="bidang-baris bidang-baris-2" style={{ marginBottom: 10 }}>
          <div className="bidang"><label htmlFor="an-dari">Dari</label><input id="an-dari" type="date" value={dari} onChange={(e) => setDari(e.target.value)} /></div>
          <div className="bidang"><label htmlFor="an-sampai">Sampai</label><input id="an-sampai" type="date" value={sampai} onChange={(e) => setSampai(e.target.value)} /></div>
        </div>
      )}

      <Wadah keadaan={data}>
        {(a) => {
          const r = a.ringkasan;
          const k = a.kualitas_data;
          const mulai = (judul: string, q: string) => setRincian({ judul, query: q });
          const kategoriBaris = a.kategori.map((c) => ({
            kunci: String(c.category_id ?? 'kosong'),
            ikon: c.ikon,
            nama: c.nama,
            nilai_minor: c.jumlah_minor,
            perubahan: c.perubahan_persen,
            ket: <span>{Math.round(c.persen)}% · {c.jumlah_transaksi} transaksi</span>,
            jenis: c.belum_dikategorikan ? ('netral' as const) : ('pengeluaran' as const),
          }));

          return (
            <>
              <p className="penjelas" style={{ marginBottom: 6 }}>
                {a.rentang.label} ({tanggal(a.rentang.dari)} – {tanggal(a.rentang.sampai)}). Pembanding: <b>{a.rentang.sebelumnya.label}</b>.
              </p>

              {(k.belum_dikategorikan_jumlah > 0 || k.perlu_verifikasi_jumlah > 0) && (
                <Catatan peringatan>
                  <b>Data belum sepenuhnya rapi.</b>{' '}
                  {k.belum_dikategorikan_jumlah > 0 && <>{k.belum_dikategorikan_jumlah} transaksi ({rupiah(k.belum_dikategorikan_minor)}) belum dikategorikan. </>}
                  {k.perlu_verifikasi_jumlah > 0 && <>{k.perlu_verifikasi_jumlah} transaksi masih perlu diverifikasi. </>}
                  Angka di bawah tetap dihitung, tetapi pembagian kategorinya belum lengkap.
                </Catatan>
              )}

              <div className="tab" role="tablist" style={{ marginTop: 12 }}>
                {TAB.map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
                ))}
              </div>

              {tab === 'Ringkasan' && (
                <div className="tumpuk">
                  <div className="tiga-kolom">
                    <Stat tanya="Uang yang masuk" nilai={rupiah(r.pemasukan_minor)} ket="Pemasukan nyata. Tidak termasuk refund, uang yang dikembalikan teman, atau perpindahan antar rekeningmu." chip={r.pemasukan_minor > 0 ? <span className="chip chip-aktual">Aktual</span> : undefined} />
                    <Stat tanya="Yang benar-benar jadi pengeluaranku" nilai={rupiah(r.pengeluaran_pribadi_neto_minor)} chip={<Perubahan persen={r.perubahan_persen} />} ket={<>Dibanding {rupiah(r.pengeluaran_pribadi_sebelumnya_minor)} pada {a.rentang.sebelumnya.label}.</>} />
                    <Stat tanya="Uang yang keluar dari rekeningku" nilai={rupiah(r.arus_kas_keluar_minor)} ket="Termasuk yang nanti diganti teman atau company. Tidak termasuk tabungan dan perpindahan antar rekeningmu." />
                  </div>
                  <div className="tiga-kolom">
                    <Stat tanya="Selisih uang masuk dan keluar" nilai={`${r.arus_kas_neto_minor < 0 ? '−' : ''}${rupiah(Math.abs(r.arus_kas_neto_minor))}`} ket={r.arus_kas_neto_minor >= 0 ? 'Uang masukmu lebih banyak dari yang keluar.' : 'Uang keluarmu lebih banyak dari yang masuk.'} />
                    <Stat tanya="Uang tersedia (sudah dikonfirmasi)" nilai={r.saldo_terverifikasi_minor === null ? 'Belum diketahui' : rupiah(r.saldo_terverifikasi_minor)} ket={r.saldo_terverifikasi_minor === null ? 'Isi saldo rekening di Pengaturan supaya angka ini bisa muncul.' : r.saldo_lengkap ? 'Semua rekeningmu sudah terkonfirmasi.' : 'Belum semua rekening terkonfirmasi.'} />
                    <Stat tanya="Yang berhasil kutabung" nilai={rupiah(r.tabungan_neto_minor)} ket={r.tujuan.jumlah_aktif ? `${r.tujuan.jumlah_aktif} tujuan aktif, terkumpul ${rupiah(r.tujuan.terkumpul_minor)} dari ${rupiah(r.tujuan.target_minor)}.` : 'Setoran bersih ke rekening tabungan pada rentang ini.'} />
                  </div>

                  {r.anggaran.jumlah > 0 && (
                    <section className="kartu kartu-besar">
                      <p className="tanya">Anggaranku</p>
                      <p className="penjelas">{r.anggaran.aman} aman · {r.anggaran.berisiko} hati-hati · {r.anggaran.lewat} lewat batas</p>
                      {r.anggaran.keseluruhan && <div style={{ marginTop: 12 }}><MeterAnggaran b={r.anggaran.keseluruhan} /></div>}
                      <a className="tautan-kartu" href="#/anggaran">Lihat semua anggaran →</a>
                    </section>
                  )}

                  <section className="kartu kartu-besar">
                    <p className="tanya">Yang menarik dari datamu</p>
                    {a.insight.length === 0 ? (
                      <p className="penjelas">Belum ada kesimpulan. Kesimpulan hanya muncul bila angkanya cukup, dan selalu dihitung dari transaksi — bukan ditebak.</p>
                    ) : (
                      <ul className="insight">
                        {a.insight.map((i) => (
                          <li key={i.kunci}>
                            <span className="ikon-i" aria-hidden="true">{i.tingkat === 'perhatian' ? '⚠️' : i.tingkat === 'baik' ? '🎉' : '💡'}</span>
                            <div>
                              {i.teks}
                              {i.rincian && (
                                <div>
                                  <button onClick={() => mulai('Di balik angka ini', i.rincian!.kategori_id ? `kategori=${i.rincian!.kategori_id}` : i.rincian!.merchant_id ? `merchant=${i.rincian!.merchant_id}` : i.rincian!.tanpa_kategori ? 'tanpa_kategori=1' : '')}>Lihat transaksinya</button>
                                </div>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <details className="kartu kartu-besar">
                    <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Apa bedanya angka-angka ini?</summary>
                    <ul style={{ paddingLeft: 18, lineHeight: 1.6 }}>
                      <li><b>Pengeluaran pribadiku</b>: yang memang jadi bebanku. Makan bersama Rp120.000 di mana aku hanya menanggung Rp30.000 dihitung <b>Rp30.000</b>.</li>
                      <li><b>Uang yang keluar dari rekening</b>: seluruhnya, yaitu <b>Rp120.000</b>. Sisanya adalah piutang yang akan kembali.</li>
                      <li><b>Tabungan</b> dan <b>perpindahan antar rekeningku</b> bukan pengeluaran dan bukan pemasukan.</li>
                      <li><b>Refund</b> mengurangi pengeluaran, bukan menambah pemasukan. <b>Uang kembali dari teman</b> mengurangi piutang.</li>
                      <li>Biaya yang <b>dibayar langsung company</b> tidak menyentuh uangku.</li>
                    </ul>
                  </details>
                </div>
              )}

              {tab === 'Kategori' && (
                <section className="kartu kartu-besar">
                  <p className="tanya">Uangku dipakai buat apa?</p>
                  {kategoriBaris.length === 0 ? (
                    <Kosong ikon="🧾" judul="Belum ada pengeluaran" pesan="Tidak ada pengeluaran pribadi pada rentang ini." />
                  ) : (
                    <>
                      <p className="kartu-sub">Dari yang paling besar. Ketuk untuk melihat transaksinya; kategori induk bisa dibuka untuk melihat isinya.</p>
                      <BarisPeringkat baris={kategoriBaris} onPilih={(b) => mulai(b.nama, b.kunci === 'kosong' ? 'tanpa_kategori=1' : `kategori=${b.kunci}`)} />
                      {a.kategori.filter((c) => c.anak.length > 1).map((c) => (
                        <div key={c.category_id ?? 'x'} style={{ marginTop: 14 }}>
                          <button className="tombol tombol-kecil" aria-expanded={terbuka === String(c.category_id)} onClick={() => setTerbuka(terbuka === String(c.category_id) ? null : String(c.category_id))}>
                            {terbuka === String(c.category_id) ? '− ' : '＋ '}Isi {c.nama}
                          </button>
                          {terbuka === String(c.category_id) && (
                            <div style={{ marginTop: 8 }}>
                              <BarisPeringkat baris={c.anak.map((x) => ({ kunci: String(x.category_id ?? 'kosong'), ikon: x.ikon, nama: x.nama, nilai_minor: x.jumlah_minor, ket: <span>{x.jumlah_transaksi} transaksi</span> }))} onPilih={(b) => mulai(b.nama, b.kunci === 'kosong' ? 'tanpa_kategori=1' : `kategori=${b.kunci}`)} />
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </section>
              )}

              {tab === 'Tempat belanja' && (
                <div className="tumpuk">
                  <div className="dua-kolom">
                    <section className="kartu kartu-besar">
                      <p className="tanya">Paling sering kukunjungi</p>
                      {a.merchant.paling_sering.length === 0 ? <p className="penjelas">Belum ada data merchant.</p> : (
                        <BarisPeringkat
                          baris={a.merchant.paling_sering.map((m) => ({ kunci: String(m.merchant_id ?? m.nama), ikon: '🏪', nama: m.nama, nilai_minor: m.jumlah_transaksi, ket: <span>rata-rata {rupiah(m.rata_rata_minor)} per transaksi · total {rupiah(m.total_minor)}</span>, perubahan: m.sebelumnya_transaksi > 0 ? Math.round(((m.jumlah_transaksi - m.sebelumnya_transaksi) / m.sebelumnya_transaksi) * 100) : null }))}
                          satuan={(n) => `${n}×`}
                          onPilih={(b) => b.kunci && !Number.isNaN(Number(b.kunci)) && mulai(b.nama, `merchant=${b.kunci}`)}
                        />
                      )}
                    </section>
                    <section className="kartu kartu-besar">
                      <p className="tanya">Paling besar totalnya</p>
                      {a.merchant.paling_besar_total.length === 0 ? <p className="penjelas">Belum ada data merchant.</p> : (
                        <BarisPeringkat
                          baris={a.merchant.paling_besar_total.map((m) => ({ kunci: String(m.merchant_id ?? m.nama), ikon: '💳', nama: m.nama, nilai_minor: m.total_minor, ket: <span>{m.jumlah_transaksi} transaksi</span> }))}
                          onPilih={(b) => b.kunci && !Number.isNaN(Number(b.kunci)) && mulai(b.nama, `merchant=${b.kunci}`)}
                        />
                      )}
                    </section>
                  </div>
                  {a.merchant.kebiasaan_berubah.length > 0 && (
                    <section className="kartu kartu-besar">
                      <p className="tanya">Kebiasaan yang berubah</p>
                      <ul className="daftar">
                        {a.merchant.kebiasaan_berubah.map((m) => (
                          <li key={m.nama}><div className="isi"><b>{m.nama}</b><div className="kecil">{m.sebelumnya_transaksi}× sebelumnya → {m.jumlah_transaksi}× sekarang</div></div></li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {k.tanpa_merchant_jumlah > 0 && <Catatan>{k.tanpa_merchant_jumlah} transaksi tidak punya nama merchant, jadi tidak masuk peringkat ini (tetap dihitung di total).</Catatan>}
                  <Catatan>Merchant dengan nama yang hanya mirip tidak digabung otomatis. Kamu bisa menggabungkannya sendiri di <a href="#/kategori">Kategori & Merchant</a>.</Catatan>
                </div>
              )}

              {tab === 'Makanan' && (
                a.makanan.tersedia ? (
                  <div className="tumpuk">
                    <div className="tiga-kolom">
                      <Stat tanya="Total makan & minum" nilai={rupiah(a.makanan.total_minor)} chip={<Perubahan persen={a.makanan.perubahan_persen} />} ket={`${a.makanan.jumlah_transaksi} transaksi. Pembanding: ${rupiah(a.makanan.sebelumnya_total_minor)}.`} />
                      <Stat tanya="Rata-rata makan per hari" nilai={rupiah(a.makanan.rata_per_hari_minor)} ket={`Dihitung dari ${a.makanan.hari_berjalan} hari berjalan.`} />
                      <Stat tanya="Hari yang tercatat" nilai={`${a.makanan.hari_dengan_catatan} dari ${a.makanan.hari_berjalan}`} ket={a.makanan.hari_tanpa_catatan > 0 ? `${a.makanan.hari_tanpa_catatan} hari belum ada catatan makan, jadi rata-ratanya bisa lebih rendah dari kenyataan.` : 'Semua hari ada catatannya.'} />
                    </div>
                    {a.makanan.anggaran && <section className="kartu kartu-besar"><p className="tanya">Anggaran makan</p><MeterAnggaran b={a.makanan.anggaran} /></section>}
                    <div className="dua-kolom">
                      <section className="kartu kartu-besar">
                        <p className="tanya">Paling sering makan di</p>
                        {a.makanan.paling_sering.length === 0 ? <p className="penjelas">Belum ada data.</p> : <BarisPeringkat baris={a.makanan.paling_sering.map((m) => ({ kunci: String(m.merchant_id ?? m.nama), ikon: '🍽️', nama: m.nama, nilai_minor: m.jumlah_transaksi, ket: <span>total {rupiah(m.total_minor)}</span> }))} satuan={(n) => `${n}×`} onPilih={(b) => !Number.isNaN(Number(b.kunci)) && mulai(b.nama, `merchant=${b.kunci}&makanan=1`)} />}
                      </section>
                      <section className="kartu kartu-besar">
                        <p className="tanya">Paling banyak menghabiskan uang</p>
                        {a.makanan.paling_besar_total.length === 0 ? <p className="penjelas">Belum ada data.</p> : <BarisPeringkat baris={a.makanan.paling_besar_total.map((m) => ({ kunci: String(m.merchant_id ?? m.nama), ikon: '💸', nama: m.nama, nilai_minor: m.total_minor, ket: <span>{m.jumlah_transaksi}×</span> }))} onPilih={(b) => !Number.isNaN(Number(b.kunci)) && mulai(b.nama, `merchant=${b.kunci}&makanan=1`)} />}
                      </section>
                    </div>
                    <div className="dua-kolom">
                      <section className="kartu kartu-besar">
                        <p className="tanya">Transaksi makan termahal</p>
                        {a.makanan.transaksi_termahal.length === 0 ? <p className="penjelas">Belum ada data.</p> : (
                          <ul className="daftar">
                            {a.makanan.transaksi_termahal.map((t) => (
                              <li key={t.cash_event_id}><div className="isi"><b>{t.merchant}</b><div className="kecil">{tanggal(t.tanggal)}</div></div><div className="nilai">{rupiah(t.jumlah_minor)}</div></li>
                            ))}
                          </ul>
                        )}
                      </section>
                      <section className="kartu kartu-besar">
                        <p className="tanya">Pengeluaran makan 6 bulan terakhir</p>
                        <KolomBatang judul="Pengeluaran makan per bulan" data={a.makanan.tren_bulanan.map((m, i, arr) => ({ kunci: m.bulan, label: m.label.split(' ')[0]!.slice(0, 3), nilai: m.total_minor, sorot: i === arr.length - 1 }))} />
                        <p className="penjelas">Batang berwarna = bulan terakhir pada rentang.</p>
                      </section>
                    </div>
                  </div>
                ) : <Kosong ikon="🍚" judul="Kategori makanan tidak tersedia" pesan={a.makanan.alasan ?? 'Aktifkan kategori Makan di Kategori & Merchant.'} />
              )}

              {tab === 'Tren' && (
                <div className="tumpuk">
                  <section className="kartu kartu-besar">
                    <p className="tanya">Masuk dan keluar dari waktu ke waktu</p>
                    <GarisTren titik={a.tren.titik} granularitas={a.tren.granularitas} />
                  </section>
                  <div className="dua-kolom">
                    <section className="kartu kartu-besar">
                      <p className="tanya">Rutin atau sesuka hati?</p>
                      <BarisPeringkat
                        baris={[
                          { kunci: 'berulang', ikon: '🔁', nama: 'Langganan & tagihan rutin', nilai_minor: a.berulang_vs_sesuka.berulang_minor, ket: <span>{a.berulang_vs_sesuka.persen_berulang}% dari pengeluaran</span> },
                          { kunci: 'sesuka', ikon: '🛍️', nama: 'Sisanya (sesuka hati)', nilai_minor: a.berulang_vs_sesuka.sesuka_minor, jenis: 'netral' },
                        ]}
                        onPilih={(b) => mulai(b.nama, `jenis=${b.kunci}`)}
                      />
                    </section>
                    <section className="kartu kartu-besar">
                      <p className="tanya">Pengeluaran yang tidak biasa</p>
                      {a.tidak_biasa.length === 0 ? <p className="penjelas">Tidak ada yang mencolok. Penilaian ini butuh minimal 5 transaksi pembanding per kategori dalam 90 hari sebelumnya.</p> : (
                        <ul className="daftar">
                          {a.tidak_biasa.map((t) => <li key={t.cash_event_id}><div className="isi"><b>{t.merchant}</b><div className="kecil">{t.alasan}</div></div><div className="nilai">{rupiah(t.jumlah_minor)}</div></li>)}
                        </ul>
                      )}
                    </section>
                  </div>
                </div>
              )}

              {tab === 'Langganan' && (
                <div className="tumpuk">
                  <div className="tiga-kolom">
                    <Stat tanya="Langganan pribadi per bulan" nilai={rupiah(a.langganan.total_bulanan_pribadi_minor)} ket={`${a.langganan.jumlah_aktif} layanan aktif. Tahunan dibagi 12.`} />
                    <Stat tanya="Langganan company per bulan" nilai={rupiah(a.langganan.total_bulanan_company_minor)} ket="Tidak memotong uangku bila company yang membayar." />
                    <Stat tanya="Belum diketahui nominalnya" nilai={`${a.langganan.tanpa_nominal} layanan`} ket={a.langganan.tanpa_nominal ? 'Totalnya belum lengkap.' : 'Semua punya nominal.'} />
                  </div>
                  <div className="dua-kolom">
                    <section className="kartu kartu-besar">
                      <p className="tanya">Per jenis</p>
                      {a.langganan.per_jenis.length === 0 ? <p className="penjelas">Belum ada langganan pribadi dengan nominal.</p> : <BarisPeringkat baris={a.langganan.per_jenis.map((j) => ({ kunci: j.jenis, ikon: '📦', nama: j.jenis, nilai_minor: j.bulanan_minor, ket: <span>{j.jumlah} layanan per bulan</span> }))} />}
                    </section>
                    <section className="kartu kartu-besar">
                      <p className="tanya">Akan ditagih</p>
                      {a.langganan.akan_ditagih.length === 0 ? <p className="penjelas">Belum ada tanggal tagihan yang terkonfirmasi.</p> : (
                        <ul className="daftar">
                          {a.langganan.akan_ditagih.map((s) => <li key={s.service_id}><div className="isi"><b>{s.nama}</b><div className="kecil">{s.tanggal ? tanggal(s.tanggal) : '-'} · {s.penanggung}</div></div><div className="nilai">{rupiah(s.nominal_minor)}</div></li>)}
                        </ul>
                      )}
                    </section>
                  </div>
                  {a.langganan.kenaikan_biaya.length > 0 && (
                    <section className="kartu kartu-besar">
                      <p className="tanya">Biaya yang naik</p>
                      <ul className="daftar">
                        {a.langganan.kenaikan_biaya.map((s) => <li key={s.service_id}><div className="isi"><b>{s.nama}</b><div className="kecil">{rupiah(s.dari_minor)} → {rupiah(s.ke_minor)}</div></div><div className="nilai">▲ {s.persen}%</div></li>)}
                      </ul>
                    </section>
                  )}
                  {a.langganan.mungkin_tidak_dibutuhkan.length > 0 && (
                    <section className="kartu kartu-besar">
                      <p className="tanya">Mungkin sudah tidak dibutuhkan?</p>
                      <Catatan peringatan>Ini hanya petunjuk dari pola pembayaran, bukan bukti layanan tidak dipakai.</Catatan>
                      <ul className="daftar" style={{ marginTop: 8 }}>
                        {a.langganan.mungkin_tidak_dibutuhkan.map((s) => <li key={s.service_id}><div className="isi"><b>{s.nama}</b><div className="kecil">{s.alasan}</div></div></li>)}
                      </ul>
                    </section>
                  )}
                </div>
              )}

              {rincian && <PanelRincian spek={rincian} dari={a.rentang.dari} sampai={a.rentang.sampai} tutup={() => setRincian(null)} />}
            </>
          );
        }}
      </Wadah>
    </>
  );
}
