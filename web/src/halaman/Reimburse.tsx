import { useState } from 'react';
import { api } from '../api';
import { rupiah, tanggal } from '../format';
import { Catatan, Kartu, Kosong, useApi, Wadah } from '../components/dasar';

type Piutang = {
  total_sisa_minor: number;
  total_sisa_teman_minor: number;
  total_sisa_company_minor: number;
  jumlah_terbuka: number;
  jumlah_terlambat: number;
  per_orang: Array<{
    debtor_type: string;
    debtor_name: string;
    sisa_minor: number;
    nominal_awal_minor: number;
    sudah_kembali_minor: number;
    jumlah: number;
  }>;
  daftar: Array<{
    id: number;
    debtor_type: string;
    debtor_name: string | null;
    nominal_awal_minor: number;
    sudah_kembali_minor: number;
    sisa_minor: number;
    occurred_on: string;
    claimed_at: string | null;
    expected_on: string | null;
    status: string;
    umur_hari: number;
    terlambat: boolean;
    cash_event_id: number | null;
    keterangan: string | null;
    bukti: Array<{ evidence_id: number; kind: string; permalink: string | null }>;
  }>;
};

export default function Reimburse() {
  const [nonce, setNonce] = useState(0);
  const data = useApi(() => api.get<Piutang>('/reimburse'), [nonce]);
  const [sibuk, setSibuk] = useState(false);

  const klaim = async (id: number) => {
    setSibuk(true);
    try {
      await api.post(`/reimburse/${id}/klaim`, {});
      setNonce((n) => n + 1);
    } finally {
      setSibuk(false);
    }
  };

  const hapus = async (id: number) => {
    const alasan = window.prompt('Alasan menghapuskan piutang ini?');
    if (!alasan || alasan.length < 3) return;
    setSibuk(true);
    try {
      await api.post(`/reimburse/${id}/hapus`, { alasan });
      setNonce((n) => n + 1);
    } finally {
      setSibuk(false);
    }
  };

  return (
    <>
      <h1>Reimburse &amp; Talangan</h1>
      <p className="subjudul">
        Siapa yang masih harus mengganti uangku, berapa yang sudah kembali, dan bukti terkaitnya.
      </p>

      <Wadah keadaan={data}>
        {(d) => (
          <>
            <div className="petak petak-3">
              <Kartu judul="Total belum kembali">
                <div className="angka-besar tab-num">{rupiah(d.total_sisa_minor)}</div>
                <div className="kecil">{d.jumlah_terbuka} item terbuka</div>
              </Kartu>
              <Kartu judul="Dari teman">
                <div className="angka-besar tab-num">{rupiah(d.total_sisa_teman_minor)}</div>
              </Kartu>
              <Kartu judul="Dari company">
                <div className="angka-besar tab-num">{rupiah(d.total_sisa_company_minor)}</div>
                {d.jumlah_terlambat > 0 && (
                  <Catatan peringatan>{d.jumlah_terlambat} piutang sudah lewat perkiraan tanggal kembali.</Catatan>
                )}
              </Kartu>
            </div>

            <Catatan>
              Uang yang kembali dicatat sebagai pengurang piutang, bukan sebagai pendapatan baru.
            </Catatan>

            {d.per_orang.length > 0 && (
              <>
                <h2>Per orang / company</h2>
                <Kartu>
                  <ul className="daftar">
                    {d.per_orang.map((o) => (
                      <li key={`${o.debtor_type}-${o.debtor_name}`}>
                        <div className="isi">
                          <div style={{ fontWeight: 600 }}>
                            {o.debtor_name} <span className="chip">{o.debtor_type}</span>
                          </div>
                          <div className="kecil">
                            awal {rupiah(o.nominal_awal_minor)} · sudah kembali {rupiah(o.sudah_kembali_minor)} ·{' '}
                            {o.jumlah} item
                          </div>
                        </div>
                        <div className="nilai">{rupiah(o.sisa_minor)}</div>
                      </li>
                    ))}
                  </ul>
                </Kartu>
              </>
            )}

            <h2>Rincian</h2>
            {d.daftar.length === 0 ? (
              <Kosong
                ikon="🤝"
                judul="Belum ada piutang"
                pesan="Piutang muncul otomatis saat kamu menandai transaksi sebagai talangan, pembayaran bersama, atau klaim reimburse company."
              />
            ) : (
              <div className="tabel-bungkus">
                <table className="tabel-kartu">
                  <thead>
                    <tr>
                      <th>Siapa</th>
                      <th>Tanggal</th>
                      <th className="num">Nominal awal</th>
                      <th className="num">Sudah kembali</th>
                      <th className="num">Sisa</th>
                      <th>Status</th>
                      <th>Bukti</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.daftar.map((p) => (
                      <tr key={p.id}>
                        <td className="judul-sel">
                          {p.debtor_name ?? p.debtor_type}
                          {p.terlambat && <span className="chip chip-verifikasi" style={{ marginLeft: 6 }}>terlambat</span>}
                        </td>
                        <td data-l="Tanggal">
                          {tanggal(p.occurred_on)}
                          <div className="kecil">{p.umur_hari} hari</div>
                        </td>
                        <td className="num" data-l="Nominal awal">{rupiah(p.nominal_awal_minor)}</td>
                        <td className="num" data-l="Sudah kembali">{rupiah(p.sudah_kembali_minor)}</td>
                        <td className="num" data-l="Sisa">
                          <strong>{rupiah(p.sisa_minor)}</strong>
                        </td>
                        <td data-l="Status">
                          <span className={`chip ${p.status === 'lunas' ? 'chip-aktual' : 'chip-rencana'}`}>
                            {p.status.replace(/_/g, ' ')}
                          </span>
                          {p.expected_on && <div className="kecil">perkiraan {tanggal(p.expected_on)}</div>}
                        </td>
                        <td data-l="Bukti">
                          {p.bukti.length === 0 ? (
                            <span className="kecil">—</span>
                          ) : (
                            p.bukti.map((b) =>
                              b.permalink ? (
                                <a key={b.evidence_id} href={b.permalink} target="_blank" rel="noreferrer" style={{ marginRight: 6 }}>
                                  {b.kind}
                                </a>
                              ) : (
                                <span className="chip" key={b.evidence_id}>
                                  {b.kind}
                                </span>
                              ),
                            )
                          )}
                        </td>
                        <td data-l="">
                          {p.sisa_minor > 0 && (
                            <div className="tombol-baris">
                              {!p.claimed_at && (
                                <button className="tombol tombol-kecil" disabled={sibuk} onClick={() => void klaim(p.id)}>
                                  Tandai diklaim
                                </button>
                              )}
                              <button className="tombol tombol-kecil" disabled={sibuk} onClick={() => void hapus(p.id)}>
                                Hapuskan
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Catatan>
              Untuk mencatat uang yang masuk sebagai pelunasan, buka transaksi uang masuk di halaman
              Transaksi lalu pilih &ldquo;pelunasan piutang&rdquo;. Lewat Telegram, balas pertanyaannya langsung.
            </Catatan>
          </>
        )}
      </Wadah>
    </>
  );
}
