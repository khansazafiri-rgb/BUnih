import { useState } from 'react';
import { api, type Proyeksi, type BarisHari } from '../api';
import { rupiah, tanggal, tanggalHari, tanggalSingkat, tambahHari } from '../format';
import { Catatan, Kartu, StatusLencana, useApi, Wadah } from '../components/dasar';
import GrafikSaldo, { type Seri } from '../components/GrafikSaldo';

type Skenario = { id: number; slug: string; name: string; description: string | null };

function DetailHari({ h, onTutup }: { h: BarisHari; onTutup: () => void }) {
  return (
    <Kartu judul={`Rincian ${tanggalHari(h.tanggal)}`} aksi={<button className="tombol tombol-kecil" onClick={onTutup}>Tutup</button>}>
      <div className="renteng" style={{ marginBottom: 10 }}>
        <StatusLencana status={h.status} />
        <span className="chip">saldo awal {rupiah(h.saldo_awal_minor)}</span>
        <span className="chip">saldo akhir {rupiah(h.saldo_akhir_minor)}</span>
      </div>
      {h.drivers.length === 0 ? (
        <div className="kecil">Tidak ada pergerakan pada hari ini.</div>
      ) : (
        <ul className="daftar">
          {h.drivers.map((d, i) => (
            <li key={i}>
              <div className="isi">
                <div style={{ fontWeight: 600, fontSize: 14 }}>{d.label}</div>
                <div className="renteng kecil">
                  <span className={`chip ${d.jenis === 'aktual' ? 'chip-aktual' : 'chip-rencana'}`}>
                    {d.jenis === 'aktual' ? 'Aktual' : 'Rencana'}
                  </span>
                  {d.certainty !== 'terverifikasi' && (
                    <span className="chip chip-perkiraan">
                      {d.certainty === 'asumsi_sheet' ? 'Asumsi awal' : 'Perkiraan'}
                    </span>
                  )}
                  {d.terlambat && <span className="chip chip-verifikasi">terlambat</span>}
                  <span>{d.bucket.replace(/_/g, ' ')}</span>
                  {d.direction === 'netral' && <span>tidak memengaruhi saldoku</span>}
                </div>
              </div>
              <div className="nilai">
                {d.amount_minor === null
                  ? 'belum diketahui'
                  : `${d.direction === 'keluar' ? '−' : d.direction === 'masuk' ? '+' : ''}${rupiah(d.amount_minor)}`}
              </div>
            </li>
          ))}
        </ul>
      )}
      {h.catatan.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {h.catatan.map((c, i) => (
            <Catatan key={i}>{c}</Catatan>
          ))}
        </div>
      )}
    </Kartu>
  );
}

export default function ArusHarian() {
  const hariIni = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [dari, setDari] = useState(tambahHari(hariIni, -7));
  const [sampai, setSampai] = useState(tambahHari(hariIni, 37));
  const [skenario, setSkenario] = useState('tanpa-claude-pribadi');
  const [bandingkan, setBandingkan] = useState(true);
  const [pilihHari, setPilihHari] = useState<string | null>(null);

  const daftarSkenario = useApi(() => api.get<Skenario[]>('/skenario'), []);
  const utama = useApi(
    () => api.get<Proyeksi>(`/arus-harian?dari=${dari}&sampai=${sampai}&skenario=${skenario}`),
    [dari, sampai, skenario],
  );
  const pembanding = useApi(
    () =>
      bandingkan
        ? api.get<Proyeksi>(`/arus-harian?dari=${dari}&sampai=${sampai}&skenario=dengan-claude-pribadi`)
        : Promise.resolve(null as unknown as Proyeksi),
    [dari, sampai, bandingkan],
  );

  return (
    <>
      <h1>Arus Harian</h1>
      <p className="subjudul">
        Saldo pembuka, pemasukan, pengeluaran rutin, belanja, tagihan, transfer, reimburse, dan saldo
        penutup untuk setiap hari. Ketuk satu hari untuk melihat penyebabnya.
      </p>

      <Kartu>
        <div className="bidang-baris bidang-baris-2">
          <div className="bidang">
            <label htmlFor="dari">Dari tanggal</label>
            <input id="dari" type="date" value={dari} onChange={(e) => setDari(e.target.value)} />
          </div>
          <div className="bidang">
            <label htmlFor="sampai">Sampai tanggal</label>
            <input id="sampai" type="date" value={sampai} onChange={(e) => setSampai(e.target.value)} />
          </div>
        </div>
        <div className="bidang">
          <label htmlFor="skenario">Skenario</label>
          <select id="skenario" value={skenario} onChange={(e) => setSkenario(e.target.value)}>
            {(daftarSkenario.data ?? []).map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
          <input
            type="checkbox"
            checked={bandingkan}
            onChange={(e) => setBandingkan(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Tampilkan pembanding &ldquo;dengan Claude Pro pribadi&rdquo;
        </label>
      </Kartu>

      <Wadah keadaan={utama}>
        {(p) => {
          const seri: Seri[] = [
            {
              nama: p.skenario.nama,
              warna: 'var(--seri-1)',
              titik: p.hari.map((h) => ({ tanggal: h.tanggal, nilai: h.saldo_akhir_minor, status: h.status })),
            },
          ];
          if (bandingkan && pembanding.data && pembanding.data.skenario.slug !== p.skenario.slug) {
            seri.push({
              nama: pembanding.data.skenario.nama,
              warna: 'var(--seri-2)',
              putus: true,
              titik: pembanding.data.hari.map((h) => ({ tanggal: h.tanggal, nilai: h.saldo_akhir_minor })),
            });
          }
          const hariDipilih = pilihHari ? p.hari.find((h) => h.tanggal === pilihHari) : null;

          return (
            <>
              <Kartu judul="Grafik saldo penutup" style={{ marginTop: 12 }}>
                <GrafikSaldo
                  seri={seri}
                  cadanganMinimal={p.ringkasan.cadangan_minimal_minor}
                  hariIni={p.hari_ini}
                  judul={seri.length === 1 ? seri[0]!.nama : undefined}
                />
              </Kartu>

              <div className="petak petak-3" style={{ marginTop: 12 }}>
                <Kartu judul="Saldo terendah">
                  <div className="angka-sedang tab-num">{rupiah(p.ringkasan.saldo_terendah_minor)}</div>
                  <div className="kecil">pada {tanggal(p.ringkasan.saldo_terendah_tanggal)}</div>
                  <hr className="pisah" />
                  <div className="kecil">
                    Tanpa menghitung perkiraan reimburse:{' '}
                    <strong>{rupiah(p.ringkasan.saldo_terendah_tanpa_reimburse_minor)}</strong> pada{' '}
                    {tanggalSingkat(p.ringkasan.saldo_terendah_tanpa_reimburse_tanggal)}
                  </div>
                </Kartu>
                <Kartu judul="Saldo akhir rentang">
                  <div className="angka-sedang tab-num">{rupiah(p.ringkasan.saldo_akhir_minor)}</div>
                  <div className="kecil">proyeksi (aktual + rencana)</div>
                  <hr className="pisah" />
                  <div className="kecil">
                    Realisasi: <strong>{rupiah(p.ringkasan.saldo_akhir_realisasi_minor)}</strong>
                  </div>
                </Kartu>
                <Kartu judul="Kebutuhan tambahan">
                  <div className="angka-sedang tab-num">
                    {rupiah(p.ringkasan.kekurangan_agar_cadangan_aman_minor)}
                  </div>
                  <div className="kecil">agar saldo tetap di atas cadangan minimal</div>
                  <hr className="pisah" />
                  <div className="kecil">
                    Agar tidak defisit: <strong>{rupiah(p.ringkasan.kekurangan_agar_tidak_defisit_minor)}</strong>
                    {p.ringkasan.tanggal_defisit && ` · defisit mulai ${tanggal(p.ringkasan.tanggal_defisit)}`}
                  </div>
                </Kartu>
              </div>

              <Catatan peringatan={p.dasar_saldo.certainty !== 'terverifikasi'}>
                Saldo dasar: {p.dasar_saldo.sumber}
              </Catatan>

              {hariDipilih && (
                <div style={{ marginTop: 12 }}>
                  <DetailHari h={hariDipilih} onTutup={() => setPilihHari(null)} />
                </div>
              )}

              <h2>Tabel harian</h2>
              <div className="tabel-bungkus">
                <table className="tabel-kartu">
                  <thead>
                    <tr>
                      <th>Tanggal</th>
                      <th className="num">Saldo awal</th>
                      <th className="num">Masuk</th>
                      <th className="num">Makan</th>
                      <th className="num">Belanja</th>
                      <th className="num">Tagihan</th>
                      <th className="num">Transfer</th>
                      <th className="num">Saldo akhir</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {p.hari.map((h) => (
                      <tr key={h.tanggal} style={h.is_hari_ini ? { outline: '1px solid var(--seri-1)' } : undefined}>
                        <td className="judul-sel">
                          {tanggalSingkat(h.tanggal)}
                          {h.is_hari_ini && <span className="chip" style={{ marginLeft: 6 }}>hari ini</span>}
                        </td>
                        <td className="num" data-l="Saldo awal">{rupiah(h.saldo_awal_minor)}</td>
                        <td className="num" data-l="Masuk">
                          {rupiah(h.masuk_aktual_minor)}
                          {h.masuk_rencana_minor > 0 && (
                            <span className="kecil"> +{rupiah(h.masuk_rencana_minor)} rencana</span>
                          )}
                        </td>
                        <td className="num" data-l="Makan">
                          {rupiah(h.makan_aktual_minor)}
                          {h.makan_rencana_minor > 0 && (
                            <span className="kecil"> +{rupiah(h.makan_rencana_minor)} rencana</span>
                          )}
                        </td>
                        <td className="num" data-l="Belanja">{rupiah(h.belanja_minor)}</td>
                        <td className="num" data-l="Tagihan">{rupiah(h.tagihan_minor)}</td>
                        <td className="num" data-l="Transfer">{rupiah(h.transfer_keluar_minor)}</td>
                        <td className="num" data-l="Saldo akhir">
                          <strong>{rupiah(h.saldo_akhir_minor)}</strong>
                        </td>
                        <td data-l="Status">
                          <StatusLencana status={h.status} />
                        </td>
                        <td data-l="">
                          <button className="tombol tombol-kecil" onClick={() => setPilihHari(h.tanggal)}>
                            Rincian
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {p.risiko.length > 0 && (
                <>
                  <h2>Risiko dan hal yang belum pasti</h2>
                  <Kartu>
                    <ul className="daftar">
                      {p.risiko.map((r, i) => (
                        <li key={i}>
                          <div className="isi">
                            <div style={{ fontSize: 14 }}>{r.pesan}</div>
                            <div className="kecil">{r.tipe.replace(/_/g, ' ')}</div>
                          </div>
                          {r.nominal_minor !== undefined && r.nominal_minor !== null && (
                            <div className="nilai">{rupiah(r.nominal_minor)}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Kartu>
                </>
              )}
            </>
          );
        }}
      </Wadah>
    </>
  );
}
