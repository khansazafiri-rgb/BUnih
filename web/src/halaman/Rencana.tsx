import { useState } from 'react';
import { api, type HasilSimulasi, type SkenarioRingkas } from '../api';
import { bacaRupiah, LABEL_KEPASTIAN, rupiah, tanggal } from '../format';
import { Catatan, Kartu, useApi, Wadah } from '../components/dasar';

type Asumsi = {
  sekarang: Array<{ key: string; value: unknown; certainty: string; source: string; effective_from: string; note: string | null }>;
  kunci_dikenal: string[];
};

type SkenarioBanding = SkenarioRingkas & {
  slug: string;
  deskripsi: string | null;
  cadangan_minimal_minor: number;
  kekurangan_agar_tidak_defisit_minor: number;
  kekurangan_agar_cadangan_aman_minor: number;
  total_tagihan_minor: number;
  total_biaya_company_minor: number;
  asumsi_dipakai: Array<{ key: string; value: unknown; certainty: string; dari_skenario: boolean }>;
};

const JUDUL_ASUMSI: Record<string, string> = {
  anggaran_makan_harian: 'Anggaran makan per hari',
  cadangan_minimal: 'Cadangan minimal',
  topup_nominal: 'Nominal top-up',
  topup_interval_hari: 'Interval top-up (hari)',
  topup_mulai: 'Tanggal top-up pertama',
  periode_mulai: 'Tanggal awal periode',
  periode_panjang_hari: 'Panjang periode (hari)',
  target_tabungan_bulanan: 'Target tabungan per bulan',
  reimburse_lag_hari: 'Perkiraan jeda reimburse (hari)',
  saldo_awal_sheet: 'Saldo awal dari Sheet',
};

const JENIS_TANGGAL = new Set(['topup_mulai', 'periode_mulai']);

function FormAsumsi({ onSimpan }: { onSimpan: () => void }) {
  const [kunci, setKunci] = useState('anggaran_makan_harian');
  const [nilai, setNilai] = useState('');
  const [catatan, setCatatan] = useState('');
  const [sibuk, setSibuk] = useState(false);
  const [pesan, setPesan] = useState<string | null>(null);
  const tanggalMode = JENIS_TANGGAL.has(kunci);

  const simpan = async () => {
    setSibuk(true);
    setPesan(null);
    try {
      const value = tanggalMode ? nilai : bacaRupiah(nilai);
      if (value === null || value === '') throw new Error('Nilai belum valid.');
      await api.post('/asumsi', {
        key: kunci,
        value,
        certainty: 'terverifikasi',
        note: catatan || `Dikonfirmasi lewat web pada ${new Date().toISOString().slice(0, 10)}.`,
      });
      setPesan('Tersimpan. Versi lama tetap tercatat di riwayat.');
      setNilai('');
      setCatatan('');
      onSimpan();
    } catch (err) {
      setPesan(err instanceof Error ? err.message : 'Gagal menyimpan.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <Kartu judul="Ubah asumsi">
      <Catatan>
        Mengubah asumsi berlaku mulai hari ini. Versi lama disimpan, jadi laporan historis tidak
        berubah diam-diam.
      </Catatan>
      <div className="bidang" style={{ marginTop: 10 }}>
        <label htmlFor="a-kunci">Pengaturan</label>
        <select id="a-kunci" value={kunci} onChange={(e) => setKunci(e.target.value)}>
          {Object.keys(JUDUL_ASUMSI).map((k) => (
            <option key={k} value={k}>
              {JUDUL_ASUMSI[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="bidang">
        <label htmlFor="a-nilai">Nilai {tanggalMode ? '(tanggal)' : '(mis. 30rb, 350000, 5)'}</label>
        <input
          id="a-nilai"
          type={tanggalMode ? 'date' : 'text'}
          value={nilai}
          onChange={(e) => setNilai(e.target.value)}
          placeholder={tanggalMode ? '' : '30rb'}
        />
      </div>
      <div className="bidang">
        <label htmlFor="a-catatan">Catatan (opsional)</label>
        <input id="a-catatan" value={catatan} onChange={(e) => setCatatan(e.target.value)} />
      </div>
      {pesan && <Catatan>{pesan}</Catatan>}
      <button className="tombol tombol-utama" disabled={sibuk || !nilai} onClick={() => void simpan()}>
        Simpan asumsi
      </button>
    </Kartu>
  );
}

function BolehBeli() {
  const hariIni = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [label, setLabel] = useState('');
  const [harga, setHarga] = useState('');
  const [hargaTidakTahu, setHargaTidakTahu] = useState(false);
  const [tgl, setTgl] = useState(hariIni);
  const [jenis, setJenis] = useState<'pribadi' | 'hadiah' | 'talangan' | 'company' | 'bersama'>('pribadi');
  const [kembali, setKembali] = useState('');
  const [bisaDitunda, setBisaDitunda] = useState(true);
  const [hasil, setHasil] = useState<HasilSimulasi | null>(null);
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const kirim = async () => {
    setSibuk(true);
    setGalat(null);
    try {
      const h = await api.post<HasilSimulasi>('/simulasi', {
        label: label || 'Pembelian baru',
        harga_minor: hargaTidakTahu ? null : bacaRupiah(harga),
        tanggal: tgl,
        jenis,
        bagian_kembali_minor: kembali ? bacaRupiah(kembali) : null,
        bisa_ditunda: bisaDitunda,
      });
      setHasil(h);
    } catch (err) {
      setGalat(err instanceof Error ? err.message : 'Gagal menghitung.');
    } finally {
      setSibuk(false);
    }
  };

  const warna =
    hasil?.verdict === 'aman'
      ? 'status-aman'
      : hasil?.verdict === 'tidak_aman'
        ? 'status-defisit'
        : 'status-rendah';
  const ikon =
    hasil?.verdict === 'aman' ? '✔' : hasil?.verdict === 'tidak_aman' ? '■' : hasil?.verdict === 'hati_hati' ? '▲' : '?';
  const teks =
    hasil?.verdict === 'aman'
      ? 'AMAN'
      : hasil?.verdict === 'tidak_aman'
        ? 'TIDAK AMAN'
        : hasil?.verdict === 'hati_hati'
          ? 'HATI-HATI'
          : 'BELUM PASTI';

  return (
    <Kartu judul="Bolehkah aku beli ini?">
      <div className="bidang">
        <label htmlFor="s-label">Barang / biaya</label>
        <input id="s-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="mis. keyboard" />
      </div>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang">
          <label htmlFor="s-harga">Harga</label>
          <input
            id="s-harga"
            value={harga}
            onChange={(e) => setHarga(e.target.value)}
            placeholder="350rb"
            disabled={hargaTidakTahu}
          />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 7, fontWeight: 500 }}>
            <input
              type="checkbox"
              checked={hargaTidakTahu}
              onChange={(e) => setHargaTidakTahu(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Harga belum diketahui
          </label>
        </div>
        <div className="bidang">
          <label htmlFor="s-tgl">Tanggal beli</label>
          <input id="s-tgl" type="date" value={tgl} onChange={(e) => setTgl(e.target.value)} />
        </div>
      </div>
      <div className="bidang">
        <label htmlFor="s-jenis">Jenis</label>
        <select id="s-jenis" value={jenis} onChange={(e) => setJenis(e.target.value as typeof jenis)}>
          <option value="pribadi">Pengeluaran pribadi</option>
          <option value="hadiah">Hadiah (tetap biaya pribadiku)</option>
          <option value="talangan">Talangan (akan dibayar kembali)</option>
          <option value="company">Biaya company</option>
          <option value="bersama">Pembayaran bersama</option>
        </select>
      </div>
      {jenis !== 'pribadi' && jenis !== 'hadiah' && (
        <div className="bidang">
          <label htmlFor="s-kembali">Bagian yang akan kembali ke aku</label>
          <input id="s-kembali" value={kembali} onChange={(e) => setKembali(e.target.value)} placeholder="mis. 90rb" />
        </div>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontWeight: 500 }}>
        <input
          type="checkbox"
          checked={bisaDitunda}
          onChange={(e) => setBisaDitunda(e.target.checked)}
          style={{ width: 'auto' }}
        />
        Pembelian ini bisa ditunda
      </label>
      <button className="tombol tombol-utama" disabled={sibuk} onClick={() => void kirim()}>
        Hitung dampaknya
      </button>

      {galat && <Catatan peringatan>{galat}</Catatan>}

      {hasil && (
        <div style={{ marginTop: 16 }}>
          <div className="renteng" style={{ marginBottom: 8 }}>
            <span className={`status ${warna}`}>
              <span aria-hidden="true">{ikon}</span>
              {teks}
            </span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>{hasil.jawaban}</div>
          <ul className="daftar">
            <li>
              <div className="isi">Saldo terendah sebelum</div>
              <div className="nilai">{rupiah(hasil.sebelum.saldo_terendah_minor)}</div>
            </li>
            <li>
              <div className="isi">Saldo terendah sesudah</div>
              <div className="nilai">{rupiah(hasil.sesudah.saldo_terendah_minor)}</div>
            </li>
            <li>
              <div className="isi">Cadangan minimal</div>
              <div className="nilai">{rupiah(hasil.sesudah.cadangan_minimal_minor)}</div>
            </li>
            {hasil.dampak.saldo_terendah_sebelum_topup_minor !== null && (
              <li>
                <div className="isi">
                  Saldo terendah sebelum top-up
                  <div className="kecil">
                    top-up berikutnya {tanggal(hasil.dampak.tanggal_topup_berikutnya)}
                  </div>
                </div>
                <div className="nilai">{rupiah(hasil.dampak.saldo_terendah_sebelum_topup_minor)}</div>
              </li>
            )}
            {hasil.dampak.piutang_bertambah_minor > 0 && (
              <li>
                <div className="isi">Piutang bertambah</div>
                <div className="nilai">{rupiah(hasil.dampak.piutang_bertambah_minor)}</div>
              </li>
            )}
            {hasil.dampak.tagihan_terdekat && (
              <li>
                <div className="isi">
                  Tagihan terdekat: {hasil.dampak.tagihan_terdekat.label}
                  <div className="kecil">
                    {tanggal(hasil.dampak.tagihan_terdekat.tanggal)} ·{' '}
                    {hasil.dampak.tagihan_masih_aman === null
                      ? 'belum dapat dinilai'
                      : hasil.dampak.tagihan_masih_aman
                        ? 'masih bisa dibayar'
                        : 'berisiko tidak terbayar'}
                  </div>
                </div>
                <div className="nilai">{rupiah(hasil.dampak.tagihan_terdekat.nominal_minor)}</div>
              </li>
            )}
          </ul>
          {hasil.ketidakpastian.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="angka-ket" style={{ marginBottom: 6 }}>
                Yang belum pasti
              </div>
              {hasil.ketidakpastian.map((k, i) => (
                <Catatan peringatan key={i}>
                  {k.pesan}
                </Catatan>
              ))}
            </div>
          )}
          {hasil.saran.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {hasil.saran.map((s, i) => (
                <Catatan key={i}>{s}</Catatan>
              ))}
            </div>
          )}
        </div>
      )}
    </Kartu>
  );
}

export default function Rencana() {
  const [nonce, setNonce] = useState(0);
  const asumsi = useApi(() => api.get<Asumsi>('/asumsi'), [nonce]);
  const banding = useApi(() => api.get<SkenarioBanding[]>('/skenario/banding'), [nonce]);

  return (
    <>
      <h1>Proyeksi &amp; Simulasi</h1>
      <p className="subjudul">
        Atur asumsi, bandingkan skenario, dan hitung dampak pembelian sebelum membelinya.
      </p>

      <div className="petak petak-2">
        <Kartu judul="Asumsi yang dipakai sekarang">
          <Wadah keadaan={asumsi}>
            {(d) => (
              <ul className="daftar">
                {d.sekarang.map((a) => (
                  <li key={a.key}>
                    <div className="isi">
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{JUDUL_ASUMSI[a.key] ?? a.key}</div>
                      <div className="renteng kecil">
                        <span className={`chip ${a.certainty === 'terverifikasi' ? 'chip-aktual' : a.certainty === 'asumsi_sheet' ? 'chip-perkiraan' : 'chip-perkiraan'}`}>
                          {LABEL_KEPASTIAN[a.certainty] ?? a.certainty}
                        </span>
                        <span>berlaku sejak {tanggal(a.effective_from)}</span>
                      </div>
                      {a.note && <div className="kecil">{a.note}</div>}
                    </div>
                    <div className="nilai">
                      {typeof a.value === 'number' && a.value > 100 ? rupiah(a.value) : String(a.value)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Wadah>
        </Kartu>

        <FormAsumsi onSimpan={() => setNonce((n) => n + 1)} />
      </div>

      <h2>Perbandingan skenario</h2>
      <Wadah keadaan={banding}>
        {(d) => (
          <div className="petak petak-2">
            {d.map((s, i) => (
              <Kartu key={s.slug} judul={s.nama}>
                <div className="renteng" style={{ marginBottom: 8 }}>
                  <i
                    aria-hidden="true"
                    style={{
                      width: 14,
                      height: 3,
                      borderRadius: 2,
                      background: i === 0 ? 'var(--seri-1)' : 'var(--seri-2)',
                      display: 'inline-block',
                    }}
                  />
                  {s.deskripsi && <span className="kecil">{s.deskripsi}</span>}
                </div>
                <div className="angka-sedang tab-num">{rupiah(s.saldo_terendah_minor)}</div>
                <div className="kecil" style={{ marginBottom: 10 }}>
                  saldo terendah, pada {tanggal(s.saldo_terendah_tanggal)}
                </div>
                <ul className="daftar">
                  <li>
                    <div className="isi">Saldo akhir rentang</div>
                    <div className="nilai">{rupiah(s.saldo_akhir_minor)}</div>
                  </li>
                  <li>
                    <div className="isi">Tanggal defisit</div>
                    <div className="nilai">{s.tanggal_defisit ? tanggal(s.tanggal_defisit) : 'tidak ada'}</div>
                  </li>
                  <li>
                    <div className="isi">Tambahan agar tidak defisit</div>
                    <div className="nilai">{rupiah(s.kekurangan_agar_tidak_defisit_minor)}</div>
                  </li>
                  <li>
                    <div className="isi">Tambahan agar cadangan aman</div>
                    <div className="nilai">{rupiah(s.kekurangan_agar_cadangan_aman_minor)}</div>
                  </li>
                  <li>
                    <div className="isi">Total tagihan (dibayar sendiri)</div>
                    <div className="nilai">{rupiah(s.total_tagihan_minor)}</div>
                  </li>
                  <li>
                    <div className="isi">
                      Biaya company
                      <div className="kecil">tidak memotong saldoku</div>
                    </div>
                    <div className="nilai">{rupiah(s.total_biaya_company_minor)}</div>
                  </li>
                </ul>
                <div style={{ marginTop: 10 }}>
                  <div className="angka-ket" style={{ marginBottom: 4 }}>
                    Asumsi yang membentuk hasil ini
                  </div>
                  <div className="renteng">
                    {s.asumsi_dipakai.map((a) => (
                      <span className="chip" key={a.key}>
                        {JUDUL_ASUMSI[a.key] ?? a.key}: {String(a.value)}
                        {a.dari_skenario ? ' (skenario)' : ''}
                      </span>
                    ))}
                  </div>
                </div>
              </Kartu>
            ))}
          </div>
        )}
      </Wadah>

      <h2>Bolehkah aku beli ini?</h2>
      <BolehBeli />
    </>
  );
}
