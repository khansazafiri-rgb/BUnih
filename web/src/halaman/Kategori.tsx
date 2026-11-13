import { useState } from 'react';
import { api, type KategoriFlat, type KategoriNode, type MerchantRingkas } from '../api';
import { rupiah, tanggal } from '../format';
import { Catatan, Kosong, useApi, Wadah } from '../components/dasar';
import { umumkanPerubahan } from '../components/FormCatat';

const IKON = ['🍽️', '🛒', '🚌', '🏠', '💡', '📱', '🎬', '👕', '💊', '🎓', '🎁', '🐾', '☕', '🧾', '💼', '✈️'];

function pesanGalat(e: unknown): string {
  return e instanceof Error ? e.message : 'Gagal.';
}

/* ----------------------------------------------------------------- kategori */

function BarisKategori({ k, tingkat, muat, semua }: { k: KategoriNode; tingkat: number; muat: () => void; semua: KategoriFlat[] }) {
  const [ubah, setUbah] = useState(false);
  const [nama, setNama] = useState(k.name);
  const [ikon, setIkon] = useState(k.icon ?? '');
  const [anak, setAnak] = useState(false);
  const [namaAnak, setNamaAnak] = useState('');
  const [galat, setGalat] = useState<string | null>(null);

  const simpan = async () => {
    setGalat(null);
    try {
      await api.patch(`/kategori/${k.id}`, { name: nama.trim(), icon: ikon || null });
      umumkanPerubahan('Kategori diperbarui ✔');
      setUbah(false);
    } catch (e) {
      setGalat(pesanGalat(e));
    }
  };
  const tambahAnak = async () => {
    setGalat(null);
    try {
      await api.post('/kategori', { name: namaAnak.trim(), parent_id: k.id, group_name: k.group_name });
      umumkanPerubahan('Subkategori ditambahkan ✔');
      setNamaAnak('');
      setAnak(false);
    } catch (e) {
      setGalat(pesanGalat(e));
    }
  };
  const nonaktif = async () => {
    const pesan = k.jumlah_transaksi > 0
      ? `Nonaktifkan "${k.name}"? ${k.jumlah_transaksi} transaksi lama tetap tersimpan dengan kategori ini.`
      : `Nonaktifkan "${k.name}"?`;
    if (!window.confirm(pesan)) return;
    try {
      await api.del(`/kategori/${k.id}`);
      umumkanPerubahan('Kategori dinonaktifkan.');
    } catch (e) {
      setGalat(pesanGalat(e));
    }
  };
  const aktifkan = async () => {
    await api.patch(`/kategori/${k.id}`, { active: true });
    umumkanPerubahan('Kategori diaktifkan lagi.');
  };

  void semua;
  return (
    <>
      <li style={{ paddingLeft: tingkat * 22 }}>
        <div className="isi">
          <span aria-hidden="true" style={{ marginRight: 8 }}>{k.icon ?? '•'}</span>
          <b style={{ opacity: k.active ? 1 : 0.55 }}>{k.name}</b>
          {!k.active && <span className="chip" style={{ marginLeft: 8 }}>nonaktif</span>}
          <span className="kecil" style={{ marginLeft: 8 }}>{k.jumlah_transaksi} transaksi</span>
        </div>
        <div className="tombol-baris">
          <button className="tombol tombol-kecil" onClick={() => setUbah(!ubah)} aria-expanded={ubah}>Ubah</button>
          {tingkat === 0 && k.active && <button className="tombol tombol-kecil" onClick={() => setAnak(!anak)} aria-expanded={anak}>＋ Sub</button>}
          {k.active ? <button className="tombol tombol-kecil" onClick={() => void nonaktif()}>Nonaktifkan</button> : <button className="tombol tombol-kecil" onClick={() => void aktifkan()}>Aktifkan</button>}
        </div>
      </li>
      {ubah && (
        <li style={{ paddingLeft: tingkat * 22 }}>
          <div style={{ width: '100%' }}>
            <div className="bidang"><label htmlFor={`kn-${k.id}`}>Nama</label><input id={`kn-${k.id}`} value={nama} onChange={(e) => setNama(e.target.value)} /></div>
            <div className="renteng" style={{ marginBottom: 10 }}>
              {IKON.map((i) => <button key={i} type="button" className="tombol tombol-kecil" aria-pressed={ikon === i} onClick={() => setIkon(i)} style={ikon === i ? { borderColor: 'var(--seri-1)', background: 'var(--tint-biru)' } : undefined}>{i}</button>)}
            </div>
            {galat && <div className="galat" role="alert" style={{ marginBottom: 8 }}>{galat}</div>}
            <button className="tombol tombol-utama tombol-kecil" onClick={() => void simpan()}>Simpan</button>
          </div>
        </li>
      )}
      {anak && (
        <li style={{ paddingLeft: tingkat * 22 }}>
          <div style={{ width: '100%' }}>
            <div className="bidang"><label htmlFor={`ka-${k.id}`}>Nama subkategori di bawah “{k.name}”</label><input id={`ka-${k.id}`} value={namaAnak} onChange={(e) => setNamaAnak(e.target.value)} placeholder="mis. Makan siang kampus" /></div>
            {galat && <div className="galat" role="alert" style={{ marginBottom: 8 }}>{galat}</div>}
            <button className="tombol tombol-utama tombol-kecil" onClick={() => void tambahAnak()}>Tambah</button>
          </div>
        </li>
      )}
      {k.anak.map((a) => <BarisKategori key={a.id} k={a} tingkat={tingkat + 1} muat={muat} semua={semua} />)}
    </>
  );
}

function TabKategori() {
  const [semua, setSemua] = useState(false);
  const pohon = useApi(() => api.get<KategoriNode[]>(`/kategori/pohon${semua ? '?semua=1' : ''}`), [semua]);
  const flat = useApi(() => api.get<KategoriFlat[]>('/kategori?semua=1'), []);
  const [nama, setNama] = useState('');
  const [induk, setInduk] = useState('');
  const [ikon, setIkon] = useState('');
  const [galat, setGalat] = useState<string | null>(null);

  const tambah = async () => {
    setGalat(null);
    try {
      await api.post('/kategori', { name: nama.trim(), parent_id: induk ? Number(induk) : null, icon: ikon || null });
      umumkanPerubahan('Kategori ditambahkan ✔');
      setNama('');
      setIkon('');
    } catch (e) {
      setGalat(pesanGalat(e));
    }
  };

  return (
    <div className="tumpuk">
      <Catatan>Kategori bisa kamu buat dan ubah sendiri. Menonaktifkan kategori <b>tidak menghapus</b> transaksi lama. Mengganti nama otomatis ikut ke semua laporan, anggaran, dan grafik.</Catatan>
      <Wadah keadaan={pohon}>
        {(d) => (
          <section className="kartu kartu-besar">
            {d.length === 0 ? <Kosong ikon="🏷️" judul="Belum ada kategori" pesan="Tambahkan satu di bawah." /> : (
              <ul className="daftar">{d.map((k) => <BarisKategori key={k.id} k={k} tingkat={0} muat={pohon.muatUlang} semua={flat.data ?? []} />)}</ul>
            )}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600, marginTop: 12 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={semua} onChange={(e) => setSemua(e.target.checked)} /> Tampilkan yang nonaktif
            </label>
          </section>
        )}
      </Wadah>
      <section className="kartu kartu-besar">
        <h2 className="kartu-judul-besar">Tambah kategori</h2>
        <div className="bidang-baris bidang-baris-2">
          <div className="bidang"><label htmlFor="kt-nama">Nama</label><input id="kt-nama" value={nama} onChange={(e) => setNama(e.target.value)} placeholder="mis. Kopi, Kos, Hobi" /></div>
          <div className="bidang">
            <label htmlFor="kt-induk">Di bawah (opsional)</label>
            <select id="kt-induk" value={induk} onChange={(e) => setInduk(e.target.value)}>
              <option value="">Kategori utama</option>
              {(flat.data ?? []).filter((k) => k.parent_id === null && k.active).map((k) => <option key={k.id} value={k.id}>{k.icon ?? '•'} {k.name}</option>)}
            </select>
          </div>
        </div>
        <div className="renteng" style={{ marginBottom: 12 }}>
          {IKON.map((i) => <button key={i} type="button" className="tombol tombol-kecil" aria-pressed={ikon === i} onClick={() => setIkon(ikon === i ? '' : i)} style={ikon === i ? { borderColor: 'var(--seri-1)', background: 'var(--tint-biru)' } : undefined}>{i}</button>)}
        </div>
        {galat && <div className="galat" role="alert" style={{ marginBottom: 10 }}>{galat}</div>}
        <button className="tombol tombol-utama" style={{ minHeight: 48 }} onClick={() => void tambah()}>Tambah kategori</button>
      </section>
    </div>
  );
}

/* ----------------------------------------------------------------- merchant */

function KartuMerchant({ m, kats, daftar, muat }: { m: MerchantRingkas; kats: KategoriFlat[]; daftar: MerchantRingkas[]; muat: () => void }) {
  const [buka, setBuka] = useState(false);
  const [nama, setNama] = useState(m.name);
  const [alias, setAlias] = useState('');
  const [gabung, setGabung] = useState('');
  const [galat, setGalat] = useState<string | null>(null);

  const jalankan = async (fn: () => Promise<unknown>, ok: string) => {
    setGalat(null);
    try {
      await fn();
      umumkanPerubahan(ok);
      muat();
    } catch (e) {
      setGalat(pesanGalat(e));
    }
  };

  return (
    <li style={{ display: 'block' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="isi">
          <b>{m.name}</b>
          <div className="kecil">
            {m.jumlah_transaksi} transaksi · {rupiah(m.total_pengeluaran_minor)}
            {m.terakhir ? ` · terakhir ${tanggal(m.terakhir)}` : ''}
            {m.kategori_bawaan ? ` · otomatis: ${m.kategori_bawaan}` : ''}
          </div>
        </div>
        <button className="tombol tombol-kecil" onClick={() => setBuka(!buka)} aria-expanded={buka}>{buka ? 'Tutup' : 'Atur'}</button>
      </div>
      {buka && (
        <div style={{ marginTop: 10 }}>
          <div className="bidang-baris bidang-baris-2">
            <div className="bidang">
              <label htmlFor={`mn-${m.id}`}>Nama tampilan</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input id={`mn-${m.id}`} value={nama} onChange={(e) => setNama(e.target.value)} />
                <button className="tombol tombol-kecil" onClick={() => void jalankan(() => api.patch(`/merchant/${m.id}`, { name: nama.trim() }), 'Nama diperbarui ✔')}>Simpan</button>
              </div>
            </div>
            <div className="bidang">
              <label htmlFor={`mk-${m.id}`}>Kategori otomatis untuk tempat ini</label>
              <select id={`mk-${m.id}`} value={m.default_category_id ?? ''} onChange={(e) => void jalankan(() => api.patch(`/merchant/${m.id}`, { default_category_id: e.target.value ? Number(e.target.value) : null }), 'Kategori otomatis disimpan ✔')}>
                <option value="">Tanpa (tanya saya)</option>
                {kats.filter((k) => k.active).map((k) => <option key={k.id} value={k.id}>{k.icon ?? '•'} {k.name}</option>)}
              </select>
            </div>
          </div>
          <div className="bidang">
            <label htmlFor={`ma-${m.id}`}>Nama lain yang sama dengan tempat ini</label>
            {m.alias.length > 0 && (
              <div className="renteng" style={{ marginBottom: 8 }}>
                {m.alias.map((a) => (
                  <span key={a.id} className="chip">
                    {a.alias_raw ?? '(tanpa nama)'}{' '}
                    <button type="button" aria-label={`Hapus alias ${a.alias_raw ?? ''}`} style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit' }} onClick={() => void jalankan(() => api.del(`/merchant/alias/${a.id}`), 'Alias dihapus.')}>✕</button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input id={`ma-${m.id}`} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="mis. GRAB*FOOD 123" />
              <button className="tombol tombol-kecil" onClick={() => void jalankan(async () => { await api.post(`/merchant/${m.id}/alias`, { alias: alias.trim() }); setAlias(''); }, 'Alias ditambahkan ✔')}>Tambah</button>
            </div>
            <p className="kecil" style={{ marginTop: 4 }}>Transaksi berikutnya dengan nama ini otomatis digabung ke “{m.name}”.</p>
          </div>
          <div className="bidang">
            <label htmlFor={`mg-${m.id}`}>Gabungkan tempat lain ke sini</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select id={`mg-${m.id}`} value={gabung} onChange={(e) => setGabung(e.target.value)}>
                <option value="">Pilih tempat yang duplikat…</option>
                {daftar.filter((x) => x.id !== m.id).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.jumlah_transaksi})</option>)}
              </select>
              <button className="tombol tombol-kecil" disabled={!gabung} onClick={() => { if (window.confirm('Gabungkan? Semua transaksi tempat itu dipindah ke sini.')) void jalankan(async () => { await api.post(`/merchant/${m.id}/gabung`, { dari: Number(gabung) }); setGabung(''); }, 'Digabung ✔'); }}>Gabung</button>
            </div>
          </div>
          {galat && <div className="galat" role="alert">{galat}</div>}
        </div>
      )}
    </li>
  );
}

function TabMerchant() {
  const [cari, setCari] = useState('');
  const daftar = useApi(() => api.get<MerchantRingkas[]>(`/merchant${cari ? `?cari=${encodeURIComponent(cari)}` : ''}`), [cari]);
  const kats = useApi(() => api.get<KategoriFlat[]>('/kategori'), []);
  return (
    <div className="tumpuk">
      <Catatan>Satu tempat belanja bisa punya banyak nama di struk atau mutasi bank. Dengan <b>alias</b>, semuanya digabung jadi satu, sehingga analisis “paling sering belanja di mana” jadi benar.</Catatan>
      <div className="bidang"><label htmlFor="mc-cari">Cari tempat</label><input id="mc-cari" type="search" value={cari} onChange={(e) => setCari(e.target.value)} placeholder="Ketik nama…" /></div>
      <Wadah keadaan={daftar}>
        {(d) => d.length === 0 ? <Kosong ikon="🏪" judul="Belum ada tempat belanja" pesan="Tempat belanja muncul otomatis saat kamu mencatat transaksi." /> : (
          <section className="kartu kartu-besar"><ul className="daftar">{d.map((m) => <KartuMerchant key={m.id} m={m} kats={kats.data ?? []} daftar={d} muat={daftar.muatUlang} />)}</ul></section>
        )}
      </Wadah>
    </div>
  );
}

export default function Kategori() {
  const [tab, setTab] = useState<'kategori' | 'merchant'>('kategori');
  return (
    <>
      <h1>Kategori &amp; Tempat Belanja</h1>
      <p className="subjudul">Atur sendiri cara BUnih mengelompokkan uangmu.</p>
      <div className="tab" role="tablist">
        <button role="tab" aria-selected={tab === 'kategori'} onClick={() => setTab('kategori')}>Kategori</button>
        <button role="tab" aria-selected={tab === 'merchant'} onClick={() => setTab('merchant')}>Tempat belanja</button>
      </div>
      <div style={{ height: 14 }} />
      {tab === 'kategori' ? <TabKategori /> : <TabMerchant />}
    </>
  );
}
