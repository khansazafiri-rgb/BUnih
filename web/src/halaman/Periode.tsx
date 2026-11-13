import { api, type LaporanPeriode } from '../api';
import { rupiah, tanggal, tanggalSingkat } from '../format';
import { Catatan, Kartu, Kosong, StatusLencana, useApi, Wadah } from '../components/dasar';

export default function Periode() {
  const data = useApi(() => api.get<LaporanPeriode>('/periode'), []);

  return (
    <>
      <h1>Periode 5 Hari</h1>
      <p className="subjudul">
        Rekap per blok. Blok terbentuk otomatis dari tanggal awal periode dan intervalnya, yang bisa
        diubah di Proyeksi & simulasi.
      </p>

      <Wadah keadaan={data}>
        {(d) =>
          !d.tersedia ? (
            <Kosong
              ikon="🗓️"
              judul="Blok periode belum dapat dibentuk"
              pesan={d.alasan ?? 'Tanggal awal periode belum dikonfirmasi.'}
              aksi={
                <a className="tombol tombol-utama" href="#/rencana">
                  Isi tanggal awal periode
                </a>
              }
            />
          ) : (
            <>
              <Catatan>
                Blok {d.panjang_hari} hari, dihitung dari {tanggal(d.mulai_dari!)}. Skenario: {d.skenario.nama}.
              </Catatan>

              <div className="petak petak-2" style={{ marginTop: 12 }}>
                {d.blok.map((b) => (
                  <Kartu
                    key={b.index}
                    judul={`${tanggalSingkat(b.mulai)} – ${tanggalSingkat(b.akhir)}`}
                    aksi={b.is_berjalan ? <span className="chip chip-rencana">berjalan</span> : undefined}
                  >
                    <div className="renteng" style={{ marginBottom: 10 }}>
                      <StatusLencana status={b.status} />
                      {b.is_lampau && <span className="chip chip-aktual">sudah lewat</span>}
                    </div>
                    <div className="angka-sedang tab-num">{rupiah(b.sisa_dana_minor)}</div>
                    <div className="kecil" style={{ marginBottom: 10 }}>
                      sisa dana di akhir blok (proyeksi)
                    </div>
                    <ul className="daftar">
                      <li>
                        <div className="isi">Saldo awal blok</div>
                        <div className="nilai">{rupiah(b.saldo_awal_minor)}</div>
                      </li>
                      <li>
                        <div className="isi">
                          Pemasukan
                          <div className="kecil">rencana / aktual</div>
                        </div>
                        <div className="nilai">
                          {rupiah(b.pemasukan_rencana_minor)} / {rupiah(b.pemasukan_aktual_minor)}
                        </div>
                      </li>
                      <li>
                        <div className="isi">
                          Makan
                          <div className="kecil">rencana / aktual</div>
                        </div>
                        <div className="nilai">
                          {rupiah(b.makan_rencana_minor)} / {rupiah(b.makan_aktual_minor)}
                        </div>
                      </li>
                      <li>
                        <div className="isi">Selisih anggaran makan</div>
                        <div className="nilai" style={{ color: b.selisih_makan_minor < 0 ? 'var(--kritis-teks)' : undefined }}>
                          {rupiah(b.selisih_makan_minor)}
                        </div>
                      </li>
                      <li>
                        <div className="isi">Belanja</div>
                        <div className="nilai">{rupiah(b.belanja_minor)}</div>
                      </li>
                      <li>
                        <div className="isi">Tagihan</div>
                        <div className="nilai">{rupiah(b.tagihan_minor)}</div>
                      </li>
                      {b.biaya_company_minor > 0 && (
                        <li>
                          <div className="isi">
                            Biaya company
                            <div className="kecil">tidak memotong saldoku</div>
                          </div>
                          <div className="nilai">{rupiah(b.biaya_company_minor)}</div>
                        </li>
                      )}
                      {b.saldo_akhir_realisasi_minor !== null && (
                        <li>
                          <div className="isi">Saldo akhir realisasi</div>
                          <div className="nilai">{rupiah(b.saldo_akhir_realisasi_minor)}</div>
                        </li>
                      )}
                    </ul>
                    {(b.hari_defisit.length > 0 || b.hari_rendah.length > 0) && (
                      <Catatan peringatan>
                        {b.hari_defisit.length > 0
                          ? `Hari defisit: ${b.hari_defisit.map(tanggalSingkat).join(', ')}`
                          : `Hari rendah: ${b.hari_rendah.map(tanggalSingkat).join(', ')}`}
                      </Catatan>
                    )}
                  </Kartu>
                ))}
              </div>
            </>
          )
        }
      </Wadah>
    </>
  );
}
