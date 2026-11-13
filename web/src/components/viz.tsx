import { useId, type ReactNode } from 'react';
import type { Anggaran, StatusAnggaran, TitikTren, Wajah as JenisWajah } from '../api';
import { rupiah, rupiahRingkas, tanggalSingkat } from '../format';

/* ============================================================================ wajah */

const WARNA_WAJAH: Record<JenisWajah, string> = {
  senang: 'var(--baik)',
  biasa: 'var(--peringatan)',
  khawatir: 'var(--kritis)',
  kosong: 'var(--seri-1)',
};

/**
 * Wajah sederhana untuk keadaan umum. Selalu dipasangkan dengan kata (judul) di sebelahnya,
 * jadi maknanya tidak bergantung pada gambar atau warna.
 */
export function Wajah({ jenis, ukuran = 84 }: { jenis: JenisWajah; ukuran?: number }) {
  const warna = WARNA_WAJAH[jenis];
  const label = { senang: 'Wajah senang', biasa: 'Wajah biasa saja', khawatir: 'Wajah khawatir', kosong: 'Wajah ramah' }[jenis];
  const mulut =
    jenis === 'senang' ? 'M28 56 Q50 76 72 56' : jenis === 'khawatir' ? 'M30 70 Q50 52 70 70' : jenis === 'kosong' ? 'M32 60 Q50 70 68 60' : 'M32 64 L68 64';
  return (
    <svg width={ukuran} height={ukuran} viewBox="0 0 100 100" role="img" aria-label={label}>
      <circle cx="50" cy="50" r="44" fill="var(--surface)" stroke={warna} strokeWidth="6" />
      {jenis === 'khawatir' && (
        <>
          <path d="M26 33 L40 29" stroke="var(--ink)" strokeWidth="4" strokeLinecap="round" />
          <path d="M74 33 L60 29" stroke="var(--ink)" strokeWidth="4" strokeLinecap="round" />
        </>
      )}
      <circle cx="35" cy="42" r="5.5" fill="var(--ink)" />
      <circle cx="65" cy="42" r="5.5" fill="var(--ink)" />
      <path d={mulut} stroke="var(--ink)" strokeWidth="5" fill="none" strokeLinecap="round" />
      {jenis === 'senang' && <path d="M18 56 Q22 62 26 56 M74 56 Q78 62 82 56" stroke={warna} strokeWidth="0" fill="none" />}
    </svg>
  );
}

/* ================================================================== perubahan & status */

export function Perubahan({ persen, baikBilaTurun = true }: { persen: number | null; baikBilaTurun?: boolean }) {
  if (persen === null) return <span className="perubahan">belum ada pembanding</span>;
  if (persen === 0) return <span className="perubahan">sama saja</span>;
  const naik = persen > 0;
  const buruk = baikBilaTurun ? naik : !naik;
  return (
    <span className={`perubahan ${buruk ? 'perubahan-naik' : 'perubahan-turun'}`}>
      <span aria-hidden="true">{naik ? '▲' : '▼'}</span>
      {naik ? 'naik' : 'turun'} {Math.abs(persen)}%
    </span>
  );
}

const STATUS_ANGGARAN: Record<StatusAnggaran, { kelas: string; ikon: string; teks: string }> = {
  aman: { kelas: 'ls-aman', ikon: '✔', teks: 'Aman' },
  berisiko: { kelas: 'ls-berisiko', ikon: '▲', teks: 'Hati-hati' },
  lewat: { kelas: 'ls-lewat', ikon: '■', teks: 'Lewat batas' },
  belum_mulai: { kelas: 'ls-netral', ikon: '○', teks: 'Belum mulai' },
  selesai: { kelas: 'ls-netral', ikon: '✔', teks: 'Selesai' },
};

export function LencanaStatus({ status }: { status: StatusAnggaran }) {
  const s = STATUS_ANGGARAN[status];
  return (
    <span className={`lencana-status ${s.kelas}`}>
      <span aria-hidden="true">{s.ikon}</span>
      {s.teks}
    </span>
  );
}

/* ============================================================================ peringkat */

export type BarisPeringkatData = {
  kunci: string | number;
  ikon: string;
  nama: string;
  nilai_minor: number;
  ket?: ReactNode;
  perubahan?: number | null;
  jenis?: 'pengeluaran' | 'pemasukan' | 'netral';
};

/**
 * Batang mendatar berurutan: bentuk paling mudah dibaca untuk "mana yang paling besar".
 * Satu warna, satu garis dasar, angka tertulis di samping — tidak perlu menebak dari bentuk.
 */
export function BarisPeringkat({
  baris,
  onPilih,
  maks,
  satuan = (n: number) => rupiah(n),
}: {
  baris: BarisPeringkatData[];
  onPilih?: (b: BarisPeringkatData) => void;
  maks?: number;
  satuan?: (n: number) => string;
}) {
  const puncak = maks ?? Math.max(1, ...baris.map((b) => Math.abs(b.nilai_minor)));
  return (
    <ul className="peringkat">
      {baris.map((b) => {
        const lebar = Math.max(2, Math.min(100, (Math.abs(b.nilai_minor) / puncak) * 100));
        const isi = (
          <>
            <span className="peringkat-ikon" aria-hidden="true">{b.ikon}</span>
            <span className="peringkat-nama">{b.nama}</span>
            <span className="peringkat-nilai">{satuan(b.nilai_minor)}</span>
            <span className="peringkat-trek" aria-hidden="true">
              <span
                className={`peringkat-isi ${b.jenis === 'pemasukan' ? 'isi-pemasukan' : b.jenis === 'netral' ? 'isi-netral' : ''}`}
                style={{ width: `${lebar}%`, display: 'block' }}
              />
            </span>
            {(b.ket || b.perubahan !== undefined) && (
              <span className="peringkat-ket">
                {b.ket}
                {b.perubahan !== undefined && <Perubahan persen={b.perubahan} />}
              </span>
            )}
          </>
        );
        return (
          <li key={b.kunci}>
            {onPilih ? (
              <button type="button" className="peringkat-baris" onClick={() => onPilih(b)} aria-label={`${b.nama}, ${satuan(b.nilai_minor)}. Lihat transaksinya.`}>
                {isi}
              </button>
            ) : (
              <div className="peringkat-baris">{isi}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ================================================================== meter anggaran */

function frasaPeriode(b: Anggaran): string {
  if (b.periode === 'harian') return 'hari ini';
  if (b.periode === 'mingguan') return 'pekan ini';
  if (b.periode === 'bulanan') return 'bulan ini';
  return `${tanggalSingkat(b.jendela.dari)}–${tanggalSingkat(b.jendela.sampai)}`;
}

/**
 * Meter anggaran dalam bahasa sehari-hari: "Sisa Rp500.000", lalu cukup berapa per hari.
 * Garis hitam kecil = seharusnya sudah sampai di mana hari ini bila memakainya merata.
 */
export function MeterAnggaran({ b, onKlik }: { b: Anggaran; onKlik?: () => void }) {
  const lebar = Math.min(100, Math.max(0, b.persen_terpakai));
  const jadwal = b.dialokasikan_minor > 0 ? Math.min(100, (b.jadwal_minor / b.dialokasikan_minor) * 100) : 0;
  const lewat = b.sisa_minor < 0;
  const kelasIsi = b.status === 'lewat' ? 's-lewat' : b.status === 'berisiko' ? 's-berisiko' : '';
  const aksiProps = onKlik ? { role: 'button', tabIndex: 0, onClick: onKlik, onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && onKlik() } : {};
  return (
    <div className="meter" {...aksiProps}>
      <div className="meter-kepala">
        <span className="meter-ikon" aria-hidden="true">{b.kategori_ikon ?? '🎯'}</span>
        <span className="meter-nama">{b.nama}</span>
        <LencanaStatus status={b.status} />
      </div>
      <p className="meter-sisa">
        {lewat ? `Lewat ${rupiah(-b.sisa_minor)}` : `Sisa ${rupiah(b.sisa_minor)}`}{' '}
        <small>
          {lewat
            ? `dari batas ${rupiah(b.dialokasikan_minor)}`
            : b.hari_tersisa > 0 && b.sisa_per_hari_minor > 0
              ? `· cukup ${rupiah(b.sisa_per_hari_minor)} per hari, ${b.hari_tersisa} hari lagi`
              : `untuk ${frasaPeriode(b)}`}
        </small>
      </p>
      <div
        className="meter-trek"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, b.persen_terpakai)}
        aria-label={`${b.nama}: terpakai ${b.persen_terpakai} persen`}
      >
        <div className={`meter-isi ${kelasIsi}`} style={{ width: `${lebar}%` }} />
        {b.hari_berjalan > 0 && b.periode !== 'harian' && b.status !== 'selesai' && <div className="meter-jadwal" style={{ left: `calc(${jadwal}% - 1px)` }} title="Seharusnya sudah sampai sini hari ini" />}
      </div>
      <div className="meter-angka">
        <span>Terpakai {rupiah(b.terpakai_minor)} ({b.persen_terpakai}%)</span>
        <span>Batas {rupiah(b.dialokasikan_minor)}</span>
      </div>
      {b.carry_minor > 0 && <div className="meter-angka"><span>Termasuk sisa periode lalu {rupiah(b.carry_minor)}</span></div>}
      {b.perkiraan_akhir_minor !== null && b.status !== 'selesai' && b.periode !== 'harian' && (
        <div className="meter-perkiraan">
          <span className="chip chip-perkiraan">Perkiraan</span>
          <span>
            Kalau lajunya begini, akhir periode sekitar <b>{rupiah(b.perkiraan_akhir_minor)}</b>.
          </span>
        </div>
      )}
      {b.perkiraan_terbatas && (
        <div className="meter-perkiraan">
          <span className="chip chip-perkiraan">Perkiraan</span>
          <span>Belum cukup data untuk memperkirakan akhir periode.</span>
        </div>
      )}
    </div>
  );
}

export function KunciMeter() {
  return (
    <div className="kunci-meter">
      <i aria-hidden="true" />
      <span>Garis hitam = seharusnya sudah sampai sini hari ini, kalau dipakai merata.</span>
    </div>
  );
}

/* ====================================================================== kolom batang */

export type KolomData = { kunci: string; label: string; nilai: number; sorot?: boolean };

/**
 * Kolom sederhana. Hanya satu batang yang diberi warna (hari ini / bulan ini), sisanya abu-abu,
 * dan angka hanya ditulis di batang tertinggi dan batang yang disorot: tidak ada angka di setiap titik.
 */
export function KolomBatang({ data, tinggi = 150, judul, warna = 'var(--seri-1)' }: { data: KolomData[]; tinggi?: number; judul: string; warna?: string }) {
  const lebar = 320;
  const pad = { atas: 24, bawah: 24, sisi: 6 };
  const maks = Math.max(1, ...data.map((d) => d.nilai));
  const area = tinggi - pad.atas - pad.bawah;
  const slot = (lebar - pad.sisi * 2) / data.length;
  const batang = Math.min(34, slot * 0.62);
  const idxTertinggi = data.reduce((best, d, i) => (d.nilai > (data[best]?.nilai ?? -1) ? i : best), 0);
  const id = useId();
  return (
    <>
      <svg className="kolom" viewBox={`0 0 ${lebar} ${tinggi}`} role="img" aria-labelledby={`${id}-j`} preserveAspectRatio="xMidYMid meet">
        <title id={`${id}-j`}>{`${judul}. ${data.map((d) => `${d.label} ${rupiah(d.nilai)}`).join(', ')}`}</title>
        <line x1={pad.sisi} x2={lebar - pad.sisi} y1={tinggi - pad.bawah} y2={tinggi - pad.bawah} stroke="var(--garis-kuat)" strokeWidth="1" />
        {data.map((d, i) => {
          const h = d.nilai > 0 ? Math.max(3, (d.nilai / maks) * area) : 0;
          const x = pad.sisi + slot * i + (slot - batang) / 2;
          const y = tinggi - pad.bawah - h;
          const tampilAngka = (i === idxTertinggi || d.sorot) && d.nilai > 0;
          return (
            <g key={d.kunci}>
              {h > 0 && <rect x={x} y={y} width={batang} height={h} rx="5" fill={d.sorot ? warna : 'var(--netral-batang)'} />}
              {h === 0 && <rect x={x} y={tinggi - pad.bawah - 2} width={batang} height="2" rx="1" fill="var(--netral-batang)" />}
              {tampilAngka && (
                <text x={x + batang / 2} y={y - 6} textAnchor="middle" fontSize="11.5" fontWeight="700" fill="var(--ink)">
                  {rupiahRingkas(d.nilai)}
                </text>
              )}
              <text x={x + batang / 2} y={tinggi - 7} textAnchor="middle" fontSize="12" fontWeight={d.sorot ? 800 : 500} fill={d.sorot ? 'var(--ink)' : 'var(--ink-redup)'}>
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

/* ======================================================================== celengan */

/** Celengan: meter berbentuk toples. Persen selalu tertulis di dalamnya dan di teks sekitarnya. */
export function Celengan({ persen, ikon = '🐷', ukuran = 74 }: { persen: number; ikon?: string; ukuran?: number }) {
  const id = useId();
  const p = Math.max(0, Math.min(100, persen));
  const tinggiIsi = (p / 100) * 62;
  return (
    <svg width={ukuran} height={ukuran * 1.25} viewBox="0 0 80 100" role="img" aria-label={`${p} persen terkumpul`}>
      <defs>
        <clipPath id={`${id}-k`}>
          <path d="M16 22 H64 V74 Q64 84 54 84 H26 Q16 84 16 74 Z" />
        </clipPath>
      </defs>
      <rect x="22" y="8" width="36" height="9" rx="3" fill="var(--garis-kuat)" />
      <path d="M16 22 H64 V74 Q64 84 54 84 H26 Q16 84 16 74 Z" fill="var(--tint-abu)" />
      <g clipPath={`url(#${id}-k)`}>
        <rect x="10" y={84 - tinggiIsi} width="60" height={tinggiIsi + 2} fill="var(--seri-3)" />
      </g>
      <path d="M16 22 H64 V74 Q64 84 54 84 H26 Q16 84 16 74 Z" fill="none" stroke="var(--ink-2)" strokeWidth="3" />
      <text x="40" y="58" textAnchor="middle" fontSize="22">{ikon}</text>
      <text x="40" y="97" textAnchor="middle" fontSize="13" fontWeight="800" fill="var(--ink)">{p}%</text>
    </svg>
  );
}

/* ====================================================================== garis tren */

const BULAT = (n: number) => Math.round(n * 10) / 10;

/**
 * Pemasukan vs pengeluaran dari waktu ke waktu. Aqua di atas putih berkontras rendah, jadi setiap
 * garis diberi label langsung di ujungnya dan data juga tersedia sebagai tabel di bawahnya.
 */
export function GarisTren({ titik, granularitas }: { titik: TitikTren[]; granularitas: string }) {
  const lebar = 640;
  const tinggi = 240;
  const pad = { atas: 18, kanan: 92, bawah: 28, kiri: 52 };
  const n = titik.length;
  const maks = Math.max(1, ...titik.map((t) => Math.max(t.pengeluaran_minor, t.pemasukan_minor)));
  const x = (i: number) => pad.kiri + (n <= 1 ? (lebar - pad.kiri - pad.kanan) / 2 : (i / (n - 1)) * (lebar - pad.kiri - pad.kanan));
  const y = (v: number) => tinggi - pad.bawah - (v / maks) * (tinggi - pad.atas - pad.bawah);
  const garis = (pick: (t: TitikTren) => number) => titik.map((t, i) => `${i === 0 ? 'M' : 'L'}${BULAT(x(i))},${BULAT(y(pick(t)))}`).join(' ');
  const langkahLabel = Math.max(1, Math.ceil(n / 8));
  const tick = [0, 0.5, 1].map((f) => maks * f);
  const adaMasuk = titik.some((t) => t.pemasukan_minor > 0);
  const akhir = titik[n - 1];
  const yKeluar = akhir ? y(akhir.pengeluaran_minor) : 0;
  const yMasuk = akhir ? y(akhir.pemasukan_minor) : 0;
  const bertabrakan = Math.abs(yKeluar - yMasuk) < 16;

  return (
    <div>
      <svg viewBox={`0 0 ${lebar} ${tinggi}`} width="100%" role="img" aria-label={`Pemasukan dan pengeluaran per ${granularitas === 'harian' ? 'hari' : granularitas === 'mingguan' ? 'pekan' : 'bulan'}`} style={{ display: 'block', overflow: 'visible' }}>
        {tick.map((t) => (
          <g key={t}>
            <line x1={pad.kiri} x2={lebar - pad.kanan} y1={y(t)} y2={y(t)} stroke="var(--garis)" />
            <text x={pad.kiri - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill="var(--ink-redup)">{rupiahRingkas(t)}</text>
          </g>
        ))}
        {titik.map((t, i) =>
          i % langkahLabel === 0 || i === n - 1 ? (
            <text key={t.awal} x={x(i)} y={tinggi - 8} textAnchor="middle" fontSize="12" fill="var(--ink-redup)">{t.label}</text>
          ) : null,
        )}
        <path d={garis((t) => t.pengeluaran_minor)} fill="none" stroke="var(--seri-1)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {adaMasuk && <path d={garis((t) => t.pemasukan_minor)} fill="none" stroke="var(--seri-3)" strokeWidth="3" strokeDasharray="8 5" strokeLinejoin="round" strokeLinecap="round" />}
        {akhir && (
          <>
            <circle cx={x(n - 1)} cy={yKeluar} r="5" fill="var(--seri-1)" stroke="var(--surface)" strokeWidth="2" />
            <text x={x(n - 1) + 10} y={bertabrakan ? yKeluar + 14 : yKeluar + 4} fontSize="13" fontWeight="800" fill="var(--ink)">Keluar</text>
            {adaMasuk && (
              <>
                <circle cx={x(n - 1)} cy={yMasuk} r="5" fill="var(--seri-3)" stroke="var(--surface)" strokeWidth="2" />
                <text x={x(n - 1) + 10} y={bertabrakan ? yMasuk - 6 : yMasuk + 4} fontSize="13" fontWeight="800" fill="var(--ink)">Masuk</text>
              </>
            )}
          </>
        )}
      </svg>
      <div className="legenda">
        <span><i style={{ background: 'var(--seri-1)' }} />Pengeluaran</span>
        {adaMasuk && <span><i style={{ background: 'transparent', height: 0, borderTop: '3px dashed var(--seri-3)' }} />Pemasukan</span>}
      </div>
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 14.5 }}>Lihat sebagai tabel</summary>
        <div className="tabel-bungkus" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>Periode</th><th className="num">Pemasukan</th><th className="num">Pengeluaran</th></tr></thead>
            <tbody>
              {titik.map((t) => (
                <tr key={t.awal}><td>{tanggalSingkat(t.awal)}{t.awal !== t.akhir ? ` – ${tanggalSingkat(t.akhir)}` : ''}</td><td className="num">{rupiah(t.pemasukan_minor)}</td><td className="num">{rupiah(t.pengeluaran_minor)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
