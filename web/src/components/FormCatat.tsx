import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type KategoriFlat } from '../api';
import { bacaRupiah, rupiah } from '../format';

type Jenis = 'pengeluaran' | 'pemasukan' | 'transfer_sendiri' | 'refund';
type Penanggung = 'saya' | 'hadiah' | 'company_bayar_dulu' | 'company_langsung' | 'patungan';

type Rekening = { id: number; name: string; last4: string | null; is_savings_target: number; is_mine: number };
type Piutang = { id: number; debtor_name: string | null; debtor_type: string; sisa_minor: number };

const sekarangLokal = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 16);

export function bukaCatat(awal?: Partial<{ jenis: Jenis }>) {
  window.dispatchEvent(new CustomEvent('bunih:catat', { detail: awal ?? {} }));
}

export function umumkanPerubahan(pesan?: string) {
  window.dispatchEvent(new CustomEvent('bunih:diubah'));
  if (pesan) window.dispatchEvent(new CustomEvent('bunih:toast', { detail: pesan }));
}

const JENIS: Array<{ id: Jenis; e: string; nama: string }> = [
  { id: 'pengeluaran', e: '💸', nama: 'Keluar' },
  { id: 'pemasukan', e: '💰', nama: 'Masuk' },
  { id: 'transfer_sendiri', e: '🔁', nama: 'Pindah' },
  { id: 'refund', e: '↩️', nama: 'Refund' },
];

const PENANGGUNG: Array<{ id: Penanggung; nama: string; ket: string }> = [
  { id: 'saya', nama: 'Saya sendiri', ket: 'Pengeluaran pribadiku.' },
  { id: 'hadiah', nama: 'Hadiah untuk orang lain', ket: 'Tetap biayaku, bukan piutang.' },
  { id: 'company_bayar_dulu', nama: 'Saya bayar dulu, company yang ganti', ket: 'Saldoku turun sampai reimburse masuk.' },
  { id: 'company_langsung', nama: 'Company yang bayar langsung', ket: 'Saldoku tidak berubah.' },
  { id: 'patungan', nama: 'Patungan atau talangan', ket: 'Dibagi dengan orang lain yang akan mengganti.' },
];

export default function FormCatat() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [jenis, setJenis] = useState<Jenis>('pengeluaran');
  const [nominal, setNominal] = useState('');
  const [merchant, setMerchant] = useState('');
  const [kategori, setKategori] = useState('');
  const [rekening, setRekening] = useState('');
  const [tujuan, setTujuan] = useState('');
  const [waktu, setWaktu] = useState(sekarangLokal());
  const [penanggung, setPenanggung] = useState<Penanggung>('saya');
  const [bagianSaya, setBagianSaya] = useState('');
  const [orang, setOrang] = useState<Array<{ nama: string; jumlah: string }>>([{ nama: '', jumlah: '' }]);
  const [pecah, setPecah] = useState(false);
  const [potongan, setPotongan] = useState<Array<{ kategori: string; jumlah: string }>>([{ kategori: '', jumlah: '' }, { kategori: '', jumlah: '' }]);
  const [proyek, setProyek] = useState('');
  const [catatan, setCatatan] = useState('');
  const [piutang, setPiutang] = useState('');
  const [lanjut, setLanjut] = useState(false);
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const [akun, setAkun] = useState<Rekening[]>([]);
  const [kats, setKats] = useState<KategoriFlat[]>([]);
  const [saran, setSaran] = useState<Array<{ id: number; name: string }>>([]);
  const [piutangAda, setPiutangAda] = useState<Piutang[]>([]);

  const reset = (j: Jenis = 'pengeluaran') => {
    setJenis(j);
    setNominal('');
    setMerchant('');
    setKategori('');
    setTujuan('');
    setWaktu(sekarangLokal());
    setPenanggung('saya');
    setBagianSaya('');
    setOrang([{ nama: '', jumlah: '' }]);
    setPecah(false);
    setPotongan([{ kategori: '', jumlah: '' }, { kategori: '', jumlah: '' }]);
    setProyek('');
    setCatatan('');
    setPiutang('');
    setLanjut(false);
    setGalat(null);
  };

  useEffect(() => {
    const buka = (e: Event) => {
      const awal = (e as CustomEvent).detail as { jenis?: Jenis };
      reset(awal?.jenis ?? 'pengeluaran');
      Promise.all([
        api.get<{ daftar: Rekening[] }>('/rekening'),
        api.get<KategoriFlat[]>('/kategori'),
        api.get<Array<{ id: number; name: string }>>('/merchant/saran'),
        api.get<{ daftar: Piutang[] }>('/reimburse'),
      ])
        .then(([r, k, m, p]) => {
          const mine = r.daftar.filter((a) => a.is_mine);
          setAkun(mine);
          setRekening((cur) => cur || String(mine.find((a) => !a.is_savings_target)?.id ?? mine[0]?.id ?? ''));
          setKats(k);
          setSaran(m);
          setPiutangAda(p.daftar.filter((x) => x.sisa_minor > 0));
        })
        .catch(() => undefined);
      dialog.current?.showModal();
    };
    window.addEventListener('bunih:catat', buka);
    return () => window.removeEventListener('bunih:catat', buka);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = bacaRupiah(nominal) ?? 0;
  const totalOrang = orang.reduce((s, o) => s + (bacaRupiah(o.jumlah) ?? 0), 0);
  const bagianAuto = total - totalOrang;
  const totalPotongan = potongan.reduce((s, p) => s + (bacaRupiah(p.jumlah) ?? 0), 0);
  const selisihPotongan = total - totalPotongan;
  const akunTabungan = akun.filter((a) => a.is_savings_target);

  const kategoriPilihan = useMemo(() => {
    const peta = new Map(kats.map((k) => [k.id, k]));
    return kats.map((k) => ({ ...k, label: `${k.icon ?? '•'} ${k.parent_id && peta.get(k.parent_id) ? `${peta.get(k.parent_id)!.name} › ` : ''}${k.name}` }));
  }, [kats]);

  const kirim = async (lagi: boolean) => {
    setGalat(null);
    if (total <= 0) {
      setGalat('Isi nominalnya dulu, misalnya 25rb atau 150000.');
      return;
    }
    const badan: Record<string, unknown> = { jenis, jumlah_minor: total, waktu };
    if (jenis === 'transfer_sendiri') {
      badan['rekening_id'] = Number(rekening) || null;
      badan['tujuan_rekening_id'] = Number(tujuan) || null;
      if (!rekening || !tujuan) return setGalat('Pilih rekening asal dan tujuan.');
    } else {
      if (rekening === 'tunai') badan['tunai'] = true;
      else badan['rekening_id'] = Number(rekening) || null;
      badan['merchant'] = merchant.trim() || null;
      badan['kategori_id'] = kategori ? Number(kategori) : null;
    }
    if (jenis === 'pengeluaran') {
      if (penanggung === 'patungan') {
        const isi = orang.filter((o) => o.nama.trim() && (bacaRupiah(o.jumlah) ?? 0) > 0);
        if (!isi.length) return setGalat('Isi nama dan nominal orang yang akan mengganti.');
        if (bagianAuto < 0) return setGalat('Total bagian orang lain melebihi nominal transaksi.');
        badan['orang'] = isi.map((o) => ({ nama: o.nama.trim(), jumlah_minor: bacaRupiah(o.jumlah) ?? 0 }));
        badan['bagian_saya_minor'] = bagianAuto;
      } else {
        badan['penanggung'] = penanggung;
        if (penanggung === 'company_bayar_dulu' && bagianSaya) badan['bagian_saya_minor'] = bacaRupiah(bagianSaya) ?? 0;
        if (pecah) {
          const isi = potongan.filter((p) => (bacaRupiah(p.jumlah) ?? 0) > 0);
          if (selisihPotongan !== 0) return setGalat(`Jumlah pecahan harus sama dengan nominal. Selisih sekarang ${rupiah(selisihPotongan)}.`);
          badan['pembagian_kategori'] = isi.map((p) => ({ kategori_id: p.kategori ? Number(p.kategori) : null, jumlah_minor: bacaRupiah(p.jumlah) ?? 0 }));
        }
      }
    }
    if (jenis === 'pemasukan' && piutang) badan['melunasi_piutang_id'] = Number(piutang);
    if (proyek.trim()) badan['proyek'] = proyek.trim();
    if (catatan.trim()) badan['catatan'] = catatan.trim();

    setSibuk(true);
    try {
      const hasil = await api.post<{ pesan: string[]; dibuat: boolean }>('/transaksi/baru', badan);
      umumkanPerubahan(hasil.dibuat ? 'Tersimpan ✔' : 'Sudah tercatat sebelumnya, tidak digandakan.');
      if (lagi) reset(jenis);
      else dialog.current?.close();
    } catch (err) {
      setGalat(err instanceof Error ? err.message : 'Gagal menyimpan.');
    } finally {
      setSibuk(false);
    }
  };

  const pilihRekening = (nilai: string, set: (v: string) => void, id: string, kosong?: string, tunai = true) => (
    <select id={id} value={nilai} onChange={(e) => set(e.target.value)}>
      {kosong && <option value="">{kosong}</option>}
      {akun.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}{a.last4 ? ` ••${a.last4}` : ''}
        </option>
      ))}
      {tunai && <option value="tunai">Tunai</option>}
    </select>
  );

  return (
    <dialog ref={dialog} className="form-catat" aria-label="Catat transaksi" onClose={() => setGalat(null)}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void kirim(false);
        }}
      >
        <div className="renteng" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>Catat</h2>
          <button type="button" className="tombol tombol-kecil" onClick={() => dialog.current?.close()}>Tutup</button>
        </div>

        <div className="jenis-pilihan" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }} role="group" aria-label="Jenis catatan">
          {JENIS.map((j) => (
            <button type="button" key={j.id} aria-pressed={jenis === j.id} onClick={() => setJenis(j.id)}>
              <span className="e" aria-hidden="true">{j.e}</span>
              {j.nama}
            </button>
          ))}
        </div>

        <div className="bidang">
          <label htmlFor="fc-nominal">Berapa?</label>
          <input id="fc-nominal" className="input-nominal" inputMode="decimal" autoComplete="off" placeholder="25rb" value={nominal} onChange={(e) => setNominal(e.target.value)} />
          {total > 0 && <div className="kecil" style={{ marginTop: 4 }}>= {rupiah(total)}</div>}
        </div>

        {jenis !== 'transfer_sendiri' && (
          <div className="bidang">
            <label htmlFor="fc-merchant">{jenis === 'pemasukan' ? 'Dari siapa?' : 'Di mana / untuk siapa?'}</label>
            <input id="fc-merchant" list="fc-saran" autoComplete="off" placeholder={jenis === 'pemasukan' ? 'mis. Klien freelance' : 'mis. Kantin kampus'} value={merchant} onChange={(e) => setMerchant(e.target.value)} />
            <datalist id="fc-saran">{saran.map((m) => <option key={m.id} value={m.name} />)}</datalist>
          </div>
        )}

        {(jenis === 'pengeluaran' || jenis === 'refund' || jenis === 'pemasukan') && !pecah && (
          <div className="bidang">
            <label htmlFor="fc-kat">Kategori</label>
            <select id="fc-kat" value={kategori} onChange={(e) => setKategori(e.target.value)}>
              <option value="">{jenis === 'pemasukan' ? '(tidak perlu)' : '(pakai kategori bawaan merchant, atau kosong)'}</option>
              {kategoriPilihan.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </div>
        )}

        {jenis === 'transfer_sendiri' ? (
          <div className="bidang-baris bidang-baris-2">
            <div className="bidang"><label htmlFor="fc-asal">Dari rekening</label>{pilihRekening(rekening, setRekening, 'fc-asal', undefined, false)}</div>
            <div className="bidang"><label htmlFor="fc-tuju">Ke rekening</label>{pilihRekening(tujuan, setTujuan, 'fc-tuju', 'Pilih…', false)}</div>
            {akunTabungan.length > 0 && <p className="kecil" style={{ gridColumn: '1 / -1', margin: 0 }}>Memindahkan uang ke rekening tabunganmu dicatat sebagai <b>setoran tabungan</b>: bukan pengeluaran, bukan pemasukan.</p>}
          </div>
        ) : (
          <div className="bidang-baris bidang-baris-2">
            <div className="bidang">
              <label htmlFor="fc-rek">{jenis === 'pemasukan' || jenis === 'refund' ? 'Masuk ke' : 'Bayar pakai'}</label>
              {penanggung === 'company_langsung' && jenis === 'pengeluaran' ? <input disabled value="Tidak lewat rekeningku" /> : pilihRekening(rekening, setRekening, 'fc-rek')}
            </div>
            <div className="bidang"><label htmlFor="fc-waktu">Kapan?</label><input id="fc-waktu" type="datetime-local" value={waktu} onChange={(e) => setWaktu(e.target.value)} /></div>
          </div>
        )}
        {jenis === 'transfer_sendiri' && <div className="bidang"><label htmlFor="fc-waktu2">Kapan?</label><input id="fc-waktu2" type="datetime-local" value={waktu} onChange={(e) => setWaktu(e.target.value)} /></div>}

        {jenis === 'pengeluaran' && (
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <legend style={{ fontSize: 13, fontWeight: 650, color: 'var(--ink-2)', marginBottom: 6 }}>Siapa yang menanggung?</legend>
            <div className="pilihan-grid">
              {PENANGGUNG.map((p) => (
                <label className="opsi" key={p.id}>
                  <input type="radio" name="penanggung" checked={penanggung === p.id} onChange={() => { setPenanggung(p.id); if (p.id === 'patungan') setPecah(false); }} />
                  <span>{p.nama}<small>{p.ket}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {jenis === 'pengeluaran' && penanggung === 'company_bayar_dulu' && (
          <div className="bidang"><label htmlFor="fc-bagian">Bagian yang memang punyaku (opsional)</label><input id="fc-bagian" placeholder="kosong = semuanya diganti company" value={bagianSaya} onChange={(e) => setBagianSaya(e.target.value)} /></div>
        )}

        {jenis === 'pengeluaran' && penanggung === 'patungan' && (
          <div className="bidang">
            <label>Siapa yang akan mengganti, dan berapa?</label>
            {orang.map((o, i) => (
              <div className="baris-orang" key={i}>
                <input aria-label={`Nama orang ${i + 1}`} placeholder="Nama" value={o.nama} onChange={(e) => setOrang(orang.map((x, j) => (j === i ? { ...x, nama: e.target.value } : x)))} />
                <input aria-label={`Nominal orang ${i + 1}`} placeholder="30rb" inputMode="decimal" value={o.jumlah} onChange={(e) => setOrang(orang.map((x, j) => (j === i ? { ...x, jumlah: e.target.value } : x)))} />
                <button type="button" className="tombol tombol-kecil" aria-label={`Hapus orang ${i + 1}`} onClick={() => setOrang(orang.length > 1 ? orang.filter((_, j) => j !== i) : orang)}>✕</button>
              </div>
            ))}
            <button type="button" className="tombol tombol-kecil" onClick={() => setOrang([...orang, { nama: '', jumlah: '' }])}>＋ Tambah orang</button>
            <div className={`catatan ${bagianAuto < 0 ? 'catatan-peringatan' : ''}`} style={{ marginTop: 10 }}>
              Bagianku: <b>{rupiah(bagianAuto)}</b> · yang akan kembali: <b>{rupiah(totalOrang)}</b> · uang keluar: <b>{rupiah(total)}</b>
            </div>
          </div>
        )}

        {jenis === 'pengeluaran' && penanggung !== 'patungan' && (
          <div className="bidang">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={pecah} onChange={(e) => setPecah(e.target.checked)} />
              Pecah ke beberapa kategori
            </label>
            {pecah && (
              <div style={{ marginTop: 8 }}>
                {potongan.map((p, i) => (
                  <div className="baris-orang" key={i}>
                    <select aria-label={`Kategori pecahan ${i + 1}`} value={p.kategori} onChange={(e) => setPotongan(potongan.map((x, j) => (j === i ? { ...x, kategori: e.target.value } : x)))}>
                      <option value="">(tanpa kategori)</option>
                      {kategoriPilihan.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                    </select>
                    <input aria-label={`Nominal pecahan ${i + 1}`} placeholder="60rb" inputMode="decimal" value={p.jumlah} onChange={(e) => setPotongan(potongan.map((x, j) => (j === i ? { ...x, jumlah: e.target.value } : x)))} />
                    <button type="button" className="tombol tombol-kecil" aria-label={`Hapus pecahan ${i + 1}`} onClick={() => setPotongan(potongan.length > 2 ? potongan.filter((_, j) => j !== i) : potongan)}>✕</button>
                  </div>
                ))}
                <button type="button" className="tombol tombol-kecil" onClick={() => setPotongan([...potongan, { kategori: '', jumlah: '' }])}>＋ Tambah pecahan</button>
                <div className={`catatan ${selisihPotongan !== 0 ? 'catatan-peringatan' : ''}`} style={{ marginTop: 10 }}>
                  {selisihPotongan === 0 ? 'Pas! Jumlah pecahan sama dengan nominal.' : `Belum pas: selisih ${rupiah(selisihPotongan)}.`}
                </div>
              </div>
            )}
          </div>
        )}

        {jenis === 'pemasukan' && piutangAda.length > 0 && (
          <div className="bidang">
            <label htmlFor="fc-piutang">Ini pelunasan piutang?</label>
            <select id="fc-piutang" value={piutang} onChange={(e) => setPiutang(e.target.value)}>
              <option value="">Bukan, ini pemasukan biasa</option>
              {piutangAda.map((p) => <option key={p.id} value={p.id}>Ya, dari {p.debtor_name ?? p.debtor_type} (sisa {rupiah(p.sisa_minor)})</option>)}
            </select>
            {piutang && <p className="kecil" style={{ margin: '4px 0 0' }}>Uang ini akan mengurangi piutang, bukan dihitung sebagai pendapatan baru.</p>}
          </div>
        )}

        <button type="button" className="tombol tombol-kecil" onClick={() => setLanjut(!lanjut)} aria-expanded={lanjut} style={{ marginBottom: 10 }}>
          {lanjut ? '− Sembunyikan' : '＋ Proyek & catatan'}
        </button>
        {lanjut && (
          <div className="bidang-baris bidang-baris-2">
            <div className="bidang"><label htmlFor="fc-proyek">Proyek (opsional)</label><input id="fc-proyek" placeholder="mis. MEDCOEL" value={proyek} onChange={(e) => setProyek(e.target.value)} /></div>
            <div className="bidang"><label htmlFor="fc-catatan">Catatan (opsional)</label><input id="fc-catatan" value={catatan} onChange={(e) => setCatatan(e.target.value)} /></div>
          </div>
        )}

        {galat && <div className="galat" role="alert" style={{ marginBottom: 10 }}>{galat}</div>}

        <div className="tombol-baris">
          <button type="submit" className="tombol tombol-utama" disabled={sibuk} style={{ flex: '1 1 160px', minHeight: 52, fontSize: 17 }}>Simpan</button>
          <button type="button" className="tombol" disabled={sibuk} onClick={() => void kirim(true)} style={{ minHeight: 52 }}>Simpan & catat lagi</button>
        </div>
      </form>
    </dialog>
  );
}
