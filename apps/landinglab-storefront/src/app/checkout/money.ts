// Formatação de valores em unidade mínima no idioma do mercado.
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatMinor(minor: number, currency: string, locale: string): string {
  const value = minor / Math.pow(10, minorDigits(currency));
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(minorDigits(currency))} ${currency}`;
  }
}
