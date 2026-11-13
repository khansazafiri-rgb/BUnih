/** Normalkan nama merchant agar pencocokan stabil: huruf kecil, tanpa tanda baca, tanpa kata badan usaha. */
export function normalizeMerchant(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(pt|cv|tbk|inc|llc|ltd|co|id|com|www)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}
