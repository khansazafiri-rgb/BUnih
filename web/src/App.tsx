import { useEffect, useState } from 'react';
import { api } from './api';
import FormCatat, { bukaCatat } from './components/FormCatat';
import Dashboard from './halaman/Dashboard';
import Analitik from './halaman/Analitik';
import Transaksi from './halaman/Transaksi';
import Anggaran from './halaman/Anggaran';
import Tujuan from './halaman/Tujuan';
import Tagihan from './halaman/Tagihan';
import Reimburse from './halaman/Reimburse';
import Tabungan from './halaman/Tabungan';
import Kategori from './halaman/Kategori';
import Rencana from './halaman/Rencana';
import ArusHarian from './halaman/ArusHarian';
import Periode from './halaman/Periode';
import Lainnya from './halaman/Lainnya';
import Pengaturan from './halaman/Pengaturan';
import Masuk from './halaman/Masuk';

type Rute = {
  jalur: string;
  nama: string;
  pendek: string;
  ikon: string;
  komponen: () => JSX.Element;
  kelompok: string;
  /** Slot di bilah bawah ponsel (menu lain ada di halaman "Lainnya"). */
  ponsel?: boolean;
};

const RUTE: Rute[] = [
  { jalur: '/', nama: 'Dashboard', pendek: 'Beranda', ikon: '🏠', komponen: Dashboard, kelompok: 'Utama', ponsel: true },
  { jalur: '/transaksi', nama: 'Transaksi', pendek: 'Transaksi', ikon: '🧾', komponen: Transaksi, kelompok: 'Utama', ponsel: true },
  { jalur: '/analitik', nama: 'Analitik', pendek: 'Analitik', ikon: '📊', komponen: Analitik, kelompok: 'Utama' },
  { jalur: '/anggaran', nama: 'Anggaran', pendek: 'Anggaran', ikon: '🎯', komponen: Anggaran, kelompok: 'Rencana', ponsel: true },
  { jalur: '/tujuan', nama: 'Tujuan', pendek: 'Tujuan', ikon: '🐷', komponen: Tujuan, kelompok: 'Rencana' },
  { jalur: '/tagihan', nama: 'Tagihan & Langganan', pendek: 'Tagihan', ikon: '🔔', komponen: Tagihan, kelompok: 'Rencana' },
  { jalur: '/reimburse', nama: 'Reimburse', pendek: 'Reimburse', ikon: '🤝', komponen: Reimburse, kelompok: 'Rencana' },
  { jalur: '/tabungan', nama: 'Rekening & Tabungan', pendek: 'Rekening', ikon: '💰', komponen: Tabungan, kelompok: 'Uang' },
  { jalur: '/kategori', nama: 'Kategori & Tempat', pendek: 'Kategori', ikon: '🏷️', komponen: Kategori, kelompok: 'Uang' },
  { jalur: '/rencana', nama: 'Proyeksi & Simulasi', pendek: 'Proyeksi', ikon: '🔮', komponen: Rencana, kelompok: 'Lanjutan' },
  { jalur: '/arus-harian', nama: 'Arus Harian', pendek: 'Harian', ikon: '📈', komponen: ArusHarian, kelompok: 'Lanjutan' },
  { jalur: '/periode', nama: 'Periode 5 Hari', pendek: 'Periode', ikon: '🗓️', komponen: Periode, kelompok: 'Lanjutan' },
  { jalur: '/pengaturan', nama: 'Pengaturan', pendek: 'Pengaturan', ikon: '⚙️', komponen: Pengaturan, kelompok: 'Sistem' },
  { jalur: '/lainnya', nama: 'Menu lainnya', pendek: 'Lainnya', ikon: '☰', komponen: Lainnya, kelompok: '' },
];

const KELOMPOK = ['Utama', 'Rencana', 'Uang', 'Lanjutan', 'Sistem'];
const SLOT_PONSEL = ['/', '/transaksi', 'CATAT', '/anggaran', '/lainnya'];

function jalurSekarang(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h.split('?')[0] || '/';
}

export default function App() {
  const [jalur, setJalur] = useState(jalurSekarang());
  const [masuk, setMasuk] = useState<boolean | null>(null);
  const [jumlahKeputusan, setJumlahKeputusan] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const dengar = () => {
      setJalur(jalurSekarang());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', dengar);
    return () => window.removeEventListener('hashchange', dengar);
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const dengar = (e: Event) => {
      setToast(String((e as CustomEvent).detail ?? ''));
      if (t) clearTimeout(t);
      t = setTimeout(() => setToast(null), 3200);
    };
    window.addEventListener('bunih:toast', dengar);
    return () => {
      window.removeEventListener('bunih:toast', dengar);
      if (t) clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    try {
      const t = localStorage.getItem('bunih-tema');
      if (t && t !== 'sistem') document.documentElement.dataset.tema = t;
    } catch {
      /* abaikan */
    }
  }, []);

  useEffect(() => {
    api
      .get<{ masuk: boolean; butuh_kata_sandi: boolean }>('/saya')
      .then((d) => setMasuk(d.masuk || !d.butuh_kata_sandi))
      .catch(() => setMasuk(false));
  }, []);

  useEffect(() => {
    if (!masuk) return;
    const muat = () =>
      api
        .get<Array<unknown>>('/keputusan')
        .then((d) => setJumlahKeputusan(d.length))
        .catch(() => undefined);
    void muat();
    const t = setInterval(muat, 60_000);
    window.addEventListener('bunih:diubah', muat);
    return () => {
      clearInterval(t);
      window.removeEventListener('bunih:diubah', muat);
    };
  }, [masuk, jalur]);

  if (masuk === null) {
    return (
      <div style={{ padding: 28 }}>
        <div className="memuat" style={{ width: '40%' }} />
        <div className="memuat" style={{ width: '70%' }} />
      </div>
    );
  }

  if (!masuk || jalur === '/masuk') {
    return <Masuk onMasuk={() => setMasuk(true)} />;
  }

  const rute = RUTE.find((r) => r.jalur === jalur) ?? RUTE[0]!;
  const Halaman = rute.komponen;
  // "Lainnya" menyala untuk semua halaman yang tidak punya slot sendiri di ponsel.
  const aktifPonsel = rute.ponsel ? rute.jalur : '/lainnya';

  return (
    <div className="kerangka">
      <nav className="samping" aria-label="Navigasi utama">
        <div className="merek">
          BUnih
          <span>keuangan pribadi yang mudah dibaca</span>
        </div>
        {KELOMPOK.map((k) => (
          <div key={k}>
            <div className="nav-kelompok">{k}</div>
            {RUTE.filter((r) => r.kelompok === k).map((r) => (
              <a key={r.jalur} className="nav-tautan" href={`#${r.jalur}`} aria-current={r.jalur === rute.jalur ? 'page' : undefined}>
                <span className="nav-ikon" aria-hidden="true">{r.ikon}</span>
                {r.nama}
                {r.jalur === '/transaksi' && jumlahKeputusan > 0 && <span className="nav-lencana" aria-label={`${jumlahKeputusan} perlu keputusan`}>{jumlahKeputusan}</span>}
              </a>
            ))}
          </div>
        ))}
        <hr className="pisah" />
        <p className="kecil" style={{ padding: '0 10px' }}>
          Catat dari sini, dari Telegram, atau biarkan Gmail membantu. Semua masuk ke satu buku yang sama.
        </p>
      </nav>

      <main className="utama" id="isi">
        <Halaman />
      </main>

      <button type="button" className="tombol-catat fab-catat" onClick={() => bukaCatat()}>
        <span aria-hidden="true">＋</span> Catat
      </button>

      <nav className="bawah" aria-label="Navigasi ponsel">
        {SLOT_PONSEL.map((s) => {
          if (s === 'CATAT') {
            return (
              <div key="catat" className="bawah-tengah">
                <button type="button" aria-label="Catat transaksi" onClick={() => bukaCatat()}>＋</button>
              </div>
            );
          }
          const r = RUTE.find((x) => x.jalur === s)!;
          return (
            <a key={r.jalur} href={`#${r.jalur}`} aria-current={r.jalur === aktifPonsel ? 'page' : undefined}>
              <span className="ik" aria-hidden="true">{r.ikon}</span>
              {r.pendek}
            </a>
          );
        })}
      </nav>

      <FormCatat />
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </div>
  );
}
