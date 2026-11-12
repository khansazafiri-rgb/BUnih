import { useEffect, useMemo, useRef, useState } from 'react';
import { rupiah, rupiahRingkas, tanggalHari, tanggalSingkat } from '../format';
import type { BarisHari } from '../api';

export type Seri = {
  nama: string;
  warna: string;
  /** Seri pembanding digambar putus-putus agar tetap terbaca saat dua garis berimpit. */
  putus?: boolean;
  titik: Array<{ tanggal: string; nilai: number; status?: BarisHari['status'] }>;
};

type Props = {
  seri: Seri[];
  /** Garis acuan cadangan minimal. Bukan seri, jadi digambar tipis dan redup. */
  cadanganMinimal?: number;
  hariIni?: string;
  tinggi?: number;
  /** Judul menyebut serinya, sehingga satu seri tidak memerlukan legenda. */
  judul?: string;
};

const PADDING = { atas: 14, kanan: 14, bawah: 26, kiri: 56 };

function tickNilai(min: number, max: number, jumlah = 4): number[] {
  if (max === min) return [min];
  const rentang = max - min;
  const kasar = rentang / jumlah;
  const pangkat = Math.pow(10, Math.floor(Math.log10(Math.abs(kasar) || 1)));
  const langkah = [1, 2, 2.5, 5, 10].map((m) => m * pangkat).find((s) => s >= kasar) ?? pangkat * 10;
  const mulai = Math.floor(min / langkah) * langkah;
  const out: number[] = [];
  for (let v = mulai; v <= max + langkah * 0.5; v += langkah) out.push(v);
  return out;
}

/**
 * Grafik garis saldo per hari.
 *
 * Satu sumbu nilai (semuanya rupiah). Hari RENDAH / DEFISIT ditandai dengan
 * penanda bentuk dan dijelaskan dalam teks pada tooltip — tidak hanya warna.
 * Tabel harian di bawah grafik berfungsi sebagai tampilan tabel.
 */
export default function GrafikSaldo({ seri, cadanganMinimal, hariIni, tinggi = 230, judul }: Props) {
  const wadah = useRef<HTMLDivElement>(null);
  const [lebar, setLebar] = useState(680);
  const [sorot, setSorot] = useState<number | null>(null);

  useEffect(() => {
    const el = wadah.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 120) setLebar(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tanggalList = useMemo(() => seri[0]?.titik.map((t) => t.tanggal) ?? [], [seri]);

  const { min, max } = useMemo(() => {
    const semua = seri.flatMap((s) => s.titik.map((t) => t.nilai));
    if (cadanganMinimal !== undefined) semua.push(cadanganMinimal);
    semua.push(0);
    const lo = Math.min(...semua);
    const hi = Math.max(...semua);
    const bantal = Math.max((hi - lo) * 0.08, 1000);
    return { min: lo - bantal, max: hi + bantal };
  }, [seri, cadanganMinimal]);

  const plotW = Math.max(60, lebar - PADDING.kiri - PADDING.kanan);
  const plotH = tinggi - PADDING.atas - PADDING.bawah;
  const n = tanggalList.length;

  const x = (i: number) => PADDING.kiri + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PADDING.atas + plotH - ((v - min) / (max - min || 1)) * plotH;

  const ticks = tickNilai(min, max, 4);
  const langkahLabelX = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(plotW / 62))));

  if (!n) {
    return (
      <div className="keadaan">
        <span className="ik" aria-hidden="true">📈</span>
        <div className="keadaan-judul">Belum ada data harian</div>
        <div style={{ fontSize: 14 }}>Pilih rentang tanggal lain atau catat transaksi pertamamu.</div>
      </div>
    );
  }

  const posisiTip = sorot === null ? 0 : x(sorot);
  const tipKanan = posisiTip > lebar * 0.6;

  return (
    <div ref={wadah} style={{ position: 'relative' }}>
      {judul && <div className="angka-ket" style={{ marginBottom: 6 }}>{judul}</div>}
      <svg
        className="grafik"
        width={lebar}
        height={tinggi}
        role="img"
        aria-label={`Grafik saldo harian ${seri.map((s) => s.nama).join(' dan ')}`}
        onMouseLeave={() => setSorot(null)}
        onMouseMove={(e) => {
          const kotak = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - kotak.left;
          const i = Math.round(((px - PADDING.kiri) / (plotW || 1)) * (n - 1));
          setSorot(Math.min(n - 1, Math.max(0, i)));
        }}
        onTouchMove={(e) => {
          const kotak = e.currentTarget.getBoundingClientRect();
          const px = (e.touches[0]?.clientX ?? 0) - kotak.left;
          const i = Math.round(((px - PADDING.kiri) / (plotW || 1)) * (n - 1));
          setSorot(Math.min(n - 1, Math.max(0, i)));
        }}
      >
        {/* kisi tipis */}
        {ticks.map((t) => (
          <g key={`t${t}`}>
            <line
              x1={PADDING.kiri}
              x2={PADDING.kiri + plotW}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--garis)"
              strokeWidth={1}
            />
            <text
              x={PADDING.kiri - 8}
              y={y(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--ink-redup)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {rupiahRingkas(t)}
            </text>
          </g>
        ))}

        {/* garis nol bila rentang melewati nol */}
        {min < 0 && max > 0 && (
          <line
            x1={PADDING.kiri}
            x2={PADDING.kiri + plotW}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--garis-kuat)"
            strokeWidth={1}
          />
        )}

        {/* acuan cadangan minimal */}
        {cadanganMinimal !== undefined && (
          <g>
            <line
              x1={PADDING.kiri}
              x2={PADDING.kiri + plotW}
              y1={y(cadanganMinimal)}
              y2={y(cadanganMinimal)}
              stroke="var(--ink-redup)"
              strokeWidth={1}
              strokeDasharray="5 4"
            />
            <text
              x={PADDING.kiri + 4}
              y={y(cadanganMinimal) - 5}
              fontSize={10.5}
              fill="var(--ink-redup)"
            >
              Cadangan minimal
            </text>
          </g>
        )}

        {/* penanda hari ini */}
        {hariIni && tanggalList.includes(hariIni) && (
          <line
            x1={x(tanggalList.indexOf(hariIni))}
            x2={x(tanggalList.indexOf(hariIni))}
            y1={PADDING.atas}
            y2={PADDING.atas + plotH}
            stroke="var(--garis-kuat)"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        )}

        {/* label sumbu tanggal */}
        {tanggalList.map((t, i) =>
          i % langkahLabelX === 0 || i === n - 1 ? (
            <text
              key={`x${t}`}
              x={x(i)}
              y={tinggi - 8}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontSize={11}
              fill="var(--ink-redup)"
            >
              {tanggalSingkat(t)}
            </text>
          ) : null,
        )}

        {/* garis seri, 2px. Seri kedua putus-putus supaya tetap terbaca saat berimpit. */}
        {seri.map((s, idx) => (
          <path
            key={s.nama}
            d={s.titik.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.nilai)}`).join(' ')}
            fill="none"
            stroke={s.warna}
            strokeWidth={2}
            strokeDasharray={s.putus ?? idx > 0 ? '7 4' : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* penanda hari berisiko pada seri pertama: bentuk, bukan warna saja */}
        {seri[0]?.titik.map((p, i) =>
          p.status && p.status !== 'aman' ? (
            <g key={`r${p.tanggal}`}>
              {p.status === 'defisit' ? (
                <rect
                  x={x(i) - 4.5}
                  y={y(p.nilai) - 4.5}
                  width={9}
                  height={9}
                  fill="var(--kritis)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              ) : (
                <polygon
                  points={`${x(i)},${y(p.nilai) - 5.5} ${x(i) + 5},${y(p.nilai) + 4} ${x(i) - 5},${y(p.nilai) + 4}`}
                  fill="var(--peringatan)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              )}
            </g>
          ) : null,
        )}

        {/* crosshair */}
        {sorot !== null && (
          <g>
            <line
              x1={x(sorot)}
              x2={x(sorot)}
              y1={PADDING.atas}
              y2={PADDING.atas + plotH}
              stroke="var(--ink-redup)"
              strokeWidth={1}
            />
            {seri.map((s) => {
              const p = s.titik[sorot];
              if (!p) return null;
              return (
                <circle
                  key={`c${s.nama}`}
                  cx={x(sorot)}
                  cy={y(p.nilai)}
                  r={4.5}
                  fill={s.warna}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              );
            })}
          </g>
        )}
      </svg>

      {sorot !== null && seri[0]?.titik[sorot] && (
        <div
          className="tip"
          style={{
            left: tipKanan ? undefined : Math.max(4, posisiTip + 12),
            right: tipKanan ? Math.max(4, lebar - posisiTip + 12) : undefined,
            top: 8,
          }}
        >
          <b>{tanggalHari(seri[0].titik[sorot]!.tanggal)}</b>
          {seri.map((s) => (
            <div className="tip-baris" key={`tp${s.nama}`}>
              <span>
                <i
                  style={{
                    display: 'inline-block',
                    width: 12,
                    height: 0,
                    borderTop: `3px ${seri.indexOf(s) > 0 ? 'dashed' : 'solid'} ${s.warna}`,
                    marginRight: 6,
                    verticalAlign: 'middle',
                  }}
                />
                {s.nama}
              </span>
              <span>{rupiah(s.titik[sorot]?.nilai ?? null)}</span>
            </div>
          ))}
          {seri[0].titik[sorot]!.status && seri[0].titik[sorot]!.status !== 'aman' && (
            <div style={{ marginTop: 5, fontWeight: 650 }}>
              Status: {seri[0].titik[sorot]!.status === 'defisit' ? 'DEFISIT' : 'RENDAH'}
            </div>
          )}
        </div>
      )}

      {seri.length >= 2 && (
        <div className="legenda">
          {seri.map((s, idx) => (
            <span key={`l${s.nama}`}>
              <i
                style={
                  idx > 0
                    ? { background: 'transparent', height: 0, borderTop: `3px dashed ${s.warna}` }
                    : { background: s.warna }
                }
              />
              {s.nama}
            </span>
          ))}
          <span>
            <i style={{ background: 'transparent', height: 0, borderTop: '2px dashed var(--ink-redup)' }} />
            Cadangan minimal
          </span>
        </div>
      )}
    </div>
  );
}
