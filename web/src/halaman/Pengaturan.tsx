import { useState } from 'react';
import { api } from '../api';
import { bacaRupiah, rupiah, tanggal } from '../format';
import { Catatan, Kartu, useApi, Wadah } from '../components/dasar';
import type { RingkasanSaldo } from '../api';

type Rekening = {
  daftar: Array<{
    id: number;
    name: string;
    bank: string;
    last4: string | null;
    kind: string;
    is_mine: number;
    is_savings_target: number;
    verified: number;
    active: number;
    note: string | null;
  }>;
  saldo: RingkasanSaldo;
  rekonsiliasi: Array<{ account_id: number; name: string; last_reconciled_at: string | null; umur_hari: number | null }>;
};

type StatusGmail = {
  tersambung: boolean;
  email: string | null;
  scopes: string[];
  terhubung_pada: string | null;
  punya_refresh_token: boolean;
  oauth_siap: boolean;
  sinkronisasi: {
    sinkron_terakhir: string | null;
    sinkron_penuh_terakhir: string | null;
    error_terakhir: string | null;
    rentang_awal: string | null;
    sinkron_awal_selesai: boolean;
    jumlah_bukti: number;
    bukti_perlu_review: number;
  };
  kueri_bawaan: string;
  langkah: string[];
  catatan_keamanan: string;
};

type StatusTelegram = {
  mode: string;
  token_terpasang: boolean;
  chat_id_terpasang: boolean;
  langkah: string[];
};

type Notifikasi = Array<{ id: number; type: string; enabled: number; frequency: string }>;

const JUDUL_NOTIF: Record<string, string> = {
  transaksi_baru: 'Transaksi baru perlu dikategorikan',
  ringkasan_harian: 'Ringkasan harian',
  tagihan_mendekat: 'Tagihan mendekat',
  pembayaran_gagal: 'Pembayaran gagal',
  topup_belum_diterima: 'Top-up rencana belum dikonfirmasi',
  saldo_di_bawah_cadangan: 'Saldo turun di bawah cadangan minimal',
  reimburse_terlambat: 'Reimburse terlambat',
  langganan_tertagih_lagi: 'Langganan dibatalkan tapi tertagih lagi',
  pembelian_ganggu_tagihan: 'Pembelian mengganggu kemampuan bayar tagihan',
  sinkronisasi_gagal: 'Sinkronisasi Gmail gagal',
};

const TAB_SHEET = [
  ['PENGATURAN', 'PENGATURAN'],
  ['TOPUP', 'TOPUP'],
  ['BELANJA', 'BELANJA'],
  ['LANGGANAN', 'LANGGANAN'],
  ['ARUS_HARIAN', 'ARUS HARIAN (pembanding)'],
  ['PERIODE_5_HARI', 'PERIODE 5 HARI (pembanding)'],
  ['RINGKASAN', 'RINGKASAN (pembanding)'],
] as const;

function BagianRekening() {
  const [nonce, setNonce] = useState(0);
  const data = useApi(() => api.get<Rekening>('/rekening'), [nonce]);
  const [sibuk, setSibuk] = useState(false);
  const [saldoInput, setSaldoInput] = useState<Record<number, string>>({});
  const [last4, setLast4] = useState<Record<number, string>>({});
  const [pesan, setPesan] = useState<string | null>(null);

  const simpanLast4 = async (id: number) => {
    const v = (last4[id] ?? '').replace(/\D/g, '').slice(-4);
    if (v.length !== 4) {
      setPesan('Masukkan tepat 4 digit terakhir.');
      return;
    }
    setSibuk(true);
    try {
      await api.patch(`/rekening/${id}`, { last4: v, verified: true });
      setPesan('Rekening dikonfirmasi. Pencocokan email kini dapat memakai 4 digit ini.');
      setNonce((n) => n + 1);
    } finally {
      setSibuk(false);
    }
  };

  const simpanSaldo = async (id: number) => {
    const nominal = bacaRupiah(saldoInput[id] ?? '');
    if (nominal === null) {
      setPesan('Nominal saldo belum valid.');
      return;
    }
    setSibuk(true);
    try {
      await api.post('/rekonsiliasi', {
        account_id: id,
        as_of: `${new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)}T23:59:59+07:00`,
        statement_balance_minor: nominal,
        note: 'Saldo terkonfirmasi dimasukkan manual dari Pengaturan.',
      });
      setPesan(`Saldo terkonfirmasi ${rupiah(nominal)} dicatat sebagai titik tambat.`);
      setNonce((n) => n + 1);
    } finally {
      setSibuk(false);
    }
  };

  return (
    <Kartu judul="Rekening milikku">
      <Catatan>
        Hanya nama rekening dan 4 digit terakhir yang ditampilkan. Nomor rekening penuh tidak pernah
        disimpan maupun ditampilkan.
      </Catatan>
      {pesan && <Catatan>{pesan}</Catatan>}
      <Wadah keadaan={data}>
        {(d) => (
          <>
            <ul className="daftar" style={{ marginTop: 10 }}>
              {d.daftar.map((a) => {
                const rekon = d.rekonsiliasi.find((r) => r.account_id === a.id);
                const saldo = d.saldo.rekening.find((r) => r.account_id === a.id);
                return (
                  <li key={a.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div className="renteng" style={{ justifyContent: 'space-between' }}>
                      <div>
                        <strong>{a.name}</strong>
                        {a.last4 ? <span className="chip" style={{ marginLeft: 6 }}>••{a.last4}</span> : null}
                        {a.is_savings_target ? <span className="chip" style={{ marginLeft: 6 }}>tabungan</span> : null}
                        {!a.verified && <span className="chip chip-verifikasi" style={{ marginLeft: 6 }}>belum dikonfirmasi</span>}
                      </div>
                      <strong className="tab-num">
                        {saldo?.balance_minor === null || saldo === undefined
                          ? 'belum terverifikasi'
                          : rupiah(saldo.balance_minor)}
                      </strong>
                    </div>
                    <div className="kecil" style={{ marginTop: 4 }}>
                      {rekon?.last_reconciled_at
                        ? `Rekonsiliasi terakhir ${tanggal(rekon.last_reconciled_at)} (${rekon.umur_hari} hari lalu)`
                        : 'Belum pernah direkonsiliasi'}
                      {a.note ? ` · ${a.note}` : ''}
                    </div>

                    {!a.last4 && (
                      <div className="bidang-baris bidang-baris-2" style={{ marginTop: 8 }}>
                        <div className="bidang" style={{ marginBottom: 0 }}>
                          <label htmlFor={`l4-${a.id}`}>4 digit terakhir</label>
                          <input
                            id={`l4-${a.id}`}
                            value={last4[a.id] ?? ''}
                            onChange={(e) => setLast4({ ...last4, [a.id]: e.target.value })}
                            inputMode="numeric"
                            maxLength={4}
                            placeholder="1234"
                          />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                          <button className="tombol tombol-kecil" disabled={sibuk} onClick={() => void simpanLast4(a.id)}>
                            Konfirmasi rekening
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="bidang-baris bidang-baris-2" style={{ marginTop: 8 }}>
                      <div className="bidang" style={{ marginBottom: 0 }}>
                        <label htmlFor={`sal-${a.id}`}>Saldo terkonfirmasi hari ini</label>
                        <input
                          id={`sal-${a.id}`}
                          value={saldoInput[a.id] ?? ''}
                          onChange={(e) => setSaldoInput({ ...saldoInput, [a.id]: e.target.value })}
                          placeholder="mis. 200rb"
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                        <button className="tombol tombol-kecil" disabled={sibuk} onClick={() => void simpanSaldo(a.id)}>
                          Catat sebagai titik tambat
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Wadah>
    </Kartu>
  );
}

function BagianGmail() {
  const [nonce, setNonce] = useState(0);
  const data = useApi(() => api.get<StatusGmail>('/gmail/status'), [nonce]);
  const [sibuk, setSibuk] = useState(false);
  const [pesan, setPesan] = useState<string | null>(null);
  const hariIni = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [dari, setDari] = useState(`${hariIni.slice(0, 4)}-01-01`);

  const sambung = async () => {
    setSibuk(true);
    try {
      const { url } = await api.get<{ url: string }>('/gmail/mulai');
      window.location.href = url;
    } catch (err) {
      setPesan(err instanceof Error ? err.message : 'Gagal.');
      setSibuk(false);
    }
  };

  const sinkron = async (mode: 'historis' | 'berkelanjutan') => {
    setSibuk(true);
    setPesan(null);
    try {
      const hasil = await api.post<{ email_diproses: number; transaksi_dibuat: number; transaksi_digabung: number; invoice_disentuh: number; keputusan_dibuat: number; error: string | null }>(
        '/gmail/sinkron',
        mode === 'historis' ? { mode, dari } : { mode },
      );
      setPesan(
        hasil.error
          ? `Gagal: ${hasil.error}`
          : `${hasil.email_diproses} email diproses · ${hasil.transaksi_dibuat} transaksi baru · ` +
            `${hasil.transaksi_digabung} bukti digabung · ${hasil.invoice_disentuh} tagihan · ` +
            `${hasil.keputusan_dibuat} pertanyaan baru.`,
      );
      setNonce((n) => n + 1);
    } catch (err) {
      setPesan(err instanceof Error ? err.message : 'Gagal.');
    } finally {
      setSibuk(false);
    }
  };

  const cabut = async () => {
    if (!window.confirm('Cabut akses Gmail dan hapus token tersimpan?')) return;
    setSibuk(true);
    try {
      await api.post('/gmail/cabut');
      setPesan('Akses Gmail dicabut.');
      setNonce((n) => n + 1);
    } finally {
      setSibuk(false);
    }
  };

  return (
    <Kartu judul="Koneksi Gmail">
      <Wadah keadaan={data}>
        {(d) => (
          <>
            <Catatan>{d.catatan_keamanan}</Catatan>
            {!d.oauth_siap && (
              <Catatan peringatan>
                GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum diisi di server, jadi tombol sambung belum
                dapat dipakai.
              </Catatan>
            )}
            <div className="renteng" style={{ margin: '10px 0' }}>
              <span className={`chip ${d.tersambung ? 'chip-aktual' : 'chip-verifikasi'}`}>
                {d.tersambung ? `tersambung: ${d.email ?? 'akun tidak diketahui'}` : 'belum tersambung'}
              </span>
              {d.tersambung && !d.punya_refresh_token && (
                <span className="chip chip-verifikasi">tanpa refresh token — perlu sambung ulang</span>
              )}
              <span className="chip">{d.scopes.join(', ') || 'gmail.readonly'}</span>
            </div>

            <ol className="kecil" style={{ paddingLeft: 20, margin: '0 0 12px' }}>
              {d.langkah.map((l, i) => (
                <li key={i} style={{ marginBottom: 3 }}>
                  {l}
                </li>
              ))}
            </ol>

            <div className="tombol-baris" style={{ marginBottom: 12 }}>
              <button className="tombol tombol-utama" disabled={sibuk || !d.oauth_siap} onClick={() => void sambung()}>
                {d.tersambung ? 'Sambungkan ulang' : 'Sambungkan Gmail'}
              </button>
              {d.tersambung && (
                <>
                  <button className="tombol" disabled={sibuk} onClick={() => void sinkron('berkelanjutan')}>
                    Sinkron sekarang
                  </button>
                  <button className="tombol" disabled={sibuk} onClick={() => void cabut()}>
                    Cabut akses
                  </button>
                </>
              )}
            </div>

            {d.tersambung && (
              <div className="bidang-baris bidang-baris-2">
                <div className="bidang">
                  <label htmlFor="g-dari">Sinkronisasi historis dari tanggal</label>
                  <input id="g-dari" type="date" value={dari} onChange={(e) => setDari(e.target.value)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button className="tombol" disabled={sibuk} onClick={() => void sinkron('historis')}>
                    Jalankan sinkronisasi historis
                  </button>
                </div>
              </div>
            )}

            {pesan && <Catatan>{pesan}</Catatan>}

            <hr className="pisah" />
            <ul className="daftar">
              <li>
                <div className="isi">Sinkron terakhir</div>
                <div className="nilai">{d.sinkronisasi.sinkron_terakhir ? tanggal(d.sinkronisasi.sinkron_terakhir) : '—'}</div>
              </li>
              <li>
                <div className="isi">Sinkron historis terakhir</div>
                <div className="nilai">
                  {d.sinkronisasi.sinkron_penuh_terakhir ? tanggal(d.sinkronisasi.sinkron_penuh_terakhir) : '—'}
                </div>
              </li>
              <li>
                <div className="isi">Bukti tersimpan</div>
                <div className="nilai">{d.sinkronisasi.jumlah_bukti}</div>
              </li>
              <li>
                <div className="isi">Bukti perlu diperiksa</div>
                <div className="nilai">{d.sinkronisasi.bukti_perlu_review}</div>
              </li>
            </ul>
            {d.sinkronisasi.error_terakhir && <Catatan peringatan>{d.sinkronisasi.error_terakhir}</Catatan>}
            <Catatan>
              Gmail mungkin tidak memuat semua mutasi dan saldo. Impor mutasi bank di bawah untuk
              kelengkapan data dan rekonsiliasi saldo.
            </Catatan>
          </>
        )}
      </Wadah>
    </Kartu>
  );
}

function BagianTelegram() {
  const data = useApi(() => api.get<StatusTelegram>('/telegram/status'), []);
  return (
    <Kartu judul="Bot Telegram">
      <Wadah keadaan={data}>
        {(d) => (
          <>
            <div className="renteng" style={{ marginBottom: 10 }}>
              <span className={`chip ${d.token_terpasang ? 'chip-aktual' : 'chip-verifikasi'}`}>
                token {d.token_terpasang ? 'terpasang' : 'belum ada'}
              </span>
              <span className={`chip ${d.chat_id_terpasang ? 'chip-aktual' : 'chip-verifikasi'}`}>
                chat id {d.chat_id_terpasang ? 'terdaftar' : 'belum didaftarkan'}
              </span>
              <span className="chip">mode {d.mode}</span>
            </div>
            <ol className="kecil" style={{ paddingLeft: 20, margin: 0 }}>
              {d.langkah.map((l, i) => (
                <li key={i} style={{ marginBottom: 3 }}>
                  {l}
                </li>
              ))}
            </ol>
            <Catatan>Bot hanya menjawab satu akun Telegram yang sudah terdaftar. Akun lain diabaikan.</Catatan>
          </>
        )}
      </Wadah>
    </Kartu>
  );
}

function BagianImporSheet() {
  const [tab, setTab] = useState<string>('LANGGANAN');
  const [csv, setCsv] = useState('');
  const [periksa, setPeriksa] = useState<null | {
    headers: string[];
    contoh: string[][];
    jumlah_baris: number;
    pemetaan_usulan: Record<string, number | null>;
    kolom_tak_terpakai: string[];
    catatan: string[];
  }>(null);
  const [pemetaan, setPemetaan] = useState<Record<string, number | null>>({});
  const [hasil, setHasil] = useState<null | {
    dibuat: number;
    diperbarui: number;
    dilewati: number;
    tidak_jelas: Array<{ baris: number; alasan: string }>;
    catatan: string[];
    dry_run: boolean;
  }>(null);
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const bacaBerkas = async (f: File) => {
    const teks = await f.text();
    setCsv(teks);
    setHasil(null);
    setGalat(null);
  };

  const jalankanPeriksa = async () => {
    setSibuk(true);
    setGalat(null);
    try {
      const p = await api.post<typeof periksa>('/impor/sheet/periksa', { tab, csv });
      setPeriksa(p);
      setPemetaan(p?.pemetaan_usulan ?? {});
    } catch (err) {
      setGalat(err instanceof Error ? err.message : 'Gagal memeriksa.');
    } finally {
      setSibuk(false);
    }
  };

  const impor = async (dryRun: boolean) => {
    setSibuk(true);
    setGalat(null);
    try {
      const h = await api.post<typeof hasil>('/impor/sheet', { tab, csv, mapping: pemetaan, dryRun });
      setHasil(h);
    } catch (err) {
      setGalat(err instanceof Error ? err.message : 'Gagal mengimpor.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <Kartu judul="Impor awal dari Google Sheet">
      <Catatan>
        Sheet aslimu tidak pernah diubah. Ekspor tab yang ingin diimpor sebagai CSV (File → Download →
        Comma-separated values), lalu unggah di sini. Impor ulang aman: baris yang sama diperbarui, bukan
        diduplikasi.
      </Catatan>
      <div className="bidang" style={{ marginTop: 10 }}>
        <label htmlFor="i-tab">Tab</label>
        <select id="i-tab" value={tab} onChange={(e) => setTab(e.target.value)}>
          {TAB_SHEET.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="bidang">
        <label htmlFor="i-file">Berkas CSV</label>
        <input
          id="i-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void bacaBerkas(f);
          }}
        />
      </div>
      <div className="tombol-baris">
        <button className="tombol" disabled={sibuk || !csv} onClick={() => void jalankanPeriksa()}>
          Periksa kolom
        </button>
        <button className="tombol" disabled={sibuk || !csv} onClick={() => void impor(true)}>
          Uji coba (tanpa menyimpan)
        </button>
        <button className="tombol tombol-utama" disabled={sibuk || !csv} onClick={() => void impor(false)}>
          Jalankan impor
        </button>
      </div>

      {galat && <Catatan peringatan>{galat}</Catatan>}

      {periksa && (
        <>
          <h3 className="kartu-judul" style={{ marginTop: 14 }}>
            Pemetaan kolom ({periksa.jumlah_baris} baris)
          </h3>
          {periksa.catatan.map((c, i) => (
            <Catatan peringatan key={i}>
              {c}
            </Catatan>
          ))}
          <div className="bidang-baris bidang-baris-2" style={{ marginTop: 8 }}>
            {Object.keys(pemetaan).map((f) => (
              <div className="bidang" key={f}>
                <label htmlFor={`m-${f}`}>{f}</label>
                <select
                  id={`m-${f}`}
                  value={pemetaan[f] === null || pemetaan[f] === undefined ? '' : String(pemetaan[f])}
                  onChange={(e) =>
                    setPemetaan({ ...pemetaan, [f]: e.target.value === '' ? null : Number(e.target.value) })
                  }
                >
                  <option value="">— tidak dipakai —</option>
                  {periksa.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `kolom ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {periksa.kolom_tak_terpakai.length > 0 && (
            <div className="kecil">Kolom tidak dipakai: {periksa.kolom_tak_terpakai.join(', ')}</div>
          )}
        </>
      )}

      {hasil && (
        <>
          <h3 className="kartu-judul" style={{ marginTop: 14 }}>
            Hasil {hasil.dry_run ? 'uji coba' : 'impor'}
          </h3>
          <ul className="daftar">
            <li>
              <div className="isi">Dibuat</div>
              <div className="nilai">{hasil.dibuat}</div>
            </li>
            <li>
              <div className="isi">Diperbarui</div>
              <div className="nilai">{hasil.diperbarui}</div>
            </li>
            <li>
              <div className="isi">Dilewati</div>
              <div className="nilai">{hasil.dilewati}</div>
            </li>
          </ul>
          {hasil.tidak_jelas.length > 0 && (
            <>
              <div className="angka-ket" style={{ margin: '10px 0 4px' }}>
                Data yang tidak jelas ({hasil.tidak_jelas.length})
              </div>
              {hasil.tidak_jelas.slice(0, 20).map((t, i) => (
                <Catatan peringatan key={i}>
                  Baris {t.baris}: {t.alasan}
                </Catatan>
              ))}
            </>
          )}
          {hasil.catatan.map((c, i) => (
            <Catatan key={i}>{c}</Catatan>
          ))}
        </>
      )}
    </Kartu>
  );
}

function BagianImporMutasi() {
  const rekening = useApi(() => api.get<Rekening>('/rekening'), []);
  const [akun, setAkun] = useState('');
  const [csv, setCsv] = useState('');
  const [hasil, setHasil] = useState<null | {
    transaksi_dibuat: number;
    transaksi_digabung: number;
    dilewati: number;
    tidak_jelas: Array<{ baris: number; alasan: string }>;
    rekonsiliasi: { as_of: string; saldo_minor: number } | null;
    catatan: string[];
  }>(null);
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const impor = async (dryRun: boolean) => {
    if (!akun) {
      setGalat('Pilih rekening tujuan impor.');
      return;
    }
    setSibuk(true);
    setGalat(null);
    try {
      const h = await api.post<typeof hasil>('/impor/mutasi', { account_id: Number(akun), csv, dryRun });
      setHasil(h);
    } catch (err) {
      setGalat(err instanceof Error ? err.message : 'Gagal mengimpor.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <Kartu judul="Impor mutasi bank (CSV / teks PDF)">
      <Catatan>
        Mutasi adalah sumber paling lengkap untuk saldo. Baris saldo terakhir dipakai sebagai titik tambat
        rekonsiliasi, dan transaksi yang sudah dikenal dari email akan digabung, bukan diduplikasi.
      </Catatan>
      <div className="bidang" style={{ marginTop: 10 }}>
        <label htmlFor="m-akun">Rekening</label>
        <select id="m-akun" value={akun} onChange={(e) => setAkun(e.target.value)}>
          <option value="">Pilih rekening…</option>
          {(rekening.data?.daftar ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.last4 ? ` ••${a.last4}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="bidang">
        <label htmlFor="m-file">Berkas CSV mutasi</label>
        <input
          id="m-file"
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then(setCsv);
          }}
        />
      </div>
      <div className="bidang">
        <label htmlFor="m-teks">Atau tempel isi mutasi di sini</label>
        <textarea id="m-teks" rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} />
      </div>
      <div className="tombol-baris">
        <button className="tombol" disabled={sibuk || !csv} onClick={() => void impor(true)}>
          Uji coba
        </button>
        <button className="tombol tombol-utama" disabled={sibuk || !csv} onClick={() => void impor(false)}>
          Jalankan impor
        </button>
      </div>
      {galat && <Catatan peringatan>{galat}</Catatan>}
      {hasil && (
        <>
          <ul className="daftar" style={{ marginTop: 12 }}>
            <li>
              <div className="isi">Transaksi baru</div>
              <div className="nilai">{hasil.transaksi_dibuat}</div>
            </li>
            <li>
              <div className="isi">Digabung dengan yang sudah ada</div>
              <div className="nilai">{hasil.transaksi_digabung}</div>
            </li>
            <li>
              <div className="isi">Dilewati</div>
              <div className="nilai">{hasil.dilewati}</div>
            </li>
          </ul>
          {hasil.rekonsiliasi && (
            <Catatan>
              Saldo {rupiah(hasil.rekonsiliasi.saldo_minor)} per {tanggal(hasil.rekonsiliasi.as_of)} dicatat
              sebagai saldo terkonfirmasi.
            </Catatan>
          )}
          {hasil.tidak_jelas.slice(0, 10).map((t, i) => (
            <Catatan peringatan key={i}>
              Baris {t.baris}: {t.alasan}
            </Catatan>
          ))}
          {hasil.catatan.map((c, i) => (
            <Catatan key={i}>{c}</Catatan>
          ))}
        </>
      )}
    </Kartu>
  );
}

function BagianNotifikasi() {
  const [nonce, setNonce] = useState(0);
  const data = useApi(() => api.get<Notifikasi>('/notifikasi'), [nonce]);
  const ubah = async (type: string, patch: { enabled?: boolean; frequency?: string }) => {
    await api.patch(`/notifikasi/${type}`, patch);
    setNonce((n) => n + 1);
  };

  return (
    <Kartu judul="Notifikasi Telegram">
      <Catatan>
        Setiap jenis pesan bisa dimatikan atau diatur frekuensinya. Satu pengingat tidak pernah dikirim
        dua kali untuk peristiwa yang sama.
      </Catatan>
      <Wadah keadaan={data}>
        {(d) => (
          <ul className="daftar" style={{ marginTop: 10 }}>
            {d.map((n) => (
              <li key={n.type}>
                <div className="isi">
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{JUDUL_NOTIF[n.type] ?? n.type}</div>
                </div>
                <div className="nilai" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={n.frequency}
                    onChange={(e) => void ubah(n.type, { frequency: e.target.value })}
                    style={{ width: 'auto' }}
                    aria-label={`Frekuensi ${JUDUL_NOTIF[n.type] ?? n.type}`}
                  >
                    <option value="langsung">Langsung</option>
                    <option value="harian">Harian</option>
                    <option value="mingguan">Mingguan</option>
                    <option value="mati">Mati</option>
                  </select>
                  <label style={{ margin: 0, display: 'flex', gap: 5, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={n.enabled === 1}
                      onChange={(e) => void ubah(n.type, { enabled: e.target.checked })}
                      style={{ width: 'auto' }}
                    />
                    aktif
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Wadah>
    </Kartu>
  );
}

function BagianKeamanan() {
  return (
    <Kartu judul="Keamanan, cadangan, dan ekspor">
      <ul className="daftar">
        <li>
          <div className="isi">
            <strong>Ekspor seluruh data</strong>
            <div className="kecil">Semua tabel dalam satu berkas JSON, untuk cadangan atau pindah server.</div>
          </div>
          <div className="nilai">
            <a className="tombol tombol-kecil" href="/api/ekspor/semua.json">
              Unduh JSON
            </a>
          </div>
        </li>
        <li>
          <div className="isi">
            <strong>Ekspor transaksi</strong>
            <div className="kecil">CSV untuk dibandingkan dengan Sheet.</div>
          </div>
          <div className="nilai">
            <a className="tombol tombol-kecil" href="/api/ekspor/transaksi.csv">
              Unduh CSV
            </a>
          </div>
        </li>
        <li>
          <div className="isi">
            <strong>Laporan bulanan</strong>
            <div className="kecil">Arus kas, biaya pribadi neto, transfer internal, tabungan, piutang, company.</div>
          </div>
          <div className="nilai">
            <a className="tombol tombol-kecil" href="/api/laporan/bulanan.csv">
              Unduh CSV
            </a>
          </div>
        </li>
        <li>
          <div className="isi">
            <strong>Keluar dari sesi web</strong>
            <div className="kecil">Menghapus cookie sesi di peramban ini.</div>
          </div>
          <div className="nilai">
            <button
              className="tombol tombol-kecil"
              onClick={async () => {
                await api.post('/keluar');
                window.location.hash = '#/masuk';
                window.location.reload();
              }}
            >
              Keluar
            </button>
          </div>
        </li>
      </ul>
      <Catatan>
        Aplikasi ini hanya mencatat, mengingatkan, dan menganalisis. Ia tidak melakukan transfer atau
        pembayaran otomatis, dan tidak pernah meminta OTP, PIN, atau kata sandi bank. Cadangan berkala
        dan pemulihan dijelaskan di <code>docs/07-operasional.md</code>.
      </Catatan>
    </Kartu>
  );
}

export default function Pengaturan() {
  const [tema, setTema] = useState(document.documentElement.dataset.tema ?? 'sistem');
  const gantiTema = (v: string) => {
    setTema(v);
    if (v === 'sistem') delete document.documentElement.dataset.tema;
    else document.documentElement.dataset.tema = v;
    try {
      localStorage.setItem('bunih-tema', v);
    } catch {
      /* abaikan */
    }
  };

  return (
    <>
      <h1>Pengaturan</h1>
      <p className="subjudul">Rekening, koneksi Gmail dan Telegram, impor data, notifikasi, dan keamanan.</p>

      <BagianRekening />
      <BagianGmail />
      <BagianTelegram />
      <BagianImporSheet />
      <BagianImporMutasi />
      <BagianNotifikasi />
      <BagianKeamanan />

      <Kartu judul="Tampilan">
        <div className="bidang">
          <label htmlFor="tema">Tema</label>
          <select id="tema" value={tema} onChange={(e) => gantiTema(e.target.value)}>
            <option value="sistem">Ikuti sistem</option>
            <option value="terang">Terang</option>
            <option value="gelap">Gelap</option>
          </select>
        </div>
      </Kartu>
    </>
  );
}
