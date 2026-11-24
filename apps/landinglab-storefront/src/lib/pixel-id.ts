// Pixel atual da landing aplicado ao HTML servido (o snippet gravado no clone
// fica com o ID da época da publicação).
/** Troca o ID gravado no snippet do pixel (fbq init / set autoConfig) pelo pixel atual. */
export function applyPixelId(html: string, pixelId: string | null): string {
  if (!pixelId) return html;
  return html.replace(
    /(fbq\(\s*['"](?:init|set)['"]\s*,\s*(?:['"]autoConfig['"]\s*,\s*['"]false['"]\s*,\s*)?['"])\d{6,20}(['"])/g,
    `$1${pixelId}$2`,
  );
}
