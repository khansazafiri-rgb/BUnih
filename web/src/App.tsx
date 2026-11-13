import { useEffect, useState } from 'react';
import { api } from './api';
import Beranda from './halaman/Beranda';
import ArusHarian from './halaman/ArusHarian';
import Periode from './halaman/Periode';
import Transaksi from './halaman/Transaksi';
import Anggaran from './halaman/Anggaran';
import Tagihan from './halaman/Tagihan';
import Reimburse from './halaman/Reimburse';
import Tabungan from './halaman/Tabungan';
import Pengaturan from './halaman/Pengaturan';
import Masuk from './halaman/Masuk';

type Rute = {
  jalur: string;
  nama: string;
  pendek: string;
  ikon: string;
  komponen: () => JSX.Element;
  utamaDiPonsel?: boolean;
};

const RUTE: Rute[] = [
  { jalur: '/', nama: 'Beranda', pendek: 'Beranda', ikon: '🏠', komponen: Beranda, utamaDiPonsel: true },
  { jalur: '/arus-harian', nama: 'Arus Harian', pendek: 'Harian', ikon: '📈', komponen: ArusHarian },
  { jalur: '/periode', nama: 'Periode 5 Hari', pendek: 'Periode', ikon: '🗓️', komponen: Periode },
  { jalur: '/transaksi', nama: 'Transaksi', pendek: 'Transaksi', ikon: '🧾', komponen: Transaksi, utamaDiPonsel: true },
  { jalur: '/anggaran', nama: 'Anggaran & Simulasi', pendek: 'Anggaran', ikon: '🎯', komponen: Anggaran, utamaDiPonsel: true },
  { jalur: '/tagihan', nama: 'Tagihan & Langganan', pendek: 'Tagihan', ikon: '🔔', komponen: Tagihan, utamaDiPonsel: true },
  { jalur: '/reimburse', nama: 'Reimburse & Talangan', pendek: 'Reimburse', ikon: '🤝', komponen: Reimburse },
  { jalur: '/tabungan', nama: 'Tabungan', pendek: 'Tabungan', ikon: '💰', komponen: Tabungan },
  { jalur: '/pengaturan', nama: 'Pengaturan', pendek: 'Lainnya', ikon: '⚙️', komponen: Pengaturan, utamaDiPonsel: true },
];

function jalurSekarang(): string {
  const h = window.location.hash.replace(/^#/, '');
  const tanpaQuery = h.split('?')[0] || '/';
  return tanpaQuery;
}

export default function App() {
  const [jalur, setJalur] = useState(jalurSekarang());
  const [masuk, setMasuk] = useState<boolean | null>(null);
  const [jumlahKeputusan, setJumlahKeputusan] = useState(0);

  useEffect(() => {
    const dengar = () => setJalur(jalurSekarang());
    window.addEventListener('hashchange', dengar);
    return () => window.removeEventListener('hashchange', dengar);
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
    return () => clearInterval(t);
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
  const ponsel = RUTE.filter((r) => r.utamaDiPonsel);

  return (
    <div className="kerangka">
      <nav className="samping" aria-label="Navigasi utama">
        <div className="merek">
          BUnih
          <span>pusat kendali keuangan</span>
        </div>
        <div className="aksi-samping">
          <a className="tombol tombol-utama tombol-kecil" href="#/anggaran">
            Tanya pembelian
          </a>
          <a className="tombol tombol-kecil" href="#/transaksi">
            Catat / koreksi
          </a>
        </div>
        {RUTE.map((r) => (
          <a
            key={r.jalur}
            className="nav-tautan"
            href={`#${r.jalur}`}
            aria-current={r.jalur === rute.jalur ? 'page' : undefined}
          >
            <span className="nav-ikon" aria-hidden="true">
              {r.ikon}
            </span>
            {r.nama}
            {r.jalur === '/transaksi' && jumlahKeputusan > 0 && (
              <span className="nav-lencana">{jumlahKeputusan}</span>
            )}
          </a>
        ))}
        <hr className="pisah" />
        <p className="kecil" style={{ padding: '0 10px' }}>
          Telegram adalah antarmuka utama untuk mencatat dan mengoreksi transaksi. Web ini untuk gambaran
          besar, asumsi, bukti, dan perbaikan rumit.
        </p>
      </nav>

      <main className="utama">
        <Halaman />
      </main>

      <div className="aksi-cepat">
        <a className="tombol tombol-utama tombol-kecil" href="#/anggaran" title="Tanya pembelian">
          Tanya pembelian
        </a>
        <a className="tombol tombol-kecil" href="#/transaksi" title="Catat atau koreksi">
          Catat / koreksi
        </a>
      </div>

      <nav className="bawah" aria-label="Navigasi ponsel">
        {ponsel.map((r) => (
          <a key={r.jalur} href={`#${r.jalur}`} aria-current={r.jalur === rute.jalur ? 'page' : undefined}>
            <span className="ik" aria-hidden="true">
              {r.ikon}
            </span>
            {r.pendek}
          </a>
        ))}
      </nav>
    </div>
  );
}
