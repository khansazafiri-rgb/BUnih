import { api, type Beranda as DataBeranda, type Keputusan } from '../api';
import { hariLagi, rupiah, tanggal, tanggalSingkat } from '../format';
import {
  AngkaBesar, Catatan, ChipKepastian, ChipVerifikasi, Kartu, StatusLencana, useApi, Wadah,
} from '../components/dasar';

function KartuSaldo({ d }: { d: DataBeranda }) {
  return (
    <Kartu judul="Dana tersedia terverifikasi">
      {d.saldo.akun_terverifikasi === 0 ? (
        <>
          <div className="angka-besar">Belum dapat dipastikan</div>
          <Catatan peringatan>
            Belum ada rekening yang direkonsiliasi. Impor mutasi atau masukkan saldo terkonfirmasi di
            Pengaturan. Angka proyeksi di halaman ini memakai asumsi, bukan saldo bank.
          </Catatan>
        </>
      ) : (
        <AngkaBesar
          nilai={rupiah(d.saldo.total_terverifikasi_minor)}
          label={`Dari ${d.saldo.akun_terverifikasi} rekening terekonsiliasi`}
          chip={<ChipKepastian nilai="terverifikasi" />}
          catatan={`diperbarui ${tanggal(d.saldo.as_of)}`}
        />
      )}

      <ul className="daftar" style={{ marginTop: 10 }}>
        {d.saldo.rekening.map((r) => (
          <li key={r.account_id}>
            <div className="isi">
              <div style={{ fontWeight: 600 }}>
                {r.name}
                {r.last4 ? ` ••${r.last4}` : ''}
                {r.is_savings_target && <span className="chip" style={{ marginLeft: 6 }}>Tabungan</span>}
              </div>
              {r.catatan.map((c, i) => (
                <div className="kecil" key={i}>
                  {c}
                </div>
              ))}
            </div>
            <div className="nilai">
              {r.balance_minor === null ? <span className="kecil">belum terverifikasi</span> : rupiah(r.balance_minor)}
            </div>
          </li>
        ))}
      </ul>

      {d.saldo.dalam_perjalanan_jumlah > 0 && (
        <Catatan>
          {rupiah(d.saldo.dalam_perjalanan_minor)} sedang dalam perjalanan antar rekening saya (
          {d.saldo.dalam_perjalanan_jumlah} transfer baru terlihat satu sisinya). Uangnya tidak hilang.
        </Catatan>
      )}
    </Kartu>
  );
}

function KartuCukup({ d }: { d: DataBeranda }) {
  const t = d.tagihan_terdekat;
  if (!t) {
    return (
      <Kartu judul="Cukup untuk tagihan terdekat?">
        <div className="angka-sedang">Tidak ada tagihan terencana</div>
        <div className="kecil">Belum ada tagihan dalam 30 hari ke depan yang memotong saldoku.</div>
      </Kartu>
    );
  }
  const c = d.cukup_untuk_tagihan;
  // "Belum pasti" bila nominalnya tidak diketahui, saldo belum terverifikasi,
  // atau dampaknya memang belum dapat dihitung — bukan diam-diam disebut tidak cukup.
  const belumPasti = t.nominal_minor === null || d.saldo.akun_terverifikasi === 0 || c === null;

  return (
    <Kartu judul="Cukup untuk tagihan terdekat?">
      <div className="angka-besar">
        {belumPasti ? 'Belum pasti' : c.cukup ? 'Ya, masih cukup' : 'Belum cukup'}
      </div>
      <div className="renteng" style={{ marginBottom: 8 }}>
        {belumPasti && <ChipVerifikasi />}
        {!belumPasti && !c.cukup && (
          <span className="chip chip-verifikasi">kurang {rupiah(c.kekurangan_minor)}</span>
        )}
        {!belumPasti && c.terlambat && (
          <span className="chip chip-rencana">dihitung pada hari ini karena sudah lewat tempo</span>
        )}
      </div>
      <ul className="daftar">
        <li>
          <div className="isi">
            <div style={{ fontWeight: 600 }}>{t.label}</div>
            <div className="kecil">
              {tanggal(t.tanggal)}
              {t.terlambat ? ' — sudah lewat jatuh tempo' : ` — ${hariLagi(t.tanggal, d.hari_ini)} hari lagi`} ·
              penanggung {t.penanggung} ·{' '}
              {t.pembayar === 'company'
                ? 'company bayar langsung'
                : t.pembayar === 'saya'
                  ? 'saya bayar'
                  : 'pembayar belum ditentukan'}
            </div>
          </div>
          <div className="nilai">{rupiah(t.nominal_minor)}</div>
        </li>
      </ul>
      <hr className="pisah" />
      <div className="renteng" style={{ justifyContent: 'space-between' }}>
        <span className="kecil">Dana tagihan 30 hari ke depan</span>
        <strong className="tab-num">{rupiah(d.dana_tagihan_30_hari_minor)}</strong>
      </div>
      {d.tagihan_tanpa_nominal > 0 && (
        <Catatan peringatan>
          {d.tagihan_tanpa_nominal} tagihan belum punya nominal, jadi angka di atas belum lengkap.
        </Catatan>
      )}
    </Kartu>
  );
}

function KartuSkenario({ d }: { d: DataBeranda }) {
  const baris = [
    { key: 'tanpa', warna: 'var(--seri-1)', s: d.skenario.tanpa_claude },
    { key: 'dengan', warna: 'var(--seri-2)', s: d.skenario.dengan_claude },
  ];
  return (
    <Kartu judul="Proyeksi 45 hari — dua skenario Claude">
      {baris.map((b) => (
        <div key={b.key} style={{ marginBottom: 14 }}>
          <div className="renteng" style={{ marginBottom: 2 }}>
            <i
              aria-hidden="true"
              style={{ width: 14, height: 3, borderRadius: 2, background: b.warna, display: 'inline-block' }}
            />
            <strong style={{ fontSize: 14 }}>{b.s.nama}</strong>
          </div>
          <div className="angka-sedang tab-num">{rupiah(b.s.saldo_terendah_minor)}</div>
          <div className="kecil">
            saldo terendah, pada {tanggal(b.s.saldo_terendah_tanggal)}
            {b.s.tanggal_defisit ? ` · defisit mulai ${tanggalSingkat(b.s.tanggal_defisit)}` : ''}
          </div>
          <div className="kecil">
            saldo akhir 45 hari: <strong className="tab-num">{rupiah(b.s.saldo_akhir_minor)}</strong>
          </div>
        </div>
      ))}
      <div className="renteng" style={{ justifyContent: 'space-between' }}>
        <span className="kecil">Cadangan minimal</span>
        <strong className="tab-num">{rupiah(d.cadangan_minimal_minor)}</strong>
      </div>
      <div style={{ marginTop: 12 }}>
        <a className="tombol tombol-kecil" href="#/arus-harian">
          Lihat arus harian
        </a>
      </div>
    </Kartu>
  );
}

function KartuPeriode({ d }: { d: DataBeranda }) {
  if (!d.periode_tersedia || !d.periode_berjalan) {
    return (
      <Kartu judul="Posisi periode berjalan">
        <div className="angka-sedang">Belum terbentuk</div>
        <Catatan peringatan>{d.periode_alasan ?? 'Tanggal awal periode belum dikonfirmasi.'}</Catatan>
        <div style={{ marginTop: 10 }}>
          <a className="tombol tombol-kecil" href="#/anggaran">
            Isi tanggal awal periode
          </a>
        </div>
      </Kartu>
    );
  }
  const b = d.periode_berjalan;
  return (
    <Kartu judul={`Periode ${tanggalSingkat(b.mulai)} – ${tanggalSingkat(b.akhir)}`}>
      <div className="renteng" style={{ marginBottom: 8 }}>
        <StatusLencana status={b.status} />
      </div>
      <ul className="daftar">
        <li>
          <div className="isi">Rencana masuk</div>
          <div className="nilai">{rupiah(b.pemasukan_rencana_minor)}</div>
        </li>
        <li>
          <div className="isi">Aktual masuk</div>
          <div className="nilai">{rupiah(b.pemasukan_aktual_minor)}</div>
        </li>
        <li>
          <div className="isi">Makan: rencana vs aktual</div>
          <div className="nilai">
            {rupiah(b.makan_rencana_minor)} / {rupiah(b.makan_aktual_minor)}
          </div>
        </li>
        <li>
          <div className="isi">Sisa dana akhir periode</div>
          <div className="nilai">{rupiah(b.sisa_dana_minor)}</div>
        </li>
      </ul>
    </Kartu>
  );
}

function KartuTindakan({ d, keputusan }: { d: DataBeranda; keputusan: Keputusan[] }) {
  const t = d.perlu_tindakan;
  const item = [
    { n: t.keputusan_terbuka, teks: 'pertanyaan belum dijawab', tautan: '#/transaksi' },
    { n: t.transaksi_belum_dikategorikan, teks: 'transaksi belum dikategorikan', tautan: '#/transaksi?status=perlu_verifikasi' },
    { n: t.transfer_menunggu_pasangan, teks: 'transfer menunggu pasangan', tautan: '#/transaksi?status=menunggu_pasangan' },
    { n: t.asumsi_belum_terverifikasi, teks: 'asumsi belum terverifikasi', tautan: '#/anggaran' },
    { n: t.layanan_perlu_verifikasi, teks: 'layanan perlu verifikasi', tautan: '#/tagihan' },
    {
      n: t.langganan_tertagih_setelah_dibatalkan,
      teks: 'langganan dibatalkan tapi masih tertagih',
      tautan: '#/tagihan',
    },
  ].filter((x) => x.n > 0);

  return (
    <Kartu judul="Perlu tindakan">
      {item.length === 0 ? (
        <div>
          <div className="angka-sedang">Semua beres</div>
          <div className="kecil">Tidak ada yang menunggu keputusanmu saat ini.</div>
        </div>
      ) : (
        <ul className="daftar">
          {item.map((x) => (
            <li key={x.teks}>
              <div className="isi">
                <a href={x.tautan} style={{ fontWeight: 600 }}>
                  {x.n} {x.teks}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {keputusan.length > 0 && (
        <>
          <hr className="pisah" />
          <div className="angka-ket" style={{ marginBottom: 6 }}>
            Pertanyaan terbaru
          </div>
          <ul className="daftar">
            {keputusan.slice(0, 4).map((k) => (
              <li key={k.id}>
                <div className="isi">
                  <div style={{ fontSize: 14 }}>{k.question}</div>
                  <div className="kecil">Jawab lewat Telegram atau halaman Transaksi.</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Kartu>
  );
}

export default function Beranda() {
  const beranda = useApi(() => api.get<DataBeranda>('/beranda'), []);
  const keputusan = useApi(() => api.get<Keputusan[]>('/keputusan'), []);

  return (
    <>
      <h1>Beranda</h1>
      <p className="subjudul">Posisi keuanganmu hari ini, dengan label yang jelas antara aktual dan rencana.</p>

      <Wadah keadaan={beranda}>
        {(d) => (
          <>
            {d.peringatan.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {d.peringatan.map((p, i) => (
                  <Catatan peringatan key={i}>
                    {p}
                  </Catatan>
                ))}
              </div>
            )}

            <div className="petak petak-2">
              <KartuSaldo d={d} />
              <KartuCukup d={d} />
            </div>

            <h2>Hari ini</h2>
            <div className="petak petak-3">
              <Kartu judul={`Posisi ${tanggal(d.hari_ini)}`}>
                {d.hari_ini_detail ? (
                  <>
                    <AngkaBesar
                      nilai={rupiah(d.hari_ini_detail.saldo_akhir_minor)}
                      label="Proyeksi akhir hari"
                      chip={<span className="chip chip-rencana">Proyeksi</span>}
                    />
                    <div className="renteng" style={{ marginBottom: 10 }}>
                      <StatusLencana status={d.hari_ini_detail.status} />
                    </div>
                    <ul className="daftar">
                      <li>
                        <div className="isi">Realisasi sampai sekarang</div>
                        <div className="nilai">{rupiah(d.hari_ini_detail.saldo_akhir_realisasi_minor)}</div>
                      </li>
                      <li>
                        <div className="isi">
                          Makan aktual
                          <div className="kecil">anggaran {rupiah(d.hari_ini_detail.anggaran_makan_minor)}</div>
                        </div>
                        <div className="nilai">{rupiah(d.hari_ini_detail.makan_aktual_minor)}</div>
                      </li>
                      <li>
                        <div className="isi">Tagihan hari ini</div>
                        <div className="nilai">{rupiah(d.hari_ini_detail.tagihan_minor)}</div>
                      </li>
                    </ul>
                  </>
                ) : (
                  <div className="kecil">Belum ada data hari ini.</div>
                )}
              </Kartu>

              <Kartu judul="Top-up berikutnya">
                {d.topup_berikutnya ? (
                  <>
                    <AngkaBesar
                      nilai={rupiah(d.topup_berikutnya.plan_amount_minor)}
                      label={tanggal(d.topup_berikutnya.plan_date)}
                      chip={<span className="chip chip-rencana">Rencana</span>}
                      catatan="belum menjadi pemasukan sampai ada bukti masuk"
                    />
                  </>
                ) : (
                  <>
                    <div className="angka-sedang">Belum ada</div>
                    <div className="kecil">
                      Rencana top-up belum dapat dibuat sampai tanggal awal periode dikonfirmasi.
                    </div>
                  </>
                )}
              </Kartu>

              <Kartu judul="Reimburse tertunda">
                <AngkaBesar
                  nilai={rupiah(d.piutang.total_sisa_minor)}
                  label="Masih harus diganti"
                  chip={d.piutang.jumlah_terlambat > 0 ? <ChipVerifikasi teks={`${d.piutang.jumlah_terlambat} terlambat`} /> : undefined}
                />
                <ul className="daftar">
                  <li>
                    <div className="isi">Teman</div>
                    <div className="nilai">{rupiah(d.piutang.teman_minor)}</div>
                  </li>
                  <li>
                    <div className="isi">Company</div>
                    <div className="nilai">{rupiah(d.piutang.company_minor)}</div>
                  </li>
                </ul>
                <div style={{ marginTop: 10 }}>
                  <a className="tombol tombol-kecil" href="#/reimburse">
                    Kelola piutang
                  </a>
                </div>
              </Kartu>
            </div>

            <h2>Proyeksi dan periode</h2>
            <div className="petak petak-2">
              <KartuSkenario d={d} />
              <KartuPeriode d={d} />
            </div>

            <h2>Yang menunggu kamu</h2>
            <div className="petak petak-2">
              <KartuTindakan d={d} keputusan={keputusan.data ?? []} />
              <Kartu judul="Risiko yang perlu diketahui">
                {d.risiko.length === 0 ? (
                  <div className="kecil">Tidak ada risiko tercatat.</div>
                ) : (
                  <ul className="daftar">
                    {d.risiko.map((r, i) => (
                      <li key={i}>
                        <div className="isi">
                          <div style={{ fontSize: 14 }}>{r.pesan}</div>
                          {r.tanggal && <div className="kecil">{tanggal(r.tanggal)}</div>}
                        </div>
                        {r.nominal_minor !== undefined && r.nominal_minor !== null && (
                          <div className="nilai">{rupiah(r.nominal_minor)}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Kartu>
            </div>
          </>
        )}
      </Wadah>
    </>
  );
}
