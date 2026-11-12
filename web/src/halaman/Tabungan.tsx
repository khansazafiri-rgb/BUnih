import { api } from '../api';
import { jam, rupiah, tanggal, tanggalSingkat } from '../format';
import { Catatan, Kartu, Kosong, useApi, Wadah } from '../components/dasar';

type DataTabungan = {
  rekening_tabungan: Array<{
    account_id: number;
    nama: string;
    last4: string | null;
    saldo_minor: number | null;
    saldo_terverifikasi: boolean;
    penjelasan: string[];
  }>;
  setoran_total_minor: number;
  penarikan_total_minor: number;
  neto_minor: number;
  bulan_ini: { setoran_minor: number; penarikan_minor: number; neto_minor: number };
  target_bulanan_minor: number;
  pencapaian_bulan_ini_persen: number | null;
  menunggu_pasangan: Array<{ cash_event_id: number; tanggal: string; nominal_minor: number; dari: string | null }>;
  riwayat: Array<{
    cash_event_id: number;
    tanggal: string;
    jenis: 'setoran' | 'penarikan';
    nominal_minor: number;
    dari_rekening: string | null;
    status: string;
    berpasangan: boolean;
  }>;
  catatan: string[];
};

export default function Tabungan() {
  const data = useApi(() => api.get<DataTabungan>('/tabungan'), []);

  return (
    <>
      <h1>Tabungan</h1>
      <p className="subjudul">
        Transfer Mandiri → BCA dicatat sebagai setoran tabungan: bukan pengeluaran, bukan pendapatan.
      </p>

      <Wadah keadaan={data}>
        {(d) => (
          <>
            <div className="petak petak-2">
              <Kartu judul="Saldo rekening tabungan">
                {d.rekening_tabungan.length === 0 ? (
                  <Kosong
                    ikon="🏦"
                    judul="Belum ada rekening tabungan"
                    pesan="Tandai satu rekening sebagai rekening tabungan di Pengaturan."
                  />
                ) : (
                  d.rekening_tabungan.map((r) => (
                    <div key={r.account_id} style={{ marginBottom: 12 }}>
                      <div className="angka-ket">
                        {r.nama}
                        {r.last4 ? ` ••${r.last4}` : ''}
                      </div>
                      <div className="angka-besar tab-num">
                        {r.saldo_minor === null ? 'Belum dapat diverifikasi' : rupiah(r.saldo_minor)}
                      </div>
                      {r.penjelasan.map((p, i) => (
                        <Catatan peringatan key={i}>
                          {p}
                        </Catatan>
                      ))}
                    </div>
                  ))
                )}
              </Kartu>

              <Kartu judul="Setoran dan penarikan">
                <div className="angka-besar tab-num">{rupiah(d.neto_minor)}</div>
                <div className="kecil" style={{ marginBottom: 10 }}>
                  neto yang berhasil kutabung (dari catatan transaksi)
                </div>
                <ul className="daftar">
                  <li>
                    <div className="isi">Total setoran</div>
                    <div className="nilai">{rupiah(d.setoran_total_minor)}</div>
                  </li>
                  <li>
                    <div className="isi">Total penarikan</div>
                    <div className="nilai">{rupiah(d.penarikan_total_minor)}</div>
                  </li>
                  <li>
                    <div className="isi">Bulan ini (neto)</div>
                    <div className="nilai">{rupiah(d.bulan_ini.neto_minor)}</div>
                  </li>
                  {d.target_bulanan_minor > 0 && (
                    <li>
                      <div className="isi">
                        Target bulanan
                        <div className="kecil">pencapaian {d.pencapaian_bulan_ini_persen ?? 0}%</div>
                      </div>
                      <div className="nilai">{rupiah(d.target_bulanan_minor)}</div>
                    </li>
                  )}
                </ul>
              </Kartu>
            </div>

            {d.catatan.map((c, i) => (
              <Catatan peringatan key={i}>
                {c}
              </Catatan>
            ))}

            {d.menunggu_pasangan.length > 0 && (
              <Kartu judul="Menunggu pasangan">
                <Catatan peringatan>
                  Transfer berikut baru terlihat satu sisinya. Uangnya tidak hilang dan tidak diciptakan;
                  sisi rekening tujuan belum terlihat.
                </Catatan>
                <ul className="daftar" style={{ marginTop: 10 }}>
                  {d.menunggu_pasangan.map((m) => (
                    <li key={m.cash_event_id}>
                      <div className="isi">
                        <div style={{ fontWeight: 600 }}>{m.dari ?? 'rekening belum diketahui'}</div>
                        <div className="kecil">
                          {tanggal(m.tanggal)} {jam(m.tanggal)} · transaksi #{m.cash_event_id}
                        </div>
                      </div>
                      <div className="nilai">{rupiah(m.nominal_minor)}</div>
                    </li>
                  ))}
                </ul>
              </Kartu>
            )}

            <h2>Riwayat</h2>
            {d.riwayat.length === 0 ? (
              <Kosong
                ikon="💰"
                judul="Belum ada setoran tabungan"
                pesan="Setoran muncul saat transfer ke rekening BCA milikmu terdeteksi atau kamu menandainya di Telegram."
              />
            ) : (
              <div className="tabel-bungkus">
                <table className="tabel-kartu">
                  <thead>
                    <tr>
                      <th>Tanggal</th>
                      <th>Jenis</th>
                      <th>Dari</th>
                      <th className="num">Nominal</th>
                      <th>Pasangan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.riwayat.map((r) => (
                      <tr key={r.cash_event_id}>
                        <td className="judul-sel">{tanggalSingkat(r.tanggal)}</td>
                        <td data-l="Jenis">
                          <span className="chip">{r.jenis}</span>
                        </td>
                        <td data-l="Dari">{r.dari_rekening ?? '—'}</td>
                        <td className="num" data-l="Nominal">
                          <strong>{rupiah(r.nominal_minor)}</strong>
                        </td>
                        <td data-l="Pasangan">
                          {r.berpasangan ? (
                            <span className="chip chip-aktual">cocok dua sisi</span>
                          ) : (
                            <span className="chip chip-verifikasi">menunggu pasangan</span>
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
    </>
  );
}
