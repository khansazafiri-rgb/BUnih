import { useState } from 'react';
import { api } from '../api';
import { Kartu } from '../components/dasar';

export default function Masuk({ onMasuk }: { onMasuk: () => void }) {
  const [kataSandi, setKataSandi] = useState('');
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const kirim = async (e: React.FormEvent) => {
    e.preventDefault();
    setSibuk(true);
    setGalat(null);
    try {
      await api.post('/masuk', { kata_sandi: kataSandi });
      onMasuk();
      window.location.hash = '#/';
    } catch (err) {
      setGalat(err instanceof Error ? err.message : 'Gagal masuk.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: '8vh auto 0' }}>
      <div className="merek" style={{ padding: '0 0 16px' }}>
        BUnih
        <span>pusat kendali keuangan pribadi</span>
      </div>
      <Kartu judul="Masuk">
        <form onSubmit={kirim}>
          <div className="bidang">
            <label htmlFor="ks">Kata sandi</label>
            <input
              id="ks"
              type="password"
              value={kataSandi}
              onChange={(e) => setKataSandi(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          {galat && (
            <div className="galat" role="alert" style={{ marginBottom: 12 }}>
              {galat}
            </div>
          )}
          <button className="tombol tombol-utama" type="submit" disabled={sibuk || !kataSandi} style={{ width: '100%' }}>
            Masuk
          </button>
        </form>
        <p className="kecil" style={{ marginTop: 14, marginBottom: 0 }}>
          Aplikasi ini tidak pernah meminta OTP, PIN, atau kata sandi bank. Kata sandi di atas hanya untuk
          membuka aplikasi ini.
        </p>
      </Kartu>
    </div>
  );
}
