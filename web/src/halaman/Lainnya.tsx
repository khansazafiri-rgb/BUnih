const MENU: Array<{ href: string; e: string; judul: string; ket: string }> = [
  { href: '#/analitik', e: '📊', judul: 'Analitik', ket: 'Ke mana uangmu pergi, tren, langganan' },
  { href: '#/tujuan', e: '🐷', judul: 'Tujuan', ket: 'Tabung untuk laptop, liburan, dana darurat' },
  { href: '#/kategori', e: '🏷️', judul: 'Kategori & tempat', ket: 'Atur kategori dan nama toko' },
  { href: '#/reimburse', e: '🤝', judul: 'Reimburse', ket: 'Uang yang akan kembali' },
  { href: '#/tabungan', e: '💰', judul: 'Rekening & tabungan', ket: 'Saldo dan perpindahan uang' },
  { href: '#/rencana', e: '🔮', judul: 'Proyeksi & simulasi', ket: 'Kalau beli ini, apa dampaknya?' },
  { href: '#/arus-harian', e: '📈', judul: 'Arus harian', ket: 'Saldo hari demi hari' },
  { href: '#/periode', e: '🗓️', judul: 'Periode 5 hari', ket: 'Pembagian periode uang masuk' },
  { href: '#/pengaturan', e: '⚙️', judul: 'Pengaturan', ket: 'Tema, Telegram, Gmail, impor lama' },
];

export default function Lainnya() {
  return (
    <>
      <h1>Menu lainnya</h1>
      <p className="subjudul">Semua yang tidak muat di bilah bawah.</p>
      <div className="ubin-menu">
        {MENU.map((m) => (
          <a key={m.href} href={m.href}>
            <span className="e" aria-hidden="true">{m.e}</span>
            <b>{m.judul}</b>
            <span>{m.ket}</span>
          </a>
        ))}
      </div>
    </>
  );
}
