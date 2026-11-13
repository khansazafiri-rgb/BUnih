import { useState } from 'react';
import { api, type Tujuan as DataTujuan } from '../api';
import { bacaRupiah, rupiah, tanggal } from '../format';
import { Catatan, Kosong, useApi, Wadah } from '../components/dasar';
import { Celengan } from '../components/viz';
import { umumkanPerubahan } from '../components/FormCatat';

const IKON = ['🐷', '💻', '✈️', '🎓', '🛡️', '🏠', '🚗', '📱', '🎁', '💍'];
const LABEL_RISIKO: Record<string, { ikon: string; teks: string; kelas: string }> = {
  tercapai: { ikon: '🎉', teks: 'Tercapai', kelas: 'ls-aman' },
  tepat: { ikon: '✔', teks: 'Sesuai jalur', kelas: 'ls-aman' },
  berisiko: { ikon: '▲', teks: 'Berisiko telat', kelas: 'ls-berisiko' },
  terlambat: { ikon: '■', teks: 'Lewat tanggal', kelas: 'ls-lewat' },
  belum_ada_setoran: { ikon: '○', teks: 'Belum ada setoran', kelas: 'ls-berisiko' },
  tanpa_tanggal: { ikon: '○', teks: 'Tanpa tenggat', kelas: 'ls-netral' },
  dijeda: { ikon: '⏸', teks: 'Dijeda', kelas: 'ls-netral' },
  dibatalkan: { ikon: '✕', teks: 'Dibatalkan', kelas: 'ls-netral' },
};

type Setoran = { id: number; waktu: string; occurred_at: string; amount_minor: number; merchant_raw: string | null };

function KartuTujuan({ g, muat }: { g: DataTujuan; muat: () => void }) {
  const [buka, setBuka] = useState(false);
  const [nominal, setNominal] = useState('');
  const [mode, setMode] = useState<'disisihkan' | 'transfer_tercatat'>('disisihkan');
  const [transfer, setTransfer] = useState('');
  const [galat, setGalat] = useState<string | null>(null);
  const setoranAda = useApi(() => (buka && mode === 'transfer_tercatat' ? api.get<{ daftar: Setoran[] }>('/transaksi?jenis=setoran_tabungan&batas=20') : Promise.resolve({ daftar: [] as Setoran[] })), [buka, mode]);
  const r = LABEL_RISIKO[g.risiko]!;

  const sisih = async () => {
    setGalat(null);
    try {
      if (mode === 'disisihkan') {
        const n = bacaRupiah(nominal);
        if (!n) return setGalat('Isi nominalnya, misalnya 500rb.');
        await api.post(`/tujuan/${g.id}/setoran`, { amount_minor: n, kind: 'disisihkan' });
      } else {
        const t = setoranAda.data?.daftar.find((x) => String(x.id) === transfer);
        if (!t) return setGalat('Pilih transfer tabungan yang ingin dihitung.');
        await api.post(`/tujuan/${g.id}/setoran`, { amount_minor: t.amount_minor, kind: 'transfer_tercatat', cash_event_id: t.id });
      }
      umumkanPerubahan('Tersimpan ✔');
      setNominal('');
      setBuka(false);
    } catch (e) {
      setGalat(e instanceof Error ? e.message : 'Gagal.');
    }
  };
  const ubahStatus = async (status: string) => {
    await api.patch(`/tujuan/${g.id}`, { status });
    umumkanPerubahan('Status diperbarui.');
    muat();
  };

  return (
    <section className="kartu kartu-besar">
      <div className="tujuan-baris">
        <Celengan persen={g.persen} ikon={g.ikon ?? '🐷'} ukuran={86} />
        <div>
          <p className="tujuan-nama">{g.nama}</p>
          <p className="tujuan-angka"><b>{rupiah(g.terkumpul_minor)}</b> dari {rupiah(g.target_minor)}</p>
          <span className={`lencana-status ${r.kelas}`} style={{ marginTop: 6 }}><span aria-hidden="true">{r.ikon}</span>{r.teks}</span>
        </div>
      </div>
      <p className="tujuan-tegas" style={{ fontSize: 15.5 }}>{g.penjelasan}</p>
      <ul className="daftar" style={{ marginTop: 8 }}>
        <li><div className="isi">Masih kurang</div><div className="nilai">{rupiah(g.sisa_minor)}</div></li>
        {g.target_date && <li><div className="isi">Tenggat</div><div className="nilai">{tanggal(g.target_date)}{g.hari_tersisa !== null && g.hari_tersisa > 0 ? ` (${g.hari_tersisa} hari)` : ''}</div></li>}
        {g.perlu_per_bulan_minor !== null && <li><div className="isi">Perlu disetor per bulan</div><div className="nilai">{rupiah(g.perlu_per_bulan_minor)}</div></li>}
        {g.perlu_per_minggu_minor !== null && <li><div className="isi">atau per minggu</div><div className="nilai">{rupiah(g.perlu_per_minggu_minor)}</div></li>}
        <li><div className="isi">Laju menabungmu (90 hari)</div><div className="nilai">{rupiah(g.laju_bulanan_minor)}/bln</div></li>
        <li><div className="isi">Dari transfer tabungan tercatat</div><div className="nilai">{rupiah(g.dari_transfer_tercatat_minor)}</div></li>
        <li><div className="isi">Hanya disisihkan (penanda)</div><div className="nilai">{rupiah(g.disisihkan_minor)}</div></li>
      </ul>
      {g.rekening_nama && <p className="kecil">Rekening terkait: {g.rekening_nama}</p>}
      {g.status !== 'dibatalkan' && (
        <div className="tombol-baris" style={{ marginTop: 10 }}>
          <button className="tombol tombol-utama tombol-kecil" onClick={() => setBuka(!buka)} aria-expanded={buka}>＋ Sisihkan uang</button>
          {g.status === 'aktif' && <button className="tombol tombol-kecil" onClick={() => void ubahStatus('dijeda')}>Jeda</button>}
          {g.status === 'dijeda' && <button className="tombol tombol-kecil" onClick={() => void ubahStatus('aktif')}>Lanjutkan</button>}
          <button className="tombol tombol-kecil" onClick={() => { if (window.confirm(`Batalkan tujuan "${g.nama}"?`)) void ubahStatus('dibatalkan'); }}>Batalkan</button>
        </div>
      )}
      {buka && (
        <div style={{ marginTop: 12 }}>
          <div className="pilihan-grid" style={{ marginBottom: 10 }}>
            <label className="opsi"><input type="radio" checked={mode === 'disisihkan'} onChange={() => setMode('disisihkan')} /><span>Tandai uang yang kusisihkan<small>Hanya penanda. Uangnya tetap di rekening asalnya; tidak ada uang yang berpindah.</small></span></label>
            <label className="opsi"><input type="radio" checked={mode === 'transfer_tercatat'} onChange={() => setMode('transfer_tercatat')} /><span>Hitung transfer tabungan yang sudah ada<small>Menunjuk transfer sungguhan ke rekening tabunganmu.</small></span></label>
          </div>
          {mode === 'disisihkan' ? (
            <div className="bidang"><label htmlFor={`sn-${g.id}`}>Berapa?</label><input id={`sn-${g.id}`} inputMode="decimal" placeholder="500rb (negatif untuk mengambil kembali)" value={nominal} onChange={(e) => setNominal(e.target.value)} /></div>
          ) : (
            <div className="bidang">
              <label htmlFor={`st-${g.id}`}>Pilih transfer</label>
              <select id={`st-${g.id}`} value={transfer} onChange={(e) => setTransfer(e.target.value)}>
                <option value="">Pilih…</option>
                {(setoranAda.data?.daftar ?? []).map((s) => <option key={s.id} value={s.id}>{tanggal(s.occurred_at)} · {rupiah(s.amount_minor)}</option>)}
              </select>
            </div>
          )}
          {galat && <div className="galat" role="alert" style={{ marginBottom: 8 }}>{galat}</div>}
          <button className="tombol tombol-utama tombol-kecil" onClick={() => void sisih()}>Simpan</button>
        </div>
      )}
    </section>
  );
}

function FormBaru({ selesai }: { selesai: () => void }) {
  const [nama, setNama] = useState('');
  const [target, setTarget] = useState('');
  const [awal, setAwal] = useState('');
  const [tgl, setTgl] = useState('');
  const [ikon, setIkon] = useState('🐷');
  const [pengingat, setPengingat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);

  const simpan = async () => {
    setGalat(null);
    const t = bacaRupiah(target);
    if (!nama.trim()) return setGalat('Beri nama tujuannya, misalnya Laptop.');
    if (!t) return setGalat('Isi targetnya, misalnya 5jt.');
    try {
      await api.post('/tujuan', { name: nama.trim(), target_minor: t, start_minor: awal ? (bacaRupiah(awal) ?? 0) : 0, target_date: tgl || null, icon: ikon, reminder: pengingat });
      umumkanPerubahan('Tujuan dibuat ✔');
      setNama(''); setTarget(''); setAwal(''); setTgl('');
      selesai();
    } catch (e) {
      setGalat(e instanceof Error ? e.message : 'Gagal.');
    }
  };

  return (
    <section className="kartu kartu-besar">
      <h2 className="kartu-judul-besar">Buat tujuan baru</h2>
      <p className="kartu-sub">Contoh: laptop Rp5.000.000, dana darurat, liburan, uang kuliah.</p>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang"><label htmlFor="tj-nama">Namanya</label><input id="tj-nama" value={nama} onChange={(e) => setNama(e.target.value)} placeholder="Laptop" /></div>
        <div className="bidang"><label htmlFor="tj-target">Targetnya berapa?</label><input id="tj-target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="5jt" /></div>
      </div>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang"><label htmlFor="tj-awal">Sudah terkumpul (opsional)</label><input id="tj-awal" inputMode="decimal" value={awal} onChange={(e) => setAwal(e.target.value)} placeholder="0" /></div>
        <div className="bidang"><label htmlFor="tj-tgl">Ingin tercapai tanggal (opsional)</label><input id="tj-tgl" type="date" value={tgl} onChange={(e) => setTgl(e.target.value)} /></div>
      </div>
      <div className="bidang">
        <label>Gambar</label>
        <div className="renteng">{IKON.map((i) => <button key={i} type="button" className="tombol tombol-kecil" aria-pressed={ikon === i} onClick={() => setIkon(i)} style={ikon === i ? { borderColor: 'var(--seri-1)', background: 'var(--tint-biru)' } : undefined}>{i}</button>)}</div>
      </div>
      <label className="opsi" style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600, marginBottom: 12 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={pengingat} onChange={(e) => setPengingat(e.target.checked)} /> Ingatkan lewat Telegram bila berisiko tidak tercapai
      </label>
      {galat && <div className="galat" role="alert" style={{ marginBottom: 10 }}>{galat}</div>}
      <button className="tombol tombol-utama" style={{ minHeight: 48 }} onClick={() => void simpan()}>Simpan tujuan</button>
    </section>
  );
}

export default function Tujuan() {
  const daftar = useApi(() => api.get<DataTujuan[]>('/tujuan'), []);
  return (
    <>
      <h1>Tujuan Keuangan</h1>
      <p className="subjudul">Tabung untuk apa saja, sebanyak apa pun. Setiap tujuan dihitung sendiri.</p>
      <Catatan>Menyisihkan uang untuk sebuah tujuan <b>hanya penanda</b>. Uangmu tidak berpindah dan tidak ada transaksi yang dibuat. Perpindahan uang sungguhan ke rekening tabungan dicatat terpisah, dan bisa kamu hitung ke tujuan di sini.</Catatan>
      <div style={{ height: 14 }} />
      <Wadah keadaan={daftar}>
        {(d) => (
          <div className="tumpuk">
            {d.length === 0 ? <Kosong ikon="🐷" judul="Belum ada tujuan" pesan="Buat tujuan pertamamu di bawah." /> : <div className="dua-kolom">{d.map((g) => <KartuTujuan key={g.id} g={g} muat={daftar.muatUlang} />)}</div>}
            <FormBaru selesai={daftar.muatUlang} />
          </div>
        )}
      </Wadah>
    </>
  );
}
