import { useState } from 'react';
import { api, type Anggaran as DataAnggaran, type KategoriFlat } from '../api';
import { bacaRupiah, rupiah, tanggal } from '../format';
import { Catatan, Kosong, useApi, Wadah } from '../components/dasar';
import { KunciMeter, MeterAnggaran } from '../components/viz';
import { umumkanPerubahan } from '../components/FormCatat';

type Periode = 'harian' | 'mingguan' | 'bulanan' | 'kustom';

const CONTOH: Array<{ nama: string; slug: string; periode: Periode; nominal: string }> = [
  { nama: 'Makan', slug: 'makan', periode: 'bulanan', nominal: '900rb' },
  { nama: 'Transport', slug: 'transport', periode: 'bulanan', nominal: '300rb' },
  { nama: 'Langganan & software', slug: 'langganan-ai', periode: 'bulanan', nominal: '500rb' },
  { nama: 'Hiburan', slug: 'hiburan', periode: 'bulanan', nominal: '200rb' },
];

function FormBaru({ kats, selesai }: { kats: KategoriFlat[]; selesai: () => void }) {
  const [nama, setNama] = useState('');
  const [kategori, setKategori] = useState('');
  const [periode, setPeriode] = useState<Periode>('bulanan');
  const [nominal, setNominal] = useState('');
  const [mulai, setMulai] = useState(new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  const [akhir, setAkhir] = useState('');
  const [berulang, setBerulang] = useState(true);
  const [rollover, setRollover] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);

  const isiContoh = (c: (typeof CONTOH)[number]) => {
    setNama(c.nama);
    setKategori(String(kats.find((k) => k.slug === c.slug)?.id ?? ''));
    setPeriode(c.periode);
    setNominal(c.nominal);
  };

  const simpan = async () => {
    setGalat(null);
    const n = bacaRupiah(nominal);
    if (!n) return setGalat('Isi batasnya dulu, misalnya 900rb.');
    setSibuk(true);
    try {
      await api.post('/anggaran', {
        name: nama.trim() || 'Anggaran',
        category_id: kategori ? Number(kategori) : null,
        period: periode,
        amount_minor: n,
        start_date: mulai,
        end_date: periode === 'kustom' ? akhir || null : null,
        recurring: periode !== 'kustom' && berulang,
        rollover: periode !== 'kustom' && berulang && rollover,
      });
      umumkanPerubahan('Anggaran dibuat ✔');
      setNama('');
      setNominal('');
      selesai();
    } catch (e) {
      setGalat(e instanceof Error ? e.message : 'Gagal menyimpan.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <section className="kartu kartu-besar">
      <h2 className="kartu-judul-besar">Buat anggaran baru</h2>
      <p className="kartu-sub">Anggaran = batas uang untuk sesuatu. Pilih contoh di bawah, atau isi sendiri.</p>
      <div className="renteng" style={{ marginBottom: 12 }}>
        {CONTOH.map((c) => <button key={c.nama} type="button" className="tombol tombol-kecil" onClick={() => isiContoh(c)}>{c.nama} {c.nominal}/bln</button>)}
      </div>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang"><label htmlFor="ag-nama">Namanya</label><input id="ag-nama" value={nama} onChange={(e) => setNama(e.target.value)} placeholder="mis. Makan" /></div>
        <div className="bidang">
          <label htmlFor="ag-kat">Untuk kategori</label>
          <select id="ag-kat" value={kategori} onChange={(e) => setKategori(e.target.value)}>
            <option value="">Semua pengeluaran (batas keseluruhan)</option>
            {kats.map((k) => <option key={k.id} value={k.id}>{k.icon ?? '•'} {k.name}</option>)}
          </select>
        </div>
      </div>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang">
          <label htmlFor="ag-periode">Berlaku</label>
          <select id="ag-periode" value={periode} onChange={(e) => setPeriode(e.target.value as Periode)}>
            <option value="harian">Per hari</option>
            <option value="mingguan">Per pekan</option>
            <option value="bulanan">Per bulan</option>
            <option value="kustom">Rentang tanggal tertentu</option>
          </select>
        </div>
        <div className="bidang"><label htmlFor="ag-nominal">Batasnya berapa?</label><input id="ag-nominal" inputMode="decimal" placeholder="900rb" value={nominal} onChange={(e) => setNominal(e.target.value)} />{bacaRupiah(nominal) ? <div className="kecil" style={{ marginTop: 4 }}>= {rupiah(bacaRupiah(nominal)!)}</div> : null}</div>
      </div>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang"><label htmlFor="ag-mulai">Mulai</label><input id="ag-mulai" type="date" value={mulai} onChange={(e) => setMulai(e.target.value)} /></div>
        {periode === 'kustom' && <div className="bidang"><label htmlFor="ag-akhir">Sampai</label><input id="ag-akhir" type="date" value={akhir} onChange={(e) => setAkhir(e.target.value)} /></div>}
      </div>
      {periode !== 'kustom' && (
        <div className="pilihan-grid" style={{ marginBottom: 12 }}>
          <label className="opsi"><input type="checkbox" checked={berulang} onChange={(e) => setBerulang(e.target.checked)} /><span>Berulang tiap periode<small>Kalau dimatikan, anggaran ini hanya untuk satu periode.</small></span></label>
          {berulang && <label className="opsi"><input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} /><span>Bawa sisa ke periode berikutnya<small>Sisa yang tidak terpakai ditambahkan. Kelebihan tidak ikut dibawa.</small></span></label>}
        </div>
      )}
      {galat && <div className="galat" role="alert" style={{ marginBottom: 10 }}>{galat}</div>}
      <button className="tombol tombol-utama" style={{ minHeight: 48 }} disabled={sibuk} onClick={() => void simpan()}>Simpan anggaran</button>
    </section>
  );
}

function Kartu({ b, aksi }: { b: DataAnggaran; aksi: () => void }) {
  const [revisi, setRevisi] = useState(false);
  const [nominal, setNominal] = useState('');
  const [berlaku, setBerlaku] = useState(new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  const [galat, setGalat] = useState<string | null>(null);

  const ubah = async () => {
    const n = bacaRupiah(nominal);
    if (!n) return setGalat('Isi nominal baru.');
    try {
      await api.post(`/anggaran/${b.id}/revisi`, { amount_minor: n, effective_from: berlaku });
      umumkanPerubahan('Nominal diperbarui. Riwayat lama tetap tersimpan.');
      setRevisi(false);
      setNominal('');
    } catch (e) {
      setGalat(e instanceof Error ? e.message : 'Gagal.');
    }
  };
  const nonaktif = async () => {
    if (!window.confirm(`Nonaktifkan anggaran "${b.nama}"? Riwayatnya tetap tersimpan.`)) return;
    await api.del(`/anggaran/${b.id}`);
    umumkanPerubahan('Anggaran dinonaktifkan.');
    aksi();
  };

  return (
    <section className="kartu kartu-besar">
      <MeterAnggaran b={b} />
      <p className="kecil" style={{ marginTop: 10 }}>
        {b.periode === 'kustom' ? `${tanggal(b.jendela.dari)} – ${tanggal(b.jendela.sampai)}` : `Periode berjalan: ${tanggal(b.jendela.dari)} – ${tanggal(b.jendela.sampai)}`}
        {b.berulang ? ' · berulang' : ' · sekali'}
        {b.rollover ? ' · sisa dibawa' : ''}
      </p>
      <div className="tombol-baris" style={{ marginTop: 10 }}>
        <button className="tombol tombol-kecil" onClick={() => setRevisi(!revisi)} aria-expanded={revisi}>Ubah nominal</button>
        <button className="tombol tombol-kecil" onClick={() => { window.location.hash = `#/analitik?rincian=${b.kategori_id ? `kategori:${b.kategori_id}` : ''}`; }} disabled={!b.kategori_id}>Lihat transaksinya</button>
        <button className="tombol tombol-kecil" onClick={() => void nonaktif()}>Nonaktifkan</button>
      </div>
      {revisi && (
        <div style={{ marginTop: 12 }}>
          <Catatan>Nominal baru berlaku mulai tanggal yang kamu pilih. Periode yang sudah lewat tidak berubah.</Catatan>
          <div className="bidang-baris bidang-baris-2" style={{ marginTop: 8 }}>
            <div className="bidang"><label htmlFor={`rv-${b.id}`}>Batas baru</label><input id={`rv-${b.id}`} inputMode="decimal" placeholder="1jt" value={nominal} onChange={(e) => setNominal(e.target.value)} /></div>
            <div className="bidang"><label htmlFor={`rt-${b.id}`}>Berlaku mulai</label><input id={`rt-${b.id}`} type="date" value={berlaku} onChange={(e) => setBerlaku(e.target.value)} /></div>
          </div>
          {galat && <div className="galat" role="alert" style={{ marginBottom: 8 }}>{galat}</div>}
          <button className="tombol tombol-utama tombol-kecil" onClick={() => void ubah()}>Simpan nominal</button>
        </div>
      )}
    </section>
  );
}

export default function Anggaran() {
  const [semua, setSemua] = useState(false);
  const daftar = useApi(() => api.get<DataAnggaran[]>(`/anggaran${semua ? '?semua=1' : ''}`), [semua]);
  const kats = useApi(() => api.get<KategoriFlat[]>('/kategori'), []);

  return (
    <>
      <h1>Anggaran</h1>
      <p className="subjudul">Batas uang untuk apa saja — per hari, pekan, bulan, atau rentang tanggal yang kamu pilih.</p>

      <Wadah keadaan={daftar}>
        {(d) => (
          <div className="tumpuk">
            {d.length === 0 ? (
              <Kosong ikon="🎯" judul="Belum ada anggaran" pesan="Buat satu di bawah. Dengan anggaran, BUnih bisa memberi tahu berapa sisa dan kapan kamu harus mengerem." />
            ) : (
              <>
                <div className="dua-kolom">{d.map((b) => <Kartu key={b.id} b={b} aksi={daftar.muatUlang} />)}</div>
                <KunciMeter />
                <Catatan>
                  <b>Perkiraan</b> akhir periode adalah estimasi dari laju pemakaian sejauh ini, bukan pengeluaran yang sudah terjadi. Di awal periode, perkiraan sengaja tidak ditampilkan karena datanya belum cukup.
                </Catatan>
              </>
            )}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={semua} onChange={(e) => setSemua(e.target.checked)} /> Tampilkan yang dinonaktifkan
            </label>
            {kats.data && <FormBaru kats={kats.data} selesai={daftar.muatUlang} />}
          </div>
        )}
      </Wadah>
    </>
  );
}
