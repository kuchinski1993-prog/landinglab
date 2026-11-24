// Textos do checkout e da página de obrigado por idioma do mercado (Story 15.3).
// Fallback: inglês. Sem dependências — importável pelo storefront.

export interface CheckoutStrings {
  expressCheckout: string;
  or: string;
  contact: string;
  email: string;
  newsletter: string;
  delivery: string;
  shippingMethod: string;
  shippingMethodHint: string;
  businessDays: string;
  free: string;
  payment: string;
  paymentSecure: string;
  payNow: string;
  processing: string;
  orderSummary: string;
  subtotal: string;
  shipping: string;
  total: string;
  quantity: string;
  refundPolicy: string;
  privacyPolicy: string;
  termsOfService: string;
  errorGeneric: string;
  errorExpired: string;
  thankYouTitle: string;
  thankYouOrder: string;
  thankYouBody: string;
  thankYouTracking: string;
  thankYouPending: string;
  /** Story 15.7: resumo sem endereço ainda (estilo Shopify). */
  shippingEnterAddress: string;
  /** Story 15.7: contagem de itens no bloco "Total" do mobile ({count} = quantidade). */
  itemOne: string;
  itemMany: string;
}

const en: CheckoutStrings = {
  expressCheckout: 'Express checkout',
  or: 'OR',
  contact: 'Contact',
  email: 'Email',
  newsletter: 'Email me with news and offers',
  delivery: 'Delivery',
  shippingMethod: 'Shipping method',
  shippingMethodHint: 'Enter your shipping address to view available shipping methods.',
  businessDays: 'business days',
  free: 'Free',
  payment: 'Payment',
  paymentSecure: 'All transactions are secure and encrypted.',
  payNow: 'Pay now',
  processing: 'Processing…',
  orderSummary: 'Order summary',
  subtotal: 'Subtotal',
  shipping: 'Shipping',
  total: 'Total',
  quantity: 'Quantity',
  refundPolicy: 'Refund policy',
  privacyPolicy: 'Privacy policy',
  termsOfService: 'Terms of service',
  errorGeneric: 'Something went wrong. Please check your details and try again.',
  errorExpired: 'This checkout has expired. Please go back to the product page.',
  thankYouTitle: 'Thank you for your order!',
  thankYouOrder: 'Order',
  thankYouBody: 'Your payment was received. We will email you a confirmation and keep you updated on your order.',
  thankYouTracking: 'Estimated delivery',
  thankYouPending: 'We are confirming your payment. This page will update in a few seconds.',
  shippingEnterAddress: 'Enter shipping address',
  itemOne: '1 item',
  itemMany: '{count} items',
};

const it: CheckoutStrings = {
  expressCheckout: 'Pagamento rapido',
  or: 'OPPURE',
  contact: 'Contatti',
  email: 'Email',
  newsletter: 'Inviami email con notizie e offerte',
  delivery: 'Consegna',
  shippingMethod: 'Metodo di spedizione',
  shippingMethodHint: 'Inserisci il tuo indirizzo di spedizione per visualizzare i metodi di spedizione disponibili.',
  businessDays: 'giorni lavorativi',
  free: 'Gratis',
  payment: 'Pagamento',
  paymentSecure: 'Tutte le transazioni sono sicure e crittografate.',
  payNow: 'Paga ora',
  processing: 'Elaborazione…',
  orderSummary: 'Riepilogo ordine',
  subtotal: 'Subtotale',
  shipping: 'Spedizione',
  total: 'Totale',
  quantity: 'Quantità',
  refundPolicy: 'Politica di rimborso',
  privacyPolicy: 'Informativa sulla privacy',
  termsOfService: 'Termini di servizio',
  errorGeneric: 'Si è verificato un errore. Controlla i dati e riprova.',
  errorExpired: 'Questo checkout è scaduto. Torna alla pagina del prodotto.',
  thankYouTitle: 'Grazie per il tuo ordine!',
  thankYouOrder: 'Ordine',
  thankYouBody: 'Abbiamo ricevuto il pagamento. Ti invieremo una conferma via email e ti terremo aggiornato sul tuo ordine.',
  thankYouTracking: 'Consegna stimata',
  thankYouPending: 'Stiamo confermando il pagamento. Questa pagina si aggiornerà tra pochi secondi.',
  shippingEnterAddress: "Inserisci l'indirizzo di spedizione",
  itemOne: '1 articolo',
  itemMany: '{count} articoli',
};

const es: CheckoutStrings = {
  ...en,
  expressCheckout: 'Pago exprés',
  or: 'O',
  contact: 'Contacto',
  email: 'Correo electrónico',
  newsletter: 'Envíame novedades y ofertas por correo',
  delivery: 'Entrega',
  shippingMethod: 'Método de envío',
  shippingMethodHint: 'Introduce tu dirección de envío para ver los métodos de envío disponibles.',
  businessDays: 'días hábiles',
  free: 'Gratis',
  payment: 'Pago',
  paymentSecure: 'Todas las transacciones son seguras y están encriptadas.',
  payNow: 'Pagar ahora',
  processing: 'Procesando…',
  orderSummary: 'Resumen del pedido',
  shipping: 'Envío',
  quantity: 'Cantidad',
  refundPolicy: 'Política de reembolso',
  privacyPolicy: 'Política de privacidad',
  termsOfService: 'Términos del servicio',
  errorGeneric: 'Algo salió mal. Revisa tus datos e inténtalo de nuevo.',
  errorExpired: 'Este pago ha caducado. Vuelve a la página del producto.',
  thankYouTitle: '¡Gracias por tu pedido!',
  thankYouOrder: 'Pedido',
  thankYouBody: 'Hemos recibido tu pago. Te enviaremos una confirmación por correo y te mantendremos informado.',
  thankYouTracking: 'Entrega estimada',
  thankYouPending: 'Estamos confirmando tu pago. Esta página se actualizará en unos segundos.',
  shippingEnterAddress: 'Introduce la dirección de envío',
  itemOne: '1 artículo',
  itemMany: '{count} artículos',
};

const pt: CheckoutStrings = {
  ...en,
  expressCheckout: 'Pagamento rápido',
  or: 'OU',
  contact: 'Contato',
  email: 'E-mail',
  newsletter: 'Quero receber novidades e ofertas por e-mail',
  delivery: 'Entrega',
  shippingMethod: 'Método de envio',
  shippingMethodHint: 'Insira seu endereço de entrega para ver os métodos de envio disponíveis.',
  businessDays: 'dias úteis',
  free: 'Grátis',
  payment: 'Pagamento',
  paymentSecure: 'Todas as transações são seguras e criptografadas.',
  payNow: 'Pagar agora',
  processing: 'Processando…',
  orderSummary: 'Resumo do pedido',
  shipping: 'Envio',
  quantity: 'Quantidade',
  refundPolicy: 'Política de reembolso',
  privacyPolicy: 'Política de privacidade',
  termsOfService: 'Termos de serviço',
  errorGeneric: 'Algo deu errado. Confira seus dados e tente novamente.',
  errorExpired: 'Este checkout expirou. Volte à página do produto.',
  thankYouTitle: 'Obrigado pelo seu pedido!',
  thankYouOrder: 'Pedido',
  thankYouBody: 'Recebemos seu pagamento. Enviaremos uma confirmação por e-mail e manteremos você informado.',
  thankYouTracking: 'Entrega estimada',
  thankYouPending: 'Estamos confirmando seu pagamento. Esta página será atualizada em alguns segundos.',
  shippingEnterAddress: 'Insira o endereço de entrega',
  itemOne: '1 item',
  itemMany: '{count} itens',
};

const fr: CheckoutStrings = {
  ...en,
  expressCheckout: 'Paiement express',
  or: 'OU',
  contact: 'Contact',
  email: 'E-mail',
  newsletter: "M'envoyer les nouveautés et offres par e-mail",
  delivery: 'Livraison',
  shippingMethod: "Mode d'expédition",
  shippingMethodHint: "Saisissez votre adresse d'expédition pour voir les modes d'expédition disponibles.",
  businessDays: 'jours ouvrés',
  free: 'Gratuit',
  payment: 'Paiement',
  paymentSecure: 'Toutes les transactions sont sécurisées et cryptées.',
  payNow: 'Payer maintenant',
  processing: 'Traitement…',
  orderSummary: 'Récapitulatif de la commande',
  subtotal: 'Sous-total',
  shipping: 'Expédition',
  quantity: 'Quantité',
  refundPolicy: 'Politique de remboursement',
  privacyPolicy: 'Politique de confidentialité',
  termsOfService: "Conditions d'utilisation",
  errorGeneric: 'Une erreur est survenue. Vérifiez vos informations et réessayez.',
  errorExpired: 'Ce paiement a expiré. Revenez à la page du produit.',
  thankYouTitle: 'Merci pour votre commande !',
  thankYouOrder: 'Commande',
  thankYouBody: 'Nous avons reçu votre paiement. Vous recevrez une confirmation par e-mail.',
  thankYouTracking: 'Livraison estimée',
  thankYouPending: 'Nous confirmons votre paiement. Cette page se mettra à jour dans quelques secondes.',
  shippingEnterAddress: "Saisissez l'adresse d'expédition",
  itemOne: '1 article',
  itemMany: '{count} articles',
};

const de: CheckoutStrings = {
  ...en,
  expressCheckout: 'Express-Checkout',
  or: 'ODER',
  contact: 'Kontakt',
  email: 'E-Mail',
  newsletter: 'Neuigkeiten und Angebote per E-Mail erhalten',
  delivery: 'Lieferung',
  shippingMethod: 'Versandmethode',
  shippingMethodHint: 'Gib deine Lieferadresse ein, um die verfügbaren Versandmethoden anzuzeigen.',
  businessDays: 'Werktage',
  free: 'Kostenlos',
  payment: 'Zahlung',
  paymentSecure: 'Alle Transaktionen sind sicher und verschlüsselt.',
  payNow: 'Jetzt bezahlen',
  processing: 'Wird verarbeitet…',
  orderSummary: 'Bestellübersicht',
  subtotal: 'Zwischensumme',
  shipping: 'Versand',
  total: 'Gesamt',
  quantity: 'Menge',
  refundPolicy: 'Rückerstattungsrichtlinie',
  privacyPolicy: 'Datenschutzerklärung',
  termsOfService: 'Nutzungsbedingungen',
  errorGeneric: 'Etwas ist schiefgelaufen. Bitte prüfe deine Angaben und versuche es erneut.',
  errorExpired: 'Dieser Checkout ist abgelaufen. Bitte kehre zur Produktseite zurück.',
  thankYouTitle: 'Vielen Dank für deine Bestellung!',
  thankYouOrder: 'Bestellung',
  thankYouBody: 'Wir haben deine Zahlung erhalten und senden dir eine Bestätigung per E-Mail.',
  thankYouTracking: 'Voraussichtliche Lieferung',
  thankYouPending: 'Wir bestätigen deine Zahlung. Diese Seite aktualisiert sich in wenigen Sekunden.',
  shippingEnterAddress: 'Lieferadresse eingeben',
  itemOne: '1 Artikel',
  itemMany: '{count} Artikel',
};

const STRINGS: Record<string, CheckoutStrings> = { en, it, es, pt, fr, de };

export function checkoutStrings(locale: string): CheckoutStrings {
  return STRINGS[locale.slice(0, 2)] ?? en;
}
