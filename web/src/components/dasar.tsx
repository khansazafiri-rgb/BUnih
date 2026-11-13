import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { LABEL_KEPASTIAN } from '../format';
import type { Kepastian, Risiko } from '../api';

/* ------------------------------------------------------------- pemuat data */

export type Keadaan<T> = {
  data: T | null;
  memuat: boolean;
  galat: string | null;
  muatUlang: () => void;
};

export function useApi<T>(ambil: () => Promise<T>, deps: unknown[] = []): Keadaan<T> {
  const [data, setData] = useState<T | null>(null);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const ambilRef = useRef(ambil);
  ambilRef.current = ambil;

  useEffect(() => {
    let batal = false;
    setMemuat(true);
    setGalat(null);
    ambilRef
      .current()
      .then((hasil) => {
        if (!batal) setData(hasil);
      })
      .catch((err: unknown) => {
        if (batal) return;
        if (err instanceof ApiError && err.status === 401) {
          window.location.hash = '#/masuk';
          return;
        }
        setGalat(err instanceof Error ? err.message : 'Terjadi kesalahan.');
      })
      .finally(() => {
        if (!batal) setMemuat(false);
      });
    return () => {
      batal = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const muatUlang = useCallback(() => setNonce((n) => n + 1), []);
  return { data, memuat, galat, muatUlang };
}

/* ------------------------------------------------------------------ keadaan */

export function Memuat({ baris = 3 }: { baris?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sembunyi-visual">Sedang memuat data…</span>
      {Array.from({ length: baris }, (_, i) => (
        <div className="memuat" key={i} style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Galat({ pesan, coba }: { pesan: string; coba?: () => void }) {
  return (
    <div className="galat" role="alert">
      <div style={{ fontWeight: 650, marginBottom: 4 }}>Gagal memuat</div>
      <div>{pesan}</div>
      {coba && (
        <div style={{ marginTop: 10 }}>
          <button className="tombol tombol-kecil" onClick={coba}>
            Coba lagi
          </button>
        </div>
      )}
    </div>
  );
}

export function Kosong({
  ikon = '📋',
  judul,
  pesan,
  aksi,
}: {
  ikon?: string;
  judul: string;
  pesan: string;
  aksi?: ReactNode;
}) {
  return (
    <div className="keadaan">
      <span className="ik" aria-hidden="true">
        {ikon}
      </span>
      <div className="keadaan-judul">{judul}</div>
      <div style={{ fontSize: 14 }}>{pesan}</div>
      {aksi && <div style={{ marginTop: 12 }}>{aksi}</div>}
    </div>
  );
}

/** Bungkus seragam untuk muat / galat / kosong. */
export function Wadah<T>({
  keadaan,
  kosong,
  children,
}: {
  keadaan: Keadaan<T>;
  kosong?: { judul: string; pesan: string; ikon?: string };
  children: (data: T) => ReactNode;
}) {
  if (keadaan.memuat && keadaan.data === null) return <Memuat />;
  if (keadaan.galat) return <Galat pesan={keadaan.galat} coba={keadaan.muatUlang} />;
  if (keadaan.data === null) {
    return <Kosong judul={kosong?.judul ?? 'Belum ada data'} pesan={kosong?.pesan ?? 'Data belum tersedia.'} ikon={kosong?.ikon} />;
  }
  return <>{children(keadaan.data)}</>;
}

/* ------------------------------------------------------------------- kartu */

export function Kartu({
  judul,
  aksi,
  children,
  style,
}: {
  judul?: string;
  aksi?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section className="kartu" style={style}>
      {(judul || aksi) && (
        <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {judul && <h3 className="kartu-judul" style={{ flex: '1 1 auto' }}>{judul}</h3>}
          {aksi}
        </header>
      )}
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------- lencana */

/** Label kepastian selalu terlihat di samping angka. */
export function ChipKepastian({ nilai }: { nilai: Kepastian | string }) {
  const kelas =
    nilai === 'terverifikasi' ? 'chip-aktual' : nilai === 'asumsi_sheet' ? 'chip-perkiraan' : 'chip-perkiraan';
  return <span className={`chip ${kelas}`}>{LABEL_KEPASTIAN[nilai] ?? nilai}</span>;
}

export function ChipRencana() {
  return <span className="chip chip-rencana">Rencana</span>;
}

export function ChipAktual() {
  return <span className="chip chip-aktual">Aktual</span>;
}

export function ChipVerifikasi({ teks = 'Perlu verifikasi' }: { teks?: string }) {
  return (
    <span className="chip chip-verifikasi">
      <span aria-hidden="true">!</span>
      {teks}
    </span>
  );
}

const IKON_RISIKO: Record<Risiko, string> = { aman: '✔', rendah: '▲', defisit: '■' };
const TEKS_RISIKO: Record<Risiko, string> = { aman: 'AMAN', rendah: 'RENDAH', defisit: 'DEFISIT' };

/** Status risiko memakai ikon + teks, bukan warna saja. */
export function StatusLencana({ status }: { status: Risiko }) {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true">{IKON_RISIKO[status]}</span>
      {TEKS_RISIKO[status]}
    </span>
  );
}

/* ------------------------------------------------------------- angka besar */

export function AngkaBesar({
  nilai,
  label,
  catatan,
  chip,
}: {
  nilai: string;
  label: string;
  catatan?: string;
  chip?: ReactNode;
}) {
  return (
    <div>
      <div className="angka-ket">{label}</div>
      <div className="angka-besar tab-num">{nilai}</div>
      <div className="renteng">
        {chip}
        {catatan && <span className="kecil">{catatan}</span>}
      </div>
    </div>
  );
}

export function Catatan({ children, peringatan }: { children: ReactNode; peringatan?: boolean }) {
  return <div className={`catatan${peringatan ? ' catatan-peringatan' : ''}`}>{children}</div>;
}
