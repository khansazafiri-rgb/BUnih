import { useState } from 'react';
import { api, type Transaksi as Tx, type Keputusan } from '../api';
import { bacaRupiah, jam, LABEL_JENIS, LABEL_STATUS_TRANSAKSI, rupiah, tanggalSingkat } from '../format';
import { Catatan, Kartu, Kosong, useApi, Wadah } from '../components/dasar';
import { bukaCatat, umumkanPerubahan } from '../components/FormCatat';

type Kategori = { id: number; name: string; group_name: string };
type Detail = {
  transaksi: Tx;
  alokasi: Array<{ id: number; amount_minor: number; purpose: string; bearer_type: string; category_name: string | null; bearer_name: string | null; note: string | null }>;
  bukti: Array<{ id: number; source: string; kind: string; received_at: string; from_email: string | null; subject: string | null; permalink: string | null; role: string }>;
  riwayat: Array<{ id: number; action: string; actor: string; at: string; reason: string | null }>;
  pasangan: Array<{ id: number; direction: string; amount_minor: number; occurred_at: string }>;
};

const CHIP_STATUS: Record<string, string> = {
  terkonfirmasi: 'chip-aktual',
  menunggu_pasangan: 'chip-verifikasi',
  perlu_verifikasi: 'chip-verifikasi',
  dibatalkan: 'chip-perkiraan',
};

function FormUbah({
  id,
  t,
  kategori,
  sibuk,
  setSibuk,
  setPesan,
  selesai,
}: {
  id: number;
  t: Tx;
  kategori: Kategori[];
  sibuk: boolean;
  setSibuk: (b: boolean) => void;
  setPesan: (s: string | null) => void;
  selesai: () => void;
}) {
  const [merchant, setMerchant] = useState(t.merchant_raw ?? '');
  const [catatan, setCatatan] = useState(t.note ?? '');
  const [kat, setKat] = useState('');
  const [ingat, setIngat] = useState(false);

  const simpan = async () => {
    setSibuk(true);
    setPesan(null);
    try {
      const badan: Record<string, unknown> = {};
      if (merchant.trim() !== (t.merchant_raw ?? '')) badan['merchant'] = merchant.trim() || null;
      if (catatan.trim() !== (t.note ?? '')) badan['catatan'] = catatan.trim() || null;
      if (kat) {
        badan['kategori_id'] = Number(kat);
        badan['ingat_untuk_merchant'] = ingat;
      }
      if (Object.keys(badan).length === 0) {
        setPesan('Belum ada yang diubah.');
        return;
      }
      await api.patch(`/transaksi/${id}/ubah`, badan);
      setPesan('Tersimpan. Semua laporan ikut diperbarui, dan perubahannya tercatat di riwayat.');
      umumkanPerubahan();
      selesai();
    } catch (err) {
      setPesan(err instanceof Error ? err.message : 'Gagal.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang">
          <label htmlFor={`mer-${id}`}>Di mana / untuk siapa</label>
          <input id={`mer-${id}`} value={merchant} onChange={(e) => setMerchant(e.target.value)} />
        </div>
        <div className="bidang">
          <label htmlFor={`kat-${id}`}>Kategori{t.kategori ? ` (sekarang: ${t.kategori})` : ''}</label>
          <select id={`kat-${id}`} value={kat} onChange={(e) => setKat(e.target.value)}>
            <option value="">Biarkan seperti sekarang</option>
            {kategori.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="bidang">
        <label htmlFor={`cat-${id}`}>Catatan</label>
        <input id={`cat-${id}`} value={catatan} onChange={(e) => setCatatan(e.target.value)} />
      </div>
      {kat && merchant.trim() && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600, marginBottom: 10 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={ingat} onChange={(e) => setIngat(e.target.checked)} />
          Ingat: lain kali “{merchant.trim()}” otomatis masuk kategori ini
        </label>
      )}
      <button className="tombol tombol-utama tombol-kecil" disabled={sibuk} onClick={() => void simpan()}>
        Simpan perubahan
      </button>
    </div>
  );
}

function PanelDetail({ id, onTutup, onUbah }: { id: number; onTutup: () => void; onUbah: () => void }) {
  const detail = useApi(() => api.get<Detail>(`/transaksi/${id}`), [id]);
  const kategori = useApi(() => api.get<Kategori[]>('/kategori'), []);
  const [sibuk, setSibuk] = useState(false);
  const [pesan, setPesan] = useState<string | null>(null);
  const [bagianSaya, setBagianSaya] = useState('');
  const [jumlahOrang, setJumlahOrang] = useState('');

  const jalankan = async (badan: unknown) => {
    setSibuk(true);
    setPesan(null);
    try {
      const hasil = await api.post<{ pesan?: string }>(`/transaksi/${id}/tindakan`, badan);
      setPesan(hasil.pesan ?? 'Selesai.');
      detail.muatUlang();
      onUbah();
    } catch (err) {
      setPesan(err instanceof Error ? err.message : 'Gagal.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <Kartu
      judul={`Transaksi #${id}`}
      aksi={
        <button className="tombol tombol-kecil" onClick={onTutup}>
          Tutup
        </button>
      }
    >
      <Wadah keadaan={detail}>
        {(d) => (
          <>
            <div className="angka-sedang tab-num">
              {d.transaksi.direction === 'keluar' ? '−' : '+'}
              {rupiah(d.transaksi.amount_minor)}
            </div>
            <div className="kecil" style={{ marginBottom: 8 }}>
              {tanggalSingkat(d.transaksi.occurred_at)} {jam(d.transaksi.occurred_at)} ·{' '}
              {d.transaksi.rekening ?? 'tanpa rekening'} · {d.transaksi.merchant_raw ?? '—'}
            </div>
            <div className="renteng" style={{ marginBottom: 12 }}>
              <span className={`chip ${CHIP_STATUS[d.transaksi.status] ?? ''}`}>
                {LABEL_STATUS_TRANSAKSI[d.transaksi.status] ?? d.transaksi.status}
              </span>
              <span className="chip">{LABEL_JENIS[d.transaksi.kind] ?? d.transaksi.kind}</span>
              {d.transaksi.kategori && <span className="chip">{d.transaksi.kategori}</span>}
              <span className="chip chip-perkiraan">sumber {d.transaksi.source}</span>
            </div>

            {d.transaksi.note && <Catatan>{d.transaksi.note}</Catatan>}

            <h3 className="kartu-judul" style={{ marginTop: 14 }}>
              Pembagian biaya
            </h3>
            <ul className="daftar">
              {d.alokasi.map((a) => (
                <li key={a.id}>
                  <div className="isi">
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{a.purpose.replace(/_/g, ' ')}</div>
                    <div className="kecil">
                      penanggung {a.bearer_name ?? a.bearer_type}
                      {a.category_name ? ` · ${a.category_name}` : ''}
                      {a.note ? ` · ${a.note}` : ''}
                    </div>
                  </div>
                  <div className="nilai">{rupiah(a.amount_minor)}</div>
                </li>
              ))}
            </ul>

            {d.pasangan.length > 0 && (
              <Catatan>
                Pasangan transfer internal: transaksi #{d.pasangan[0]!.id} (
                {d.pasangan[0]!.direction} {rupiah(d.pasangan[0]!.amount_minor)}). Keduanya adalah satu
                perpindahan uang, bukan dua pengeluaran.
              </Catatan>
            )}
            {d.transaksi.status === 'menunggu_pasangan' && (
              <Catatan peringatan>
                Sisi pasangan transfer belum terlihat. Uangnya tidak hilang, tetapi rekening tujuan belum
                dapat diverifikasi.
              </Catatan>
            )}

            <h3 className="kartu-judul" style={{ marginTop: 14 }}>
              Bukti ({d.bukti.length})
            </h3>
            {d.bukti.length === 0 ? (
              <div className="kecil">Belum ada bukti tertaut.</div>
            ) : (
              <ul className="daftar">
                {d.bukti.map((b) => (
                  <li key={`${b.id}-${b.role}`}>
                    <div className="isi">
                      <div style={{ fontSize: 14 }}>{b.subject ?? b.kind}</div>
                      <div className="kecil">
                        {b.source} · {b.role} · {tanggalSingkat(b.received_at)}
                        {b.from_email ? ` · ${b.from_email}` : ''}
                      </div>
                    </div>
                    {b.permalink && (
                      <div className="nilai">
                        <a className="tombol tombol-kecil" href={b.permalink} target="_blank" rel="noreferrer">
                          Buka
                        </a>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <h3 className="kartu-judul" style={{ marginTop: 14 }}>
              Ubah
            </h3>
            {pesan && <Catatan>{pesan}</Catatan>}

            <FormUbah
              id={id}
              t={d.transaksi}
              kategori={kategori.data ?? []}
              sibuk={sibuk}
              setSibuk={setSibuk}
              setPesan={setPesan}
              selesai={() => {
                detail.muatUlang();
                onUbah();
              }}
            />

            <div className="bidang-baris bidang-baris-2">
              <div className="bidang">
                <label htmlFor={`bs-${id}`}>Bagianku (mis. 30rb)</label>
                <input
                  id={`bs-${id}`}
                  value={bagianSaya}
                  onChange={(e) => setBagianSaya(e.target.value)}
                  placeholder="30rb"
                />
              </div>
              <div className="bidang">
                <label htmlFor={`jo-${id}`}>Jumlah orang total</label>
                <input
                  id={`jo-${id}`}
                  value={jumlahOrang}
                  onChange={(e) => setJumlahOrang(e.target.value)}
                  placeholder="4"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="tombol-baris">
              <button
                className="tombol"
                disabled={sibuk || (!bagianSaya && !jumlahOrang)}
                onClick={() =>
                  jalankan({
                    tindakan: 'bagi_biaya',
                    bagian_saya_minor: bagianSaya ? bacaRupiah(bagianSaya) : null,
                    jumlah_orang: jumlahOrang ? Number(jumlahOrang) : null,
                  })
                }
              >
                Bagi biaya
              </button>
              <button className="tombol" disabled={sibuk} onClick={() => jalankan({ tindakan: 'reimburse_company' })}>
                Reimburse company
              </button>
              <button className="tombol" disabled={sibuk} onClick={() => jalankan({ tindakan: 'company_langsung' })}>
                Company bayar langsung
              </button>
              <button className="tombol" disabled={sibuk} onClick={() => jalankan({ tindakan: 'hadiah' })}>
                Hadiah
              </button>
              <button className="tombol" disabled={sibuk} onClick={() => jalankan({ tindakan: 'talangan' })}>
                Talangan
              </button>
              <button className="tombol" disabled={sibuk} onClick={() => jalankan({ tindakan: 'setoran_tabungan' })}>
                Setoran tabungan
              </button>
              <button className="tombol" disabled={sibuk} onClick={() => jalankan({ tindakan: 'transfer_sendiri' })}>
                Transfer sendiri
              </button>
            </div>

            <h3 className="kartu-judul" style={{ marginTop: 16 }}>
              Riwayat koreksi
            </h3>
            <ul className="daftar">
              {d.riwayat.map((h) => (
                <li key={h.id}>
                  <div className="isi">
                    <div style={{ fontSize: 14 }}>{h.action.replace(/_/g, ' ')}</div>
                    <div className="kecil">
                      oleh {h.actor} · {tanggalSingkat(h.at)} {jam(h.at)}
                      {h.reason ? ` · ${h.reason}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Wadah>
    </Kartu>
  );
}

export default function Transaksi() {
  const [cari, setCari] = useState('');
  const [status, setStatus] = useState(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('status') ?? '');
  const [jenis, setJenis] = useState('');
  const [rekening, setRekening] = useState('');
  const [kategoriF, setKategoriF] = useState('');
  const [dari, setDari] = useState('');
  const [sampai, setSampai] = useState('');
  const [pilih, setPilih] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const rekeningData = useApi(() => api.get<{ daftar: Array<{ id: number; name: string }> }>('/rekening'), []);
  const kategoriData = useApi(() => api.get<Kategori[]>('/kategori'), []);
  const keputusan = useApi(() => api.get<Keputusan[]>('/keputusan'), [nonce]);

  const q = new URLSearchParams();
  if (cari) q.set('cari', cari);
  if (status) q.set('status', status);
  if (jenis) q.set('jenis', jenis);
  if (rekening) q.set('rekening', rekening);
  if (kategoriF) q.set('kategori', kategoriF);
  if (dari) q.set('dari', dari);
  if (sampai) q.set('sampai', sampai);
  q.set('batas', '100');

  const daftar = useApi(
    () => api.get<{ total: number; daftar: Tx[] }>(`/transaksi?${q.toString()}`),
    [cari, status, jenis, rekening, kategoriF, dari, sampai, nonce],
  );

  const jawab = async (id: number, optionId: string) => {
    await api.post(`/keputusan/${id}`, { optionId });
    setNonce((n) => n + 1);
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <h1>Transaksi</h1>
          <p className="subjudul">Cari dan filter semua transaksi. Setiap transaksi membuka bukti dan riwayat koreksinya.</p>
        </div>
        <button className="tombol tombol-utama" onClick={() => bukaCatat()}>＋ Catat transaksi</button>
      </div>

      {(keputusan.data ?? []).length > 0 && (
        <Kartu judul="Pertanyaan yang perlu dijawab">
          <ul className="daftar">
            {(keputusan.data ?? []).map((k) => {
              const opsi = JSON.parse(k.options_json) as Array<{ id: string; label: string }>;
              return (
                <li key={k.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ fontSize: 14, marginBottom: 8 }}>{k.question}</div>
                  <div className="tombol-baris">
                    {opsi.map((o) => (
                      <button key={o.id} className="tombol tombol-kecil" onClick={() => void jawab(k.id, o.id)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </Kartu>
      )}

      <Kartu>
        <details open={window.innerWidth >= 900}>
        <summary style={{ fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>Cari &amp; saring</summary>
        <div className="bidang">
          <label htmlFor="cari">Cari merchant, catatan, nomor referensi</label>
          <input id="cari" value={cari} onChange={(e) => setCari(e.target.value)} placeholder="mis. kantin" />
        </div>
        <div className="bidang-baris bidang-baris-2">
          <div className="bidang">
            <label htmlFor="f-status">Status</label>
            <select id="f-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Semua status</option>
              <option value="terkonfirmasi">Terkonfirmasi</option>
              <option value="perlu_verifikasi">Perlu verifikasi</option>
              <option value="menunggu_pasangan">Menunggu pasangan</option>
            </select>
          </div>
          <div className="bidang">
            <label htmlFor="f-jenis">Jenis</label>
            <select id="f-jenis" value={jenis} onChange={(e) => setJenis(e.target.value)}>
              <option value="">Semua jenis</option>
              {Object.entries(LABEL_JENIS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="bidang">
          <label htmlFor="f-rek">Rekening</label>
          <select id="f-rek" value={rekening} onChange={(e) => setRekening(e.target.value)}>
            <option value="">Semua rekening</option>
            {(rekeningData.data?.daftar ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="bidang-baris bidang-baris-2">
          <div className="bidang">
            <label htmlFor="f-kat">Kategori</label>
            <select id="f-kat" value={kategoriF} onChange={(e) => setKategoriF(e.target.value)}>
              <option value="">Semua kategori</option>
              {(kategoriData.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>{k.name}</option>
              ))}
            </select>
          </div>
          <div className="bidang-baris bidang-baris-2" style={{ margin: 0 }}>
            <div className="bidang"><label htmlFor="f-dari">Dari</label><input id="f-dari" type="date" value={dari} onChange={(e) => setDari(e.target.value)} /></div>
            <div className="bidang"><label htmlFor="f-sampai">Sampai</label><input id="f-sampai" type="date" value={sampai} onChange={(e) => setSampai(e.target.value)} /></div>
          </div>
        </div>
        </details>
      </Kartu>

      {pilih !== null && (
        <div style={{ marginTop: 12 }}>
          <PanelDetail id={pilih} onTutup={() => setPilih(null)} onUbah={() => setNonce((n) => n + 1)} />
        </div>
      )}

      <Wadah keadaan={daftar}>
        {(d) =>
          d.daftar.length === 0 ? (
            <Kosong
              ikon="🔍"
              judul="Belum ada transaksi"
              pesan="Belum ada transaksi yang cocok. Sambungkan Gmail, impor mutasi, atau catat lewat Telegram."
            />
          ) : (
            <>
              <div className="kecil" style={{ margin: '14px 0 8px' }}>
                {d.daftar.length} dari {d.total} transaksi
              </div>
              <div className="tabel-bungkus">
                <table className="tabel-kartu">
                  <thead>
                    <tr>
                      <th>Tanggal</th>
                      <th>Keterangan</th>
                      <th>Kategori</th>
                      <th>Rekening</th>
                      <th>Jenis</th>
                      <th>Status</th>
                      <th className="num">Nominal</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.daftar.map((t) => (
                      <tr key={t.id}>
                        <td className="judul-sel">
                          {tanggalSingkat(t.occurred_at)}
                          <span className="kecil"> {jam(t.occurred_at)}</span>
                        </td>
                        <td data-l="Keterangan">
                          {t.merchant_nama ?? t.merchant_raw ?? t.counterparty ?? '—'}
                          {t.layanan && <span className="chip" style={{ marginLeft: 6 }}>{t.layanan}</span>}
                          {t.jumlah_bukti > 0 && (
                            <span className="chip" style={{ marginLeft: 6 }}>
                              {t.jumlah_bukti} bukti
                            </span>
                          )}
                        </td>
                        <td data-l="Kategori">{t.kategori ?? <span className="chip chip-verifikasi">belum ada</span>}</td>
                        <td data-l="Rekening">{t.rekening ?? '—'}</td>
                        <td data-l="Jenis">{LABEL_JENIS[t.kind] ?? t.kind}</td>
                        <td data-l="Status">
                          <span className={`chip ${CHIP_STATUS[t.status] ?? ''}`}>
                            {LABEL_STATUS_TRANSAKSI[t.status] ?? t.status}
                          </span>
                        </td>
                        <td className="num" data-l="Nominal">
                          <strong>
                            {t.direction === 'keluar' ? '−' : '+'}
                            {rupiah(t.amount_minor)}
                          </strong>
                        </td>
                        <td data-l="">
                          <button className="tombol tombol-kecil" onClick={() => setPilih(t.id)}>
                            Detail
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        }
      </Wadah>
    </>
  );
}
