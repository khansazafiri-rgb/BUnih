import { useState } from 'react';
import { api, type Layanan } from '../api';
import {
  LABEL_KEPASTIAN, LABEL_SIKLUS, LABEL_STATUS_LAYANAN, LABEL_STATUS_TAGIHAN, rupiah, tanggal, tanggalSingkat,
} from '../format';
import { Catatan, Kartu, Kosong, useApi, Wadah } from '../components/dasar';

type DataTagihan = {
  mendekat: {
    sampai: string;
    daftar: Array<{
      obligation_id: number;
      label: string;
      tanggal: string;
      nominal_minor: number | null;
      kepastian: string;
      penanggung: string;
      pembayar: string;
      memotong_saldo_saya: boolean;
      terlambat: boolean;
      invoice_status: string | null;
      skenario_tag: string | null;
      aktif_di_skenario: boolean;
    }>;
    skenario: { slug: string; nama: string };
    dana_perlu_disiapkan_minor: number;
    jumlah_tanpa_nominal: number;
    jumlah_terlambat: number;
    jumlah_hanya_skenario_lain: number;
  };
  invoice: Array<{
    id: number;
    service_name: string | null;
    invoice_no: string | null;
    due_date: string | null;
    amount_minor: number | null;
    currency: string;
    amount_idr_actual: number | null;
    status: string;
    paid_by: string;
    bearer: string | null;
    sudah_dibayar: boolean;
    hari_ke_jatuh_tempo: number | null;
    bukti: Array<{ evidence_id: number; role: string; permalink: string | null }>;
  }>;
  peringatan_dibatalkan_tapi_tertagih: Array<{
    service_id: number;
    service_name: string;
    cancelled_at: string;
    temuan: Array<{ tipe: string; id: number; tanggal: string; nominal_minor: number | null }>;
  }>;
};

type Kandidat = {
  merchant_norm: string;
  merchant_contoh: string | null;
  jumlah_transaksi: number;
  total_minor: number;
  nominal_khas_minor: number | null;
  pertama: string;
  terakhir: string;
  berulang: boolean;
};

function EditLayanan({ l, onSimpan }: { l: Layanan; onSimpan: () => void }) {
  const [nominal, setNominal] = useState(l.amount_minor === null ? '' : String(l.amount_minor));
  const [jatuh, setJatuh] = useState(l.next_due_date ?? '');
  const [siklus, setSiklus] = useState(l.billing_cycle);
  const [penanggung, setPenanggung] = useState(l.bearer);
  const [pembayar, setPembayar] = useState(l.paid_by);
  const [status, setStatus] = useState(l.status);
  const [sibuk, setSibuk] = useState(false);
  const [pesan, setPesan] = useState<string | null>(null);

  const simpan = async () => {
    setSibuk(true);
    setPesan(null);
    try {
      await api.patch(`/layanan/${l.id}`, {
        amount_minor: nominal === '' ? null : Number(nominal.replace(/\D/g, '')),
        amount_certainty: nominal === '' ? 'perkiraan' : 'terverifikasi',
        next_due_date: jatuh || null,
        due_date_certainty: jatuh ? 'terverifikasi' : 'perkiraan',
        billing_cycle: siklus,
        bearer: penanggung,
        paid_by: pembayar,
        status,
      });
      setPesan('Tersimpan dan proyeksi dihitung ulang.');
      onSimpan();
    } catch (err) {
      setPesan(err instanceof Error ? err.message : 'Gagal menyimpan.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--garis)' }}>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang">
          <label htmlFor={`n-${l.id}`}>Nominal terverifikasi (rupiah)</label>
          <input id={`n-${l.id}`} value={nominal} onChange={(e) => setNominal(e.target.value)} placeholder="kosong = belum diketahui" />
        </div>
        <div className="bidang">
          <label htmlFor={`j-${l.id}`}>Tanggal tagihan berikutnya</label>
          <input id={`j-${l.id}`} type="date" value={jatuh} onChange={(e) => setJatuh(e.target.value)} />
        </div>
      </div>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang">
          <label htmlFor={`s-${l.id}`}>Siklus</label>
          <select id={`s-${l.id}`} value={siklus} onChange={(e) => setSiklus(e.target.value)}>
            {Object.entries(LABEL_SIKLUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="bidang">
          <label htmlFor={`st-${l.id}`}>Status</label>
          <select id={`st-${l.id}`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(LABEL_STATUS_LAYANAN).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="bidang-baris bidang-baris-2">
        <div className="bidang">
          <label htmlFor={`b-${l.id}`}>Penanggung akhir</label>
          <select id={`b-${l.id}`} value={penanggung} onChange={(e) => setPenanggung(e.target.value)}>
            <option value="pribadi">Pribadi</option>
            <option value="company">Company</option>
            <option value="belum_jelas">Belum jelas</option>
          </select>
        </div>
        <div className="bidang">
          <label htmlFor={`p-${l.id}`}>Siapa yang membayar lebih dulu</label>
          <select id={`p-${l.id}`} value={pembayar} onChange={(e) => setPembayar(e.target.value)}>
            <option value="saya">Saya (lalu direimburse)</option>
            <option value="company">Company bayar langsung</option>
            <option value="belum_jelas">Belum jelas</option>
          </select>
        </div>
      </div>
      {pesan && <Catatan>{pesan}</Catatan>}
      <button className="tombol tombol-utama tombol-kecil" disabled={sibuk} onClick={() => void simpan()}>
        Simpan
      </button>
    </div>
  );
}

export default function Tagihan() {
  const [nonce, setNonce] = useState(0);
  const [buka, setBuka] = useState<number | null>(null);
  const tagihan = useApi(() => api.get<DataTagihan>('/tagihan'), [nonce]);
  const layanan = useApi(() => api.get<Layanan[]>('/layanan'), [nonce]);
  const kandidat = useApi(() => api.get<Kandidat[]>('/layanan-belum-teridentifikasi'), [nonce]);

  return (
    <>
      <h1>Tagihan &amp; Langganan</h1>
      <p className="subjudul">
        Kalender jatuh tempo, status pembayaran, penanggung, dan layanan yang belum teridentifikasi.
      </p>

      <Wadah keadaan={tagihan}>
        {(d) => (
          <>
            {d.peringatan_dibatalkan_tapi_tertagih.length > 0 && (
              <Kartu judul="Peringatan: dibatalkan tetapi masih tertagih">
                {d.peringatan_dibatalkan_tapi_tertagih.map((p) => (
                  <Catatan peringatan key={p.service_id}>
                    <strong>{p.service_name}</strong> ditandai dibatalkan pada {tanggal(p.cancelled_at)}, tetapi
                    masih ada{' '}
                    {p.temuan
                      .map((t) => `${t.tipe} ${rupiah(t.nominal_minor)} pada ${tanggalSingkat(t.tanggal)}`)
                      .join('; ')}
                    . Tolong diperiksa.
                  </Catatan>
                ))}
              </Kartu>
            )}

            <div className="petak petak-3">
              <Kartu judul="Dana yang perlu disiapkan">
                <div className="angka-besar tab-num">{rupiah(d.mendekat.dana_perlu_disiapkan_minor)}</div>
                <div className="kecil">
                  sampai {tanggal(d.mendekat.sampai)}, hanya yang kubayar sendiri, skenario{' '}
                  {d.mendekat.skenario.nama}
                </div>
                {d.mendekat.jumlah_tanpa_nominal > 0 && (
                  <Catatan peringatan>
                    {d.mendekat.jumlah_tanpa_nominal} tagihan belum punya nominal, jadi angka ini belum lengkap.
                  </Catatan>
                )}
                {d.mendekat.jumlah_hanya_skenario_lain > 0 && (
                  <Catatan>
                    {d.mendekat.jumlah_hanya_skenario_lain} tagihan hanya hidup di skenario lain, jadi
                    ditampilkan di bawah tetapi tidak ikut dijumlahkan di sini.
                  </Catatan>
                )}
              </Kartu>
              <Kartu judul="Tagihan terlambat">
                <div className="angka-besar tab-num">{d.mendekat.jumlah_terlambat}</div>
                <div className="kecil">sudah lewat jatuh tempo dan belum tercatat dibayar</div>
              </Kartu>
              <Kartu judul="Jumlah tagihan terencana">
                <div className="angka-besar tab-num">{d.mendekat.daftar.length}</div>
                <div className="kecil">dalam 30 hari ke depan</div>
              </Kartu>
            </div>

            <h2>Jatuh tempo</h2>
            {d.mendekat.daftar.length === 0 ? (
              <Kosong ikon="🧾" judul="Tidak ada tagihan terencana" pesan="Belum ada kewajiban dalam rentang ini." />
            ) : (
              <div className="tabel-bungkus">
                <table className="tabel-kartu">
                  <thead>
                    <tr>
                      <th>Tanggal</th>
                      <th>Layanan</th>
                      <th className="num">Nominal</th>
                      <th>Penanggung</th>
                      <th>Pembayar</th>
                      <th>Kepastian</th>
                      <th>Catatan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.mendekat.daftar.map((t) => (
                      <tr key={t.obligation_id}>
                        <td className="judul-sel">
                          {tanggalSingkat(t.tanggal)}
                          {t.terlambat && <span className="chip chip-verifikasi" style={{ marginLeft: 6 }}>terlambat</span>}
                        </td>
                        <td data-l="Layanan">{t.label}</td>
                        <td className="num" data-l="Nominal">
                          <strong>{rupiah(t.nominal_minor)}</strong>
                        </td>
                        <td data-l="Penanggung">{t.penanggung}</td>
                        <td data-l="Pembayar">
                          {t.pembayar === 'company'
                            ? 'company langsung'
                            : t.pembayar === 'saya'
                              ? 'saya'
                              : 'belum jelas'}
                        </td>
                        <td data-l="Kepastian">
                          <span className={`chip ${t.kepastian === 'terverifikasi' ? 'chip-aktual' : 'chip-perkiraan'}`}>
                            {LABEL_KEPASTIAN[t.kepastian] ?? t.kepastian}
                          </span>
                        </td>
                        <td data-l="Catatan">
                          {!t.aktif_di_skenario && (
                            <span className="chip chip-rencana">hanya di skenario lain</span>
                          )}
                          {!t.memotong_saldo_saya && <span className="kecil">tidak memotong saldoku</span>}
                          {t.invoice_status && (
                            <span className="chip" style={{ marginLeft: 4 }}>
                              {LABEL_STATUS_TAGIHAN[t.invoice_status] ?? t.invoice_status}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h2>Invoice dan bukti</h2>
            {d.invoice.length === 0 ? (
              <Kosong ikon="📨" judul="Belum ada invoice" pesan="Invoice akan muncul setelah Gmail disinkronkan." />
            ) : (
              <div className="tabel-bungkus">
                <table className="tabel-kartu">
                  <thead>
                    <tr>
                      <th>Jatuh tempo</th>
                      <th>Layanan</th>
                      <th className="num">Nominal</th>
                      <th className="num">Rupiah aktual</th>
                      <th>Status</th>
                      <th>Bukti</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.invoice.map((i) => (
                      <tr key={i.id}>
                        <td className="judul-sel">{i.due_date ? tanggalSingkat(i.due_date) : '—'}</td>
                        <td data-l="Layanan">
                          {i.service_name ?? 'belum terhubung'}
                          {i.invoice_no && <span className="kecil"> #{i.invoice_no}</span>}
                        </td>
                        <td className="num" data-l="Nominal">
                          {i.amount_minor === null
                            ? 'belum diketahui'
                            : i.currency === 'IDR'
                              ? rupiah(i.amount_minor)
                              : `${i.currency} ${(i.amount_minor / 100).toFixed(2)}`}
                        </td>
                        <td className="num" data-l="Rupiah aktual">
                          {i.amount_idr_actual === null ? '—' : rupiah(i.amount_idr_actual)}
                        </td>
                        <td data-l="Status">
                          <span
                            className={`chip ${
                              i.status === 'lunas_terkonfirmasi'
                                ? 'chip-aktual'
                                : i.status === 'gagal_bayar' || i.status === 'perlu_verifikasi'
                                  ? 'chip-verifikasi'
                                  : 'chip-rencana'
                            }`}
                          >
                            {LABEL_STATUS_TAGIHAN[i.status] ?? i.status}
                          </span>
                        </td>
                        <td data-l="Bukti">
                          {i.bukti.length === 0 ? (
                            <span className="kecil">belum ada</span>
                          ) : (
                            i.bukti.map((b) =>
                              b.permalink ? (
                                <a key={b.evidence_id} href={b.permalink} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                                  {b.role}
                                </a>
                              ) : (
                                <span className="chip" key={b.evidence_id}>
                                  {b.role}
                                </span>
                              ),
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Wadah>

      <h2>Katalog layanan</h2>
      <Wadah keadaan={layanan}>
        {(d) => (
          <div className="petak petak-2">
            {d.map((l) => (
              <Kartu
                key={l.id}
                judul={l.name}
                aksi={
                  <button className="tombol tombol-kecil" onClick={() => setBuka(buka === l.id ? null : l.id)}>
                    {buka === l.id ? 'Tutup' : 'Ubah'}
                  </button>
                }
              >
                <div className="renteng" style={{ marginBottom: 8 }}>
                  <span
                    className={`chip ${
                      l.status === 'perlu_verifikasi' || l.status === 'kandidat' ? 'chip-verifikasi' : 'chip-aktual'
                    }`}
                  >
                    {LABEL_STATUS_LAYANAN[l.status] ?? l.status}
                  </span>
                  <span className="chip">{LABEL_SIKLUS[l.billing_cycle] ?? l.billing_cycle}</span>
                  <span className="chip">{l.bearer}</span>
                  {l.scenario_tag && <span className="chip chip-rencana">skenario</span>}
                </div>
                <div className="angka-sedang tab-num">{rupiah(l.amount_minor)}</div>
                <div className="renteng kecil" style={{ marginBottom: 8 }}>
                  <span className={`chip ${l.amount_certainty === 'terverifikasi' ? 'chip-aktual' : 'chip-perkiraan'}`}>
                    {LABEL_KEPASTIAN[l.amount_certainty]}
                  </span>
                  <span>
                    {l.next_due_date ? `tagihan berikutnya ${tanggal(l.next_due_date)}` : 'tanggal tagihan belum diketahui'}
                  </span>
                </div>
                <ul className="daftar">
                  <li>
                    <div className="isi">Sudah dibayar (tercatat)</div>
                    <div className="nilai">{rupiah(l.total_dibayar_minor)}</div>
                  </li>
                  <li>
                    <div className="isi">Jumlah invoice / pembayaran</div>
                    <div className="nilai">
                      {l.jumlah_invoice} / {l.jumlah_pembayaran}
                    </div>
                  </li>
                </ul>
                {l.note && <Catatan>{l.note}</Catatan>}
                {buka === l.id && <EditLayanan l={l} onSimpan={() => setNonce((n) => n + 1)} />}
              </Kartu>
            ))}
          </div>
        )}
      </Wadah>

      <h2>Layanan belum teridentifikasi</h2>
      <Wadah keadaan={kandidat}>
        {(d) =>
          d.length === 0 ? (
            <Kosong
              ikon="🔎"
              judul="Tidak ada kandidat"
              pesan="Semua pengeluaran berulang sudah terhubung ke layanan di katalog."
            />
          ) : (
            <Kartu>
              <Catatan>
                Ini kandidat yang ditemukan dari bukti. Aturan berulang baru dibuat setelah kamu
                mengonfirmasinya.
              </Catatan>
              <ul className="daftar" style={{ marginTop: 10 }}>
                {d.map((k) => (
                  <li key={k.merchant_norm}>
                    <div className="isi">
                      <div style={{ fontWeight: 600 }}>{k.merchant_contoh ?? k.merchant_norm}</div>
                      <div className="kecil">
                        {k.jumlah_transaksi > 0
                          ? `${k.jumlah_transaksi} transaksi, ${tanggalSingkat(k.pertama)} – ${tanggalSingkat(k.terakhir)}`
                          : `bukti tanggal ${tanggalSingkat(k.pertama)}`}
                        {k.berulang ? ' · pola berulang' : ''}
                      </div>
                    </div>
                    <div className="nilai">
                      {k.nominal_khas_minor !== null ? rupiah(k.nominal_khas_minor) : rupiah(k.total_minor)}
                    </div>
                  </li>
                ))}
              </ul>
            </Kartu>
          )
        }
      </Wadah>
    </>
  );
}
