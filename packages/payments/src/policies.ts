// Políticas padrão das lojas LandingLab por mercado/idioma (Story 15.4, D16, AC11).
//
// Módulo puro (sem I/O): a API guarda o estado em landing_markets.policies e a
// identidade jurídica em landing_markets.seller_info; aqui ficam os textos
// padrão, a renderização dos placeholders e a regra de publicação.
//
// Mesmo mecanismo i18n do checkout: dicionário por idioma (2 letras), fallback
// 'en'. Só o italiano é texto completo (decisão 8 / Story 15.7).
//
// Story 15.7: os textos it seguem os requisitos de site da Stripe e o Codice
// del Consumo/GDPR. O que só o owner sabe fica no texto como marcador visível
// `[PREENCHER: ...]` (não em seller_info); enquanto houver algum, a política não
// pode ser publicada nem servida. Placeholders {{...}} automáticos (marca,
// e-mail, frete, países) são resolvidos na hora de servir; os de identidade
// jurídica continuam funcionando em textos que os usem.

export const POLICY_SLUGS = [
  'refund-policy',
  'shipping-policy',
  'privacy-policy',
  'terms-of-service',
  'contact-information',
] as const;
export type PolicySlug = (typeof POLICY_SLUGS)[number];
export type PolicyStatus = 'draft' | 'published';

export function isPolicySlug(value: unknown): value is PolicySlug {
  return typeof value === 'string' && (POLICY_SLUGS as readonly string[]).includes(value);
}

export interface StoredPolicy {
  status: PolicyStatus;
  /** HTML editado pelo owner (com placeholders). Ausente = texto padrão do idioma. */
  html?: string | null;
  updatedAt?: string;
  publishedAt?: string | null;
}
export type MarketPolicies = Partial<Record<PolicySlug, StoredPolicy>>;

export type ReturnShippingPayer = 'customer' | 'seller';

export interface SellerInfo {
  legalName?: string;
  legalAddress?: string;
  vatId?: string;
  refundWindowDays?: number;
  returnShippingPayer?: ReturnShippingPayer;
}

export interface PolicyShipping {
  shippingFreeEnabled: boolean;
  shippingFreeLabel: string;
  shippingFreeMinDays: number;
  shippingFreeMaxDays: number;
  shippingExpressEnabled: boolean;
  shippingExpressLabel: string;
  shippingExpressMinor: number;
  shippingExpressMinDays: number;
  shippingExpressMaxDays: number;
}

export interface PolicyMarket extends PolicyShipping {
  locale: string;
  currency: string;
  countryCodes: string[];
}

export interface PolicyContext {
  brand: string;
  seller: SellerInfo;
  market: PolicyMarket;
  supportEmail: string;
}

export const POLICY_PLACEHOLDERS = [
  'brand',
  'legal_name',
  'legal_address',
  'vat_line',
  'support_email',
  'refund_window_days',
  'return_shipping_payer',
  'shipping_methods',
  'countries',
] as const;
type Placeholder = (typeof POLICY_PLACEHOLDERS)[number];

/** Placeholders que podem ficar vazios sem bloquear a publicação. */
const OPTIONAL_PLACEHOLDERS: ReadonlySet<Placeholder> = new Set(['vat_line']);

const PLACEHOLDER_FIELD: Partial<Record<Placeholder, keyof SellerInfo>> = {
  legal_name: 'legalName',
  legal_address: 'legalAddress',
  refund_window_days: 'refundWindowDays',
  return_shipping_payer: 'returnShippingPayer',
};

export interface PolicyIssue {
  code: 'pending_owner_text' | 'missing_seller_field' | 'unknown_placeholder' | 'empty_text';
  field?: string;
  message: string;
}

// ─── parsing do jsonb ────────────────────────────────────────────────────

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed ? trimmed : undefined;
}

export function parseSellerInfo(raw: unknown): SellerInfo {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: SellerInfo = {};
  const legalName = str(r['legalName'], 200);
  const legalAddress = str(r['legalAddress'], 500);
  const vatId = str(r['vatId'], 60);
  if (legalName) out.legalName = legalName;
  if (legalAddress) out.legalAddress = legalAddress;
  if (vatId) out.vatId = vatId;
  const days = r['refundWindowDays'];
  if (typeof days === 'number' && Number.isInteger(days) && days > 0 && days <= 365) out.refundWindowDays = days;
  const payer = r['returnShippingPayer'];
  if (payer === 'customer' || payer === 'seller') out.returnShippingPayer = payer;
  return out;
}

export function parseMarketPolicies(raw: unknown): MarketPolicies {
  if (!raw || typeof raw !== 'object') return {};
  const out: MarketPolicies = {};
  for (const slug of POLICY_SLUGS) {
    const p = (raw as Record<string, unknown>)[slug];
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    out[slug] = {
      status: r['status'] === 'published' ? 'published' : 'draft',
      html: typeof r['html'] === 'string' ? r['html'] : null,
      ...(typeof r['updatedAt'] === 'string' ? { updatedAt: r['updatedAt'] } : {}),
      publishedAt: typeof r['publishedAt'] === 'string' ? r['publishedAt'] : null,
    };
  }
  return out;
}

// ─── textos ──────────────────────────────────────────────────────────────

interface PolicyStrings {
  titles: Record<PolicySlug, string>;
  defaults: Record<PolicySlug, string>;
  businessDays: string;
  free: string;
  vat: string;
  returnPayer: Record<ReturnShippingPayer, string>;
}

// ─── marcadores para o owner (Story 15.7) ────────────────────────────────
//
// Trechos que só o owner sabe. Ficam visíveis no texto como
// `[PREENCHER: explicação]`; enquanto houver algum, a política não pode ser
// publicada nem servida (policyPublishIssues → pending_owner_text). O mesmo
// marcador se repete onde a mesma informação aparece.
const OWNER = {
  legalName: `[PREENCHER: razão social completa da empresa vendedora, ex.: "Rossi Commerce S.r.l."]`,
  legalAddress: `[PREENCHER: endereço completo da sede da empresa (rua, número, CEP, cidade, país), ex.: "Via Roma 1, 20121 Milano (MI), Italia"]`,
  vat: `[PREENCHER: Partita IVA / VAT ou número de registro da empresa, ex.: "P. IVA IT12345678901" — se a empresa não tiver, apague o marcador inteiro]`,
  phone: `[PREENCHER: telefone de atendimento com DDI, ex.: "Telefono: +39 02 1234567" — se não tiver telefone de atendimento, apague o marcador inteiro]`,
  returnCost: `[PREENCHER: quem paga o frete da devolução — escreva exatamente "a carico del cliente" ou "a nostro carico"]`,
  responseTime: `[PREENCHER: em quanto tempo o suporte responde, escrito em italiano, ex.: "entro 2 giorni lavorativi"]`,
  origin: `[PREENCHER: de onde os pedidos são enviados e se o cliente paga alfândega, escrito em italiano. Se envia de dentro da UE, cole: "Gli ordini sono spediti da un magazzino situato nell'Unione europea: alla consegna non sono previsti dazi né altri costi a tuo carico." Se envia de fora da UE com o IVA já incluído no preço (IOSS), cole: "Gli ordini sono spediti da un magazzino situato fuori dall'Unione europea. L'IVA all'importazione è già inclusa nel prezzo: alla consegna non sono previsti dazi né altri costi a tuo carico."]`,
  updatedAt: `[PREENCHER: data desta versão do texto, em italiano, ex.: "7 ottobre 2026" — ou apague a linha inteira]`,
} as const;

/** Bloco de identificação do vendedor (Termos e Contato). */
const sellerBlockIt = `<p><strong>${OWNER.legalName}</strong><br>${OWNER.legalAddress}<br>${OWNER.vat}<br>Email: <a href="mailto:{{support_email}}">{{support_email}}</a><br>${OWNER.phone}</p>`;
const contactBlockEn = `<p>{{legal_name}}<br>{{legal_address}}<br>{{vat_line}}Email: {{support_email}}</p>`;

const MANAGE_SUBSCRIPTION_IT =
  'tramite il link «Gestisci l’abbonamento» presente nelle email del tuo ordine oppure dalla pagina «Traccia il tuo ordine» del sito (con il numero dell’ordine e la tua email), che ti porta al portale clienti sicuro di Stripe';

const it: PolicyStrings = {
  titles: {
    'refund-policy': 'Politica di rimborso',
    'shipping-policy': 'Politica di spedizione',
    'privacy-policy': 'Informativa sulla privacy',
    'terms-of-service': 'Termini di servizio',
    'contact-information': 'Informazioni di contatto',
  },
  businessDays: 'giorni lavorativi',
  free: 'Gratis',
  vat: 'P. IVA / VAT',
  returnPayer: { customer: 'a carico del cliente', seller: 'a carico del venditore' },
  defaults: {
    'refund-policy': [
      `<p>La presente politica descrive come restituire i prodotti acquistati sul sito {{brand}} e come ottenere il rimborso. Il venditore è ${OWNER.legalName} (di seguito "noi"). Come consumatore ti spettano in ogni caso i diritti previsti dal Codice del Consumo (D.Lgs. 206/2005) e dalle norme inderogabili a tutela dei consumatori del tuo paese di residenza.</p>`,
      `<h2>Diritto di recesso entro 14 giorni</h2>`,
      `<p>Hai il diritto di recedere dal contratto, senza indicarne le ragioni e senza alcuna penalità, entro 14 giorni (artt. 52 e ss. del Codice del Consumo).</p>`,
      `<p>Il periodo di recesso scade dopo 14 giorni dal giorno in cui tu, o un terzo da te designato diverso dal vettore, acquisisci il possesso fisico dei beni. Se hai ordinato più beni consegnati separatamente, il termine decorre dal giorno in cui acquisisci il possesso fisico dell'ultimo bene. Per gli abbonamenti con consegna periodica di beni, il termine decorre dal giorno in cui acquisisci il possesso fisico del primo bene.</p>`,
      `<h2>Come esercitare il recesso</h2>`,
      `<p>Per esercitare il diritto di recesso devi informarci della tua decisione con una dichiarazione esplicita, inviata via email a {{support_email}} oppure per posta all'indirizzo indicato nel modulo qui sotto, indicando il numero dell'ordine. Puoi utilizzare il modulo di recesso tipo riportato in fondo a questa pagina, ma non è obbligatorio. Per rispettare il termine è sufficiente inviare la comunicazione prima della scadenza del periodo di recesso. Ti confermeremo via email il ricevimento della richiesta.</p>`,
      `<h2>Restituzione dei prodotti</h2>`,
      `<p>Dopo la tua richiesta ti indicheremo via email l'indirizzo a cui restituire i prodotti. Devi rispedirli senza indebiti ritardi e in ogni caso entro 14 giorni dal giorno in cui ci hai comunicato il recesso; il termine è rispettato se rispedisci i beni prima della sua scadenza. I costi diretti della restituzione dei beni sono ${OWNER.returnCost}.</p>`,
      `<p>Sei responsabile solo della diminuzione del valore dei beni risultante da una manipolazione diversa da quella necessaria per stabilirne la natura, le caratteristiche e il funzionamento. Ti consigliamo di usare una spedizione tracciabile e di conservarne la ricevuta.</p>`,
      `<h2>Rimborso</h2>`,
      `<p>Ti rimborseremo tutti i pagamenti ricevuti per l'ordine, compresi i costi di consegna standard, senza indebiti ritardi e in ogni caso entro 14 giorni dal giorno in cui siamo informati della tua decisione di recedere. Se hai scelto espressamente un tipo di consegna diverso da quello meno costoso da noi offerto (ad esempio la spedizione espressa), non siamo tenuti a rimborsare i costi supplementari.</p>`,
      `<p>Il rimborso viene effettuato tramite Stripe utilizzando lo stesso mezzo di pagamento che hai usato per l'acquisto (ad esempio la stessa carta, Apple Pay o Google Pay), salvo che tu abbia espressamente convenuto altrimenti; in ogni caso non dovrai sostenere alcun costo per il rimborso. Possiamo trattenere il rimborso finché non abbiamo ricevuto i beni oppure finché non ci hai dimostrato di averli rispediti, se questa situazione si verifica prima. I tempi di accredito sul tuo conto dipendono dalla tua banca o dall'emittente della carta.</p>`,
      `<h2>Esclusioni dal diritto di recesso</h2>`,
      `<p>Come previsto dall'art. 59 del Codice del Consumo, il diritto di recesso è escluso, tra l'altro, per i beni sigillati che non si prestano a essere restituiti per motivi igienici o connessi alla protezione della salute e che sono stati aperti dopo la consegna, per i beni che rischiano di deteriorarsi o scadere rapidamente e per i beni confezionati su misura o chiaramente personalizzati.</p>`,
      `<h2>Prodotti danneggiati, difettosi o non conformi</h2>`,
      `<p>Se ricevi un prodotto danneggiato, difettoso o diverso da quello ordinato, oppure se manca qualcosa, scrivi a {{support_email}} indicando il numero dell'ordine e allegando alcune foto del prodotto e dell'imballo. Oltre al diritto di recesso, ti spetta la garanzia legale di conformità di 24 mesi dalla consegna (artt. 128 e ss. del Codice del Consumo): hai diritto, senza spese, al ripristino della conformità mediante riparazione o sostituzione oppure, nei casi previsti dalla legge, a una riduzione del prezzo o alla risoluzione del contratto con rimborso. Le spese di restituzione dei prodotti non conformi sono a nostro carico.</p>`,
      `<h2>Cancellazione dell'abbonamento</h2>`,
      `<p>Se hai acquistato un abbonamento, puoi annullarlo in qualsiasi momento, senza costi e senza indicarne il motivo, ${MANAGE_SUBSCRIPTION_IT}. La cancellazione ha effetto alla fine del periodo già pagato e da quel momento non verranno addebitati ulteriori rinnovi. La cancellazione non comporta il rimborso automatico dei pagamenti già effettuati: per gli ordini già pagati restano validi il diritto di recesso, nei termini indicati sopra, e la garanzia legale.</p>`,
      `<h2>Modulo di recesso tipo</h2>`,
      `<p><em>(Allegato I, parte B, del Codice del Consumo — compilare e restituire il presente modulo solo se si desidera recedere dal contratto)</em></p>`,
      `<ul>`,
      `<li>Destinatario: ${OWNER.legalName}, ${OWNER.legalAddress}, email: {{support_email}}</li>`,
      `<li>Con la presente io/noi (*) notifichiamo il recesso dal mio/nostro (*) contratto di vendita dei seguenti beni/servizi (*): ……</li>`,
      `<li>Ordinato il (*) / ricevuto il (*): ……</li>`,
      `<li>Nome del/dei consumatore(i): ……</li>`,
      `<li>Indirizzo del/dei consumatore(i): ……</li>`,
      `<li>Firma del/dei consumatore(i) (solo se il presente modulo è notificato in versione cartacea): ……</li>`,
      `<li>Data: ……</li>`,
      `</ul>`,
      `<p>(*) Cancellare la dicitura inutile.</p>`,
    ].join('\n'),
    'shipping-policy': [
      `<p>La presente politica descrive come spediamo gli ordini effettuati sul sito {{brand}}.</p>`,
      `<h2>Paesi di spedizione</h2>`,
      `<p>Spediamo esclusivamente verso i seguenti paesi: {{countries}}. Non accettiamo ordini con indirizzo di consegna in altri paesi.</p>`,
      `<h2>Metodi, costi e tempi di spedizione</h2>`,
      `{{shipping_methods}}`,
      `<p>Il costo del metodo scelto è indicato al checkout prima del pagamento ed è compreso nel totale dell'ordine. I tempi indicati sono stime espresse in giorni lavorativi (dal lunedì al venerdì, esclusi i festivi) e non costituiscono una data di consegna garantita: possono variare per cause indipendenti dalla nostra volontà, ad esempio ritardi del corriere o controlli doganali.</p>`,
      `<p>Abbonamenti: le spese di spedizione sono addebitate solo con il primo pagamento; gli ordini generati dai rinnovi sono spediti senza ulteriori spese di spedizione.</p>`,
      `<h2>Provenienza della spedizione, dazi e tasse</h2>`,
      `<p>${OWNER.origin}</p>`,
      `<h2>Elaborazione e tracciamento dell'ordine</h2>`,
      `<p>Dopo il pagamento ricevi un'email di conferma con il numero dell'ordine. Quando l'ordine viene spedito ti inviamo un'email con il nome del corriere e, se disponibile, il codice di tracciamento. Puoi verificare lo stato dell'ordine in qualsiasi momento nella pagina «Traccia il tuo ordine» del sito, con il numero dell'ordine e la tua email.</p>`,
      `<h2>Indirizzo di consegna</h2>`,
      `<p>Controlla con attenzione l'indirizzo inserito al checkout. Se ti accorgi di un errore, scrivici subito a {{support_email}}: se l'ordine non è ancora stato spedito possiamo correggerlo.</p>`,
      `<h2>Ritardi, smarrimenti e danni</h2>`,
      `<p>Il rischio di perdita o danneggiamento dei beni passa a te solo quando tu, o un terzo da te designato diverso dal vettore, entri materialmente in possesso dei beni (art. 63 del Codice del Consumo). Se il pacco risulta smarrito, arriva danneggiato o non ti viene consegnato, scrivi a {{support_email}} indicando il numero dell'ordine: d'accordo con te provvederemo a una nuova spedizione senza costi o al rimborso integrale. Restano salvi i diritti previsti dall'art. 61 del Codice del Consumo in caso di mancata consegna, compreso il diritto di risolvere il contratto e di ottenere il rimborso di quanto pagato.</p>`,
      `<h2>Restrizioni legali e di esportazione</h2>`,
      `<p>I prodotti sono venduti esclusivamente a consumatori maggiorenni, per uso personale e non per la rivendita, e sono spediti solo nei paesi indicati sopra. Non vendiamo né spediamo verso paesi, territori o persone soggetti a sanzioni o restrizioni commerciali dell'Unione europea o internazionali. Possiamo annullare e rimborsare integralmente un ordine che non rispetta queste condizioni.</p>`,
      `<h2>Contatti</h2>`,
      `<p>Per qualsiasi domanda sulla spedizione scrivi a {{support_email}} indicando il numero dell'ordine.</p>`,
    ].join('\n'),
    'privacy-policy': [
      `<p>La presente informativa, resa ai sensi degli artt. 13 e 14 del Regolamento (UE) 2016/679 ("GDPR") e del D.Lgs. 196/2003 ("Codice Privacy"), descrive come trattiamo i dati personali di chi visita il sito {{brand}} e di chi vi effettua un acquisto.</p>`,
      `<h2>Titolare del trattamento</h2>`,
      `<p>${OWNER.legalName}<br>${OWNER.legalAddress}<br>Email: <a href="mailto:{{support_email}}">{{support_email}}</a></p>`,
      `<p>Per qualsiasi richiesta relativa ai tuoi dati personali puoi scrivere all'indirizzo email indicato.</p>`,
      `<h2>Dati che trattiamo</h2>`,
      `<ul>`,
      `<li><strong>Dati identificativi e di contatto</strong>: nome e cognome, indirizzo email, numero di telefono (se fornito).</li>`,
      `<li><strong>Dati di spedizione e fatturazione</strong>: indirizzo di consegna e, se diverso, di fatturazione.</li>`,
      `<li><strong>Dati dell'ordine</strong>: prodotti acquistati, importi, eventuale abbonamento, spedizioni, resi e rimborsi.</li>`,
      `<li><strong>Dati di pagamento</strong>: i pagamenti sono elaborati da Stripe. Non riceviamo né conserviamo il numero completo della tua carta; Stripe ci comunica solo informazioni limitate (ad esempio il circuito, le ultime quattro cifre e l'esito del pagamento).</li>`,
      `<li><strong>Comunicazioni con l'assistenza</strong>: il contenuto delle email che ci invii.</li>`,
      `<li><strong>Dati di navigazione</strong>: indirizzo IP, tipo di browser e di dispositivo, pagine visitate e interazioni con il sito, raccolti anche tramite cookie e strumenti analoghi (vedi la sezione "Cookie e Pixel di Meta").</li>`,
      `</ul>`,
      `<h2>Finalità e basi giuridiche</h2>`,
      `<ul>`,
      `<li>Gestire l'ordine, il pagamento, la spedizione, gli eventuali abbonamenti, i resi, i rimborsi e l'assistenza: esecuzione del contratto (art. 6, par. 1, lett. b GDPR).</li>`,
      `<li>Adempiere agli obblighi di legge, ad esempio contabili e fiscali: obbligo legale (art. 6, par. 1, lett. c GDPR).</li>`,
      `<li>Prevenire frodi e usi illeciti dei mezzi di pagamento, garantire la sicurezza del sito e tutelare i nostri diritti: legittimo interesse (art. 6, par. 1, lett. f GDPR).</li>`,
      `<li>Misurare l'efficacia delle nostre campagne pubblicitarie e mostrarti annunci pertinenti tramite il Pixel e la Conversions API di Meta: consenso (art. 6, par. 1, lett. a GDPR e art. 122 Codice Privacy), revocabile in qualsiasi momento.</li>`,
      `<li>Inviarti comunicazioni promozionali via email: solo con il tuo consenso, revocabile in qualsiasi momento.</li>`,
      `</ul>`,
      `<p>Il conferimento dei dati necessari all'ordine è obbligatorio: senza di essi non possiamo concludere ed eseguire il contratto.</p>`,
      `<h2>Destinatari e responsabili del trattamento</h2>`,
      `<p>Comunichiamo i dati solo ai soggetti necessari per le finalità indicate, che agiscono come responsabili del trattamento per nostro conto o, dove indicato, come titolari autonomi:</p>`,
      `<ul>`,
      `<li><strong>Stripe</strong> (società del gruppo Stripe, tra cui Stripe Payments Europe Ltd. e Stripe, Inc.): elaborazione dei pagamenti, degli abbonamenti e dei rimborsi e prevenzione delle frodi. Per alcune finalità, come la prevenzione delle frodi e gli obblighi normativi, Stripe agisce come titolare autonomo (<a href="https://stripe.com/it/privacy">stripe.com/it/privacy</a>).</li>`,
      `<li><strong>Resend</strong> (Resend, Inc., USA): invio delle email relative all'ordine, all'abbonamento e all'assistenza.</li>`,
      `<li><strong>Vercel</strong> (Vercel Inc., USA): hosting del sito.</li>`,
      `<li><strong>Supabase</strong> (Supabase, Inc., USA): database in cui sono archiviati gli ordini e i dati dei clienti.</li>`,
      `<li><strong>Meta</strong> (Meta Platforms Ireland Ltd. e Meta Platforms, Inc., USA): misurazione e ottimizzazione della pubblicità tramite il Pixel e la Conversions API. Per la raccolta e la trasmissione di questi dati Meta agisce come contitolare insieme a noi e, per i trattamenti successivi, come titolare autonomo (<a href="https://www.facebook.com/privacy/policy">facebook.com/privacy/policy</a>).</li>`,
      `<li><strong>Corrieri e partner logistici</strong> incaricati della preparazione e della consegna degli ordini.</li>`,
      `<li>Consulenti e autorità pubbliche, quando necessario per adempiere a obblighi di legge o per tutelare i nostri diritti.</li>`,
      `</ul>`,
      `<p>Non vendiamo i tuoi dati personali.</p>`,
      `<h2>Trasferimenti fuori dallo Spazio economico europeo</h2>`,
      `<p>Alcuni dei fornitori indicati hanno sede o trattano dati negli Stati Uniti o in altri paesi al di fuori dello Spazio economico europeo. In questi casi il trasferimento avviene sulla base delle clausole contrattuali standard approvate dalla Commissione europea (art. 46 GDPR) e, se il fornitore vi aderisce, del Data Privacy Framework UE-USA (decisione di adeguatezza della Commissione europea, art. 45 GDPR). Puoi chiedere informazioni sulle garanzie adottate scrivendo a {{support_email}}.</p>`,
      `<h2>Conservazione dei dati</h2>`,
      `<ul>`,
      `<li>Dati degli ordini e documenti contabili e fiscali (ricevute, registrazioni di pagamenti e rimborsi): 10 anni, come previsto dall'art. 2220 del Codice civile e dalla normativa fiscale.</li>`,
      `<li>Dati necessari per la gestione della garanzia legale e di eventuali contestazioni: per la durata della garanzia e fino alla prescrizione dei relativi diritti.</li>`,
      `<li>Dati degli abbonamenti: per tutta la durata dell'abbonamento e, dopo la cancellazione, secondo i termini indicati sopra.</li>`,
      `<li>Comunicazioni con l'assistenza: per il tempo necessario a gestire la richiesta e comunque non oltre 24 mesi dalla sua chiusura, salvo che servano a tutelare un nostro diritto.</li>`,
      `<li>Dati raccolti tramite il Pixel di Meta: secondo la durata dei cookie indicata nella sezione "Cookie e Pixel di Meta". Dati usati per finalità promozionali: fino alla revoca del consenso.</li>`,
      `</ul>`,
      `<h2>I tuoi diritti</h2>`,
      `<p>In qualsiasi momento puoi esercitare i diritti previsti dagli artt. 15-22 GDPR: accesso ai tuoi dati, rettifica, cancellazione, limitazione del trattamento, portabilità, opposizione al trattamento basato sul legittimo interesse e revoca del consenso, senza pregiudicare la liceità del trattamento effettuato prima della revoca. Per esercitarli scrivi a {{support_email}}: ti risponderemo entro un mese dalla richiesta, termine prorogabile nei casi previsti dall'art. 12 GDPR.</p>`,
      `<p>Se ritieni che il trattamento dei tuoi dati violi il GDPR, hai il diritto di proporre reclamo al Garante per la protezione dei dati personali (<a href="https://www.garanteprivacy.it">www.garanteprivacy.it</a>) oppure all'autorità di controllo del paese in cui risiedi o lavori.</p>`,
      `<h2>Cookie e Pixel di Meta</h2>`,
      `<p>Il sito utilizza cookie tecnici necessari al funzionamento del sito e del checkout (ad esempio per mantenere la sessione di pagamento e per la prevenzione delle frodi di Stripe), per i quali non è richiesto il consenso.</p>`,
      `<p>Utilizziamo inoltre il Pixel di Meta, uno strumento di marketing che, tramite cookie (ad esempio il cookie _fbp, con durata di 90 giorni) e tecnologie analoghe, raccoglie informazioni sulle tue visite e sui tuoi acquisti per misurare e ottimizzare le nostre campagne su Facebook e Instagram. Gli stessi eventi possono essere inviati a Meta dai nostri server tramite la Conversions API, con i dati di contatto in forma crittografata (hash). Questi strumenti si basano sul tuo consenso: puoi rifiutarlo o revocarlo in qualsiasi momento, anche cancellando i cookie dal browser e gestendo le preferenze pubblicitarie nelle impostazioni del tuo account Meta.</p>`,
      `<h2>Sicurezza dei dati di pagamento</h2>`,
      `<p>Il sito utilizza connessioni cifrate (HTTPS). I dati della carta vengono inseriti direttamente nei moduli sicuri di Stripe, fornitore di servizi di pagamento certificato PCI DSS di livello 1, e non transitano né vengono conservati sui nostri server.</p>`,
      `<h2>Minori</h2>`,
      `<p>Il sito non è rivolto ai minori di 18 anni e non raccogliamo consapevolmente i loro dati.</p>`,
      `<h2>Modifiche</h2>`,
      `<p>Possiamo aggiornare la presente informativa; la versione in vigore è sempre pubblicata in questa pagina.</p>`,
      `<p>Ultimo aggiornamento: ${OWNER.updatedAt}</p>`,
    ].join('\n'),
    'terms-of-service': [
      `<p>I presenti termini e condizioni generali di vendita ("Condizioni") regolano gli acquisti di prodotti effettuati da consumatori sul sito {{brand}}. Ti invitiamo a leggerli e a salvarli o stamparli prima di effettuare un ordine.</p>`,
      `<h2>1. Venditore</h2>`,
      sellerBlockIt,
      `<h2>2. Chi può acquistare</h2>`,
      `<p>Gli acquisti sono riservati a consumatori maggiorenni con indirizzo di consegna in uno dei paesi indicati nella politica di spedizione. I prodotti sono venduti per uso personale e non per la rivendita.</p>`,
      `<h2>3. Prodotti</h2>`,
      `<p>Le caratteristiche essenziali dei prodotti sono descritte nelle rispettive pagine. Le immagini hanno valore illustrativo e possono differire leggermente dal prodotto, ad esempio per colori o confezione, senza alterarne le caratteristiche essenziali.</p>`,
      `<h2>4. Prezzi e IVA</h2>`,
      `<p>I prezzi sono indicati nella valuta mostrata sul sito e sono prezzi finali per il consumatore, comprensivi dell'IVA e delle altre imposte applicabili. Le spese di spedizione e il totale da pagare sono indicati al checkout prima della conferma del pagamento.</p>`,
      `<h2>5. Conclusione del contratto</h2>`,
      `<p>Per acquistare scegli il prodotto e l'offerta, inserisci i dati richiesti, scegli il metodo di spedizione e conferma il pagamento con il pulsante del checkout, che comporta l'obbligo di pagare. Prima della conferma puoi verificare e correggere i dati inseriti. Il contratto si conclude quando il pagamento è autorizzato; subito dopo ricevi un'email di conferma con il riepilogo dell'ordine. Il contratto è concluso in lingua italiana. Se dopo il pagamento un prodotto risulta non disponibile, ti informiamo via email e ti rimborsiamo integralmente senza indebito ritardo.</p>`,
      `<h2>6. Pagamento</h2>`,
      `<p>Il pagamento avviene al momento dell'ordine tramite Stripe, con carta di credito o di debito e, se disponibili sul tuo dispositivo, Apple Pay, Google Pay o gli altri metodi mostrati al checkout. I dati della carta sono gestiti esclusivamente da Stripe, fornitore certificato PCI DSS, tramite connessione cifrata, e non vengono conservati sui nostri server. Il nome che compare sull'estratto conto per l'addebito può essere diverso da {{brand}}: in caso di dubbi su un addebito scrivi a {{support_email}}.</p>`,
      `<h2>7. Spedizione e consegna</h2>`,
      `<p>Paesi, metodi, costi e tempi stimati di consegna sono indicati nella politica di spedizione e al checkout. I tempi sono stime e non costituiscono una data di consegna garantita. Il rischio di perdita o danneggiamento dei beni passa a te quando entri materialmente in possesso dei beni.</p>`,
      `<h2>8. Abbonamenti</h2>`,
      `<p>Alcune offerte possono essere acquistate in abbonamento, scegliendo l'apposita opzione nella pagina del prodotto. Prima del pagamento ti mostriamo il prezzo ricorrente, la frequenza dei rinnovi (ad esempio ogni mese) e lo sconto dell'abbonamento.</p>`,
      `<ul>`,
      `<li><strong>Rinnovo automatico</strong>: l'abbonamento si rinnova automaticamente alla frequenza indicata e a ogni rinnovo addebitiamo il prezzo ricorrente sullo stesso metodo di pagamento tramite Stripe, fino alla cancellazione. Ogni rinnovo pagato genera un nuovo ordine, che ti confermiamo via email e spediamo come descritto nella politica di spedizione.</li>`,
      `<li><strong>Prezzo, sconto e spedizione</strong>: il prezzo ricorrente è quello indicato al momento della sottoscrizione e comprende lo sconto dell'abbonamento, che si applica a ogni pagamento. Le spese di spedizione sono addebitate solo con il primo pagamento; gli ordini dei rinnovi sono spediti senza ulteriori spese di spedizione.</li>`,
      `<li><strong>Cancellazione dell'abbonamento</strong>: puoi annullare l'abbonamento in qualsiasi momento, senza penali e senza indicarne il motivo, ${MANAGE_SUBSCRIPTION_IT}. Dallo stesso portale puoi aggiornare il metodo di pagamento e consultare le fatture. La cancellazione ha effetto alla fine del periodo già pagato: da quel momento non verranno addebitati ulteriori rinnovi, mentre gli ordini già pagati saranno comunque spediti. Se hai bisogno di aiuto, scrivi a {{support_email}}.</li>`,
      `<li><strong>Pagamenti non riusciti</strong>: se l'addebito di un rinnovo non va a buon fine ti avvisiamo via email; Stripe può ritentare automaticamente il pagamento e, se i tentativi non vanno a buon fine, l'abbonamento può essere annullato.</li>`,
      `<li><strong>Recesso</strong>: per gli abbonamenti con consegna periodica di beni il termine di 14 giorni per il recesso decorre dalla ricezione della prima consegna (vedi la politica di rimborso).</li>`,
      `</ul>`,
      `<h2>9. Promozioni e sconti</h2>`,
      `<p>Le condizioni di ogni promozione (ad esempio sconti su confezioni multiple o lo sconto dell'abbonamento) sono indicate nella pagina del prodotto e riepilogate al checkout prima del pagamento. Salvo diversa indicazione, le promozioni non sono cumulabili, valgono fino a esaurimento scorte o fino al termine indicato e non sono convertibili in denaro. Si applica lo sconto mostrato al checkout al momento dell'ordine.</p>`,
      `<h2>10. Diritto di recesso</h2>`,
      `<p>Hai il diritto di recedere dal contratto entro 14 giorni dalla ricezione dei prodotti, senza indicarne le ragioni, come previsto dagli artt. 52 e ss. del Codice del Consumo. Modalità, costi di restituzione, rimborso (entro 14 giorni, con lo stesso mezzo di pagamento), esclusioni e modulo di recesso tipo sono descritti nella politica di rimborso, che fa parte integrante delle presenti Condizioni.</p>`,
      `<h2>11. Garanzia legale di conformità</h2>`,
      `<p>Tutti i prodotti sono coperti dalla garanzia legale di conformità prevista dagli artt. 128 e ss. del Codice del Consumo: rispondiamo di qualsiasi difetto di conformità che si manifesti entro 24 mesi dalla consegna. Per far valere la garanzia scrivi a {{support_email}} indicando il numero dell'ordine e descrivendo il difetto, possibilmente con alcune foto; per non perdere i tuoi diritti, il difetto va denunciato entro due mesi dalla scoperta. Hai diritto, senza spese, al ripristino della conformità mediante riparazione o sostituzione oppure, nei casi previsti dalla legge, a una riduzione proporzionale del prezzo o alla risoluzione del contratto con rimborso. La garanzia legale non copre i danni causati da uso improprio, incidenti o normale usura.</p>`,
      `<h2>12. Responsabilità</h2>`,
      `<p>Non siamo responsabili per ritardi o mancate esecuzioni dovuti a cause di forza maggiore o a eventi al di fuori del nostro ragionevole controllo. Nessuna disposizione delle presenti Condizioni limita o esclude i diritti che ti spettano come consumatore in base alle norme inderogabili applicabili, né la nostra responsabilità nei casi in cui la legge non consente di limitarla (ad esempio per dolo o colpa grave).</p>`,
      `<h2>13. Restrizioni legali e di esportazione</h2>`,
      `<p>Vendiamo e spediamo solo nei paesi indicati nella politica di spedizione. Non vendiamo a paesi, territori o persone soggetti a sanzioni o restrizioni commerciali dell'Unione europea o internazionali. È tua responsabilità verificare che l'acquisto e l'importazione dei prodotti siano consentiti nel paese di consegna; possiamo annullare e rimborsare integralmente gli ordini che violano queste restrizioni.</p>`,
      `<h2>14. Dati personali</h2>`,
      `<p>Trattiamo i tuoi dati personali come descritto nell'informativa sulla privacy.</p>`,
      `<h2>15. Assistenza e reclami</h2>`,
      `<p>Per assistenza o reclami scrivi a {{support_email}} indicando il numero dell'ordine. In caso di dubbi su un addebito, contattaci prima di aprire una contestazione con la tua banca: risolviamo la maggior parte dei problemi direttamente. Puoi inoltre ricorrere alle procedure di risoluzione alternativa delle controversie previste dagli artt. 141 e ss. del Codice del Consumo.</p>`,
      `<h2>16. Legge applicabile e foro competente</h2>`,
      `<p>Le presenti Condizioni sono regolate dalla legge italiana. Restano salve le norme imperative più favorevoli a tutela dei consumatori del paese in cui hai la residenza abituale. Per le controversie con consumatori residenti in Italia è competente in via inderogabile il giudice del luogo di residenza o di domicilio del consumatore (art. 66-bis del Codice del Consumo); i consumatori residenti in un altro paese dell'Unione europea possono agire anche davanti ai giudici del proprio paese di residenza.</p>`,
      `<h2>17. Modifiche</h2>`,
      `<p>Possiamo modificare le presenti Condizioni in qualsiasi momento; a ciascun ordine si applica la versione in vigore al momento dell'ordine.</p>`,
      `<p>Ultimo aggiornamento: ${OWNER.updatedAt}</p>`,
    ].join('\n'),
    'contact-information': [
      `<p>{{brand}} è un marchio gestito da:</p>`,
      sellerBlockIt,
      `<h2>Assistenza clienti</h2>`,
      `<p>Scrivici a <a href="mailto:{{support_email}}">{{support_email}}</a>: rispondiamo ${OWNER.responseTime}. Per ricevere aiuto più velocemente indica sempre il numero dell'ordine.</p>`,
      `<h2>Come possiamo aiutarti</h2>`,
      `<ul>`,
      `<li><strong>Stato dell'ordine e tracciamento</strong>: consulta la pagina «Traccia il tuo ordine» del sito con il numero dell'ordine e la tua email.</li>`,
      `<li><strong>Resi, recesso e rimborsi</strong>: scrivi a {{support_email}}; trovi tutte le informazioni e il modulo di recesso tipo nella politica di rimborso.</li>`,
      `<li><strong>Prodotti danneggiati o non conformi</strong>: scrivi a {{support_email}} con il numero dell'ordine e alcune foto.</li>`,
      `<li><strong>Abbonamenti</strong>: puoi annullare l'abbonamento, aggiornare il metodo di pagamento o consultare le fatture in qualsiasi momento ${MANAGE_SUBSCRIPTION_IT}.</li>`,
      `<li><strong>Privacy</strong>: per esercitare i tuoi diritti sui dati personali scrivi a {{support_email}}.</li>`,
      `</ul>`,
      `<p>Prima di aprire una contestazione con la tua banca per un addebito, contattaci: risolviamo la maggior parte dei problemi direttamente.</p>`,
    ].join('\n'),
  },
};

const en: PolicyStrings = {
  titles: {
    'refund-policy': 'Refund policy',
    'shipping-policy': 'Shipping policy',
    'privacy-policy': 'Privacy policy',
    'terms-of-service': 'Terms of service',
    'contact-information': 'Contact information',
  },
  businessDays: 'business days',
  free: 'Free',
  vat: 'VAT',
  returnPayer: { customer: 'paid by the customer', seller: 'paid by the seller' },
  defaults: {
    'refund-policy': [
      `<p>This policy applies to purchases made on the {{brand}} website, sold by {{legal_name}}.</p>`,
      `<h2>Right of withdrawal</h2>`,
      `<p>You may withdraw from your purchase within {{refund_window_days}} days of receiving the product, without giving a reason. To do so, email {{support_email}} with your order number.</p>`,
      `<h2>Return conditions</h2>`,
      `<p>The product must be returned undamaged, in its original packaging and with all accessories. We will send you the return address after your request. Return shipping costs are {{return_shipping_payer}}.</p>`,
      `<h2>Refund</h2>`,
      `<p>Once we receive and check the return, we refund the same payment method used for the purchase, within the terms required by applicable law. How long it takes to appear depends on your bank or card issuer.</p>`,
      `<h2>Damaged or wrong items</h2>`,
      `<p>If you receive a damaged item or a different one from what you ordered, email {{support_email}} with your order number and photos of the item. Your statutory rights remain unaffected.</p>`,
      `<h2>Contact</h2>`,
      contactBlockEn,
    ].join('\n'),
    'shipping-policy': [
      `<p>We ship to the following countries: {{countries}}.</p>`,
      `<h2>Shipping methods and times</h2>`,
      `{{shipping_methods}}`,
      `<p>The times shown are estimates in business days and are not a guaranteed delivery date.</p>`,
      `<h2>Order processing</h2>`,
      `<p>After payment you receive an order confirmation email. When the order ships we email you the carrier and the tracking code. You can check your order status at any time on the "Order status" page of the website with your order number and email.</p>`,
      `<h2>Delivery problems</h2>`,
      `<p>If your parcel is lost, damaged or not delivered, email {{support_email}} with your order number.</p>`,
      `<h2>Contact</h2>`,
      contactBlockEn,
    ].join('\n'),
    'privacy-policy': [
      `<p>This notice explains how {{legal_name}} ("we"), the data controller, processes personal data collected through the {{brand}} website.</p>`,
      `<h2>Data controller</h2>`,
      contactBlockEn,
      `<h2>Data we collect</h2>`,
      `<p>Name, email address, phone number (if provided), shipping address and order details. Payments are processed by Stripe: we do not store your full card details.</p>`,
      `<h2>Purposes and legal basis</h2>`,
      `<p>We use your data to fulfil and deliver your order (performance of a contract), send you order updates, provide support and meet legal obligations. We only send marketing emails if you have consented, and you can withdraw consent at any time.</p>`,
      `<h2>Cookies and measurement tools</h2>`,
      `<p>The website may use cookies and third-party measurement tools (for example the Meta pixel) to measure visits and advertising performance.</p>`,
      `<h2>Recipients</h2>`,
      `<p>Data may be shared with the providers needed to fulfil your order (payment, shipping, email delivery), who process it on our behalf.</p>`,
      `<h2>Retention</h2>`,
      `<p>We keep data for as long as needed for these purposes and as required by law.</p>`,
      `<h2>Your rights</h2>`,
      `<p>You can request access, rectification, erasure, restriction, portability of your data and object to processing by emailing {{support_email}}. You also have the right to lodge a complaint with the competent supervisory authority.</p>`,
    ].join('\n'),
    'terms-of-service': [
      `<p>These terms govern purchases made on the {{brand}} website.</p>`,
      `<h2>Seller</h2>`,
      contactBlockEn,
      `<h2>Products and prices</h2>`,
      `<p>The total order price, including any shipping costs, is shown before payment.</p>`,
      `<h2>Order and payment</h2>`,
      `<p>The contract is concluded when the payment is confirmed. Payments are processed securely by Stripe. After payment you receive a confirmation email with your order number.</p>`,
      `<h2>Shipping</h2>`,
      `<p>Methods and estimated times are described in the shipping policy.</p>`,
      `<h2>Withdrawal and refunds</h2>`,
      `<p>Withdrawal and refund conditions are described in the refund policy.</p>`,
      `<h2>Warranty</h2>`,
      `<p>The statutory warranty of conformity under applicable law applies.</p>`,
      `<h2>Applicable law</h2>`,
      `<p>Mandatory consumer protection rules of your country of residence remain unaffected.</p>`,
    ].join('\n'),
    'contact-information': [
      `<p>{{brand}} is operated by:</p>`,
      contactBlockEn,
      `<p>For questions about your order, email {{support_email}} with your order number.</p>`,
    ].join('\n'),
  },
};

const STRINGS: Record<string, PolicyStrings> = { it, en };

export function policyLocale(locale: string | null | undefined): string {
  const key = (locale ?? '').slice(0, 2).toLowerCase();
  return STRINGS[key] ? key : 'en';
}

export function policyTitle(slug: PolicySlug, locale: string | null | undefined): string {
  return STRINGS[policyLocale(locale)]!.titles[slug];
}

export function defaultPolicyHtml(slug: PolicySlug, locale: string | null | undefined): string {
  return STRINGS[policyLocale(locale)]!.defaults[slug];
}

/** Texto-fonte atual (editado pelo owner ou padrão do idioma). */
export function policySource(slug: PolicySlug, stored: StoredPolicy | undefined, locale: string): string {
  return stored?.html?.trim() ? stored.html : defaultPolicyHtml(slug, locale);
}

// ─── renderização ────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

function formatMinor(minor: number, currency: string, locale: string): string {
  const code = currency.toUpperCase();
  try {
    const digits =
      new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(minor / Math.pow(10, digits));
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}

function range(min: number, max: number): string {
  return min === max ? `${min}` : `${min}–${max}`;
}

/** Lista HTML dos métodos de frete do mercado com a faixa de prazo (D12). */
export function shippingMethodsHtml(market: PolicyMarket): string {
  const t = STRINGS[policyLocale(market.locale)]!;
  const items: string[] = [];
  if (market.shippingFreeEnabled) {
    items.push(
      `<li><strong>${escapeHtml(market.shippingFreeLabel)}</strong>: ${escapeHtml(t.free)} — ${range(market.shippingFreeMinDays, market.shippingFreeMaxDays)} ${escapeHtml(t.businessDays)}</li>`,
    );
  }
  if (market.shippingExpressEnabled) {
    const price =
      market.shippingExpressMinor > 0 ? formatMinor(market.shippingExpressMinor, market.currency, market.locale) : t.free;
    items.push(
      `<li><strong>${escapeHtml(market.shippingExpressLabel)}</strong>: ${escapeHtml(price)} — ${range(market.shippingExpressMinDays, market.shippingExpressMaxDays)} ${escapeHtml(t.businessDays)}</li>`,
    );
  }
  return `<ul>${items.join('')}</ul>`;
}

function countryNames(codes: string[], locale: string): string {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    names = null;
  }
  return codes.map((c) => names?.of(c) ?? c).join(', ');
}

/** Valores já prontos para o HTML (escapados) — '' quando ausente. */
function placeholderValues(ctx: PolicyContext): Record<Placeholder, string> {
  const t = STRINGS[policyLocale(ctx.market.locale)]!;
  const s = ctx.seller;
  return {
    brand: escapeHtml(ctx.brand.trim()),
    legal_name: s.legalName ? escapeHtml(s.legalName) : '',
    legal_address: s.legalAddress ? escapeHtml(s.legalAddress).replace(/\r?\n/g, '<br>') : '',
    vat_line: s.vatId ? `${escapeHtml(t.vat)}: ${escapeHtml(s.vatId)}<br>` : '',
    support_email: escapeHtml(ctx.supportEmail),
    refund_window_days: s.refundWindowDays ? String(s.refundWindowDays) : '',
    return_shipping_payer: s.returnShippingPayer ? escapeHtml(t.returnPayer[s.returnShippingPayer]) : '',
    shipping_methods: shippingMethodsHtml(ctx.market),
    countries: escapeHtml(countryNames(ctx.market.countryCodes, ctx.market.locale)),
  };
}

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

function isPlaceholder(name: string): name is Placeholder {
  return (POLICY_PLACEHOLDERS as readonly string[]).includes(name);
}

/** Remove scripts/handlers/iframes do HTML editado pelo owner (defesa em profundidade). */
export function sanitizePolicyHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

export interface RenderedPolicy {
  html: string;
  /** Placeholders obrigatórios sem valor (aparecem como [[nome]] no preview). */
  missing: string[];
}

export function renderPolicy(source: string, ctx: PolicyContext): RenderedPolicy {
  const values = placeholderValues(ctx);
  const missing = new Set<string>();
  const html = sanitizePolicyHtml(source).replace(PLACEHOLDER_RE, (_m, name: string) => {
    if (!isPlaceholder(name)) {
      missing.add(name);
      return `[[${escapeHtml(name)}]]`;
    }
    const value = values[name];
    if (!value && !OPTIONAL_PLACEHOLDERS.has(name)) {
      missing.add(name);
      return `[[${name}]]`;
    }
    return value;
  });
  return { html, missing: [...missing] };
}

const PLACEHOLDER_BY_FIELD: Record<keyof SellerInfo, string> = {
  legalName: 'legal_name',
  legalAddress: 'legal_address',
  vatId: 'vat_line',
  refundWindowDays: 'refund_window_days',
  returnShippingPayer: 'return_shipping_payer',
};

const FIELD_LABEL: Record<keyof SellerInfo, string> = {
  legalName: 'razão social',
  legalAddress: 'endereço jurídico',
  vatId: 'VAT / CNPJ',
  refundWindowDays: 'prazo de devolução (dias)',
  returnShippingPayer: 'quem paga a devolução',
};

/** Marcador de trecho que só o owner sabe preencher (Story 15.7). */
const OWNER_MARKER_RE = /\[PREENCHER\b[^\]]*\]?/gi;

/** Marcadores `[PREENCHER: ...]` ainda presentes no texto, na ordem em que aparecem. */
export function ownerMarkers(source: string): string[] {
  return source.match(OWNER_MARKER_RE) ?? [];
}

function markerHint(marker: string): string {
  const hint = marker.replace(/^\[PREENCHER\s*:?\s*/i, '').replace(/\]$/, '').trim();
  return hint.length > 160 ? `${hint.slice(0, 157)}...` : hint;
}

/**
 * Motivos que impedem publicar/servir a política. Vazio = publicável.
 * Identidade jurídica (seller_info) só é exigida quando o texto usa os
 * placeholders correspondentes.
 */
export function policyPublishIssues(source: string, ctx: PolicyContext): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const markers = ownerMarkers(source);
  if (markers.length > 0) {
    const n = markers.length;
    issues.push({
      code: 'pending_owner_text',
      message: `${n === 1 ? 'Falta 1 trecho' : `Faltam ${n} trechos`} [PREENCHER] no texto — clique em Editar e substitua cada marcador inteiro pela informação pedida. Primeiro: ${markerHint(markers[0]!)}`,
    });
  }
  const fields = new Set<keyof SellerInfo>();
  const { missing, html } = renderPolicy(source, ctx);
  for (const name of missing) {
    const field = isPlaceholder(name) ? PLACEHOLDER_FIELD[name] : undefined;
    if (field) {
      fields.add(field);
    } else {
      issues.push({ code: 'unknown_placeholder', field: name, message: `Placeholder desconhecido ou vazio: {{${name}}}.` });
    }
  }
  issues.push(
    ...[...fields].map((field) => ({
      code: 'missing_seller_field' as const,
      field,
      message: `O texto usa {{${PLACEHOLDER_BY_FIELD[field]}}}: preencha ${FIELD_LABEL[field]} na identidade jurídica do mercado ou troque o placeholder pelo texto.`,
    })),
  );
  if (!html.replace(/<[^>]*>/g, '').trim()) {
    issues.push({ code: 'empty_text', message: 'O texto da política está vazio.' });
  }
  return issues;
}
