'use client';

// @ds-migrated — Story 20.10c (PR A): Autopilot (`/landing-pages/new/autopilot`) no design system.
// /landing-pages/new/autopilot — Story 13.3 AC5.
// Form com 4 campos (source type radio + url/image + language + hint textarea 500 chars).
//
// Só visual: validação, corte da dica em 500, idiomas de copy (EN sempre) e
// `createAutopilotLandingPage` iguais a antes. Título e "Iniciar geração IA" na mesma linha
// (`DsPageHeader`), voltar para "Landing Pages" acima do título, campos `Ds*`, aviso persistente.

import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';

import {
  createAutopilotLandingPage,
  type AutopilotLanguage,
  type AutopilotSourceType,
} from './actions';

import {
  ActionFeedback,
  DsButton,
  DsCheckbox,
  DsChoiceList,
  DsPageHeader,
  DsSelect,
  DsTextArea,
  DsTextField,
  PolarisGate,
  isModifiedClick,
} from '@/components/ds';

const LANGUAGE_OPTIONS: Array<{ label: string; value: AutopilotLanguage }> = [
  { label: 'Alemão (DE)', value: 'de' },
  { label: 'Italiano (IT)', value: 'it' },
  { label: 'Inglês (EN)', value: 'en' },
  { label: 'Espanhol (ES)', value: 'es' },
  { label: 'Francês (FR)', value: 'fr' },
];

// Story 13.4 AC17: opções pro multi-select de idiomas de copy.
// EN é sempre gerado e não pode ser desmarcado (disabled + checked no UI).
const COPY_LANGUAGE_CHOICES: Array<{
  label: string;
  value: AutopilotLanguage;
  disabled?: boolean;
  helpText?: string;
}> = [
  {
    label: 'Inglês (EN) — sempre gerado',
    value: 'en',
    disabled: true,
    helpText: 'EN é obrigatório. Copy Squad sempre gera EN como idioma-base.',
  },
  { label: 'Alemão (DE)', value: 'de' },
  { label: 'Italiano (IT)', value: 'it' },
  { label: 'Francês (FR)', value: 'fr' },
  { label: 'Espanhol (ES)', value: 'es' },
];

const SOURCE_CHOICES = [
  {
    label: 'Link de produto AliExpress',
    value: 'aliexpress_link' as const,
    details: 'Cole a URL completa da página do produto no AliExpress.',
  },
  {
    label: 'Outro link de e-commerce',
    value: 'other_url' as const,
    details: 'URL de qualquer loja (Shopify, Amazon, DTC brand, etc).',
  },
  {
    label: 'Foto do produto (upload)',
    value: 'photo_upload' as const,
    details: 'Cole URL de uma imagem do produto. Google Lens identifica o item.',
  },
];

const HINT_MAX = 500;
const LIST_HREF = '/landing-pages';

function BackLink(): JSX.Element {
  const router = useRouter();
  return (
    <s-link
      href={LIST_HREF}
      onClick={(event) => {
        if (isModifiedClick(event as unknown as MouseEvent)) return;
        event.preventDefault();
        router.push(LIST_HREF);
      }}
    >
      Landing Pages
    </s-link>
  );
}

export default function AutopilotNewPage(): JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [sourceType, setSourceType] = useState<AutopilotSourceType>('aliexpress_link');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceImageUrl, setSourceImageUrl] = useState('');
  const [targetLanguage, setTargetLanguage] = useState<AutopilotLanguage>('en');
  // Story 13.4 AC17: EN sempre selecionado; adicionais opcionais.
  const [copyLanguages, setCopyLanguages] = useState<AutopilotLanguage[]>(['en']);
  const [hint, setHint] = useState('');
  const [banner, setBanner] = useState<{ tone: 'critical' | 'success'; message: string } | null>(
    null,
  );

  const handleSourceTypeChange = useCallback((selected: string[]) => {
    const value = selected[0];
    if (value === 'aliexpress_link' || value === 'other_url' || value === 'photo_upload') {
      setSourceType(value);
    }
  }, []);

  const handleHintChange = useCallback((value: string) => {
    // Truncate defensivamente pra evitar payload > 500 no server.
    setHint(value.slice(0, HINT_MAX));
  }, []);

  // Story 13.4 AC17: EN nunca é removido. Callback força EN sempre presente.
  const handleCopyLanguagesChange = useCallback((selected: string[]) => {
    const valid = selected.filter((v): v is AutopilotLanguage =>
      ['en', 'de', 'it', 'fr', 'es'].includes(v),
    );
    const withEn = valid.includes('en') ? valid : ['en', ...valid];
    setCopyLanguages(withEn as AutopilotLanguage[]);
  }, []);

  const submit = useCallback(() => {
    setBanner(null);
    const isPhoto = sourceType === 'photo_upload';

    // Validação client-side leve — server re-valida.
    if (isPhoto && !sourceImageUrl.trim()) {
      setBanner({ tone: 'critical', message: 'Informe a URL da foto do produto.' });
      return;
    }
    if (!isPhoto && !sourceUrl.trim()) {
      setBanner({ tone: 'critical', message: 'Informe a URL do produto.' });
      return;
    }

    startTransition(async () => {
      const result = await createAutopilotLandingPage({
        sourceType,
        sourceUrl: isPhoto ? null : sourceUrl.trim(),
        sourceImageUrl: isPhoto ? sourceImageUrl.trim() : null,
        targetLanguage,
        targetLanguages: copyLanguages,
        hint: hint.trim() || null,
      });
      if (!result.ok) {
        setBanner({ tone: 'critical', message: result.message });
        return;
      }
      // Redireciona pra tela de edição — GenerationProgress renderiza lá.
      router.push(`/landing-pages/${result.data.id}/editor`);
    });
  }, [sourceType, sourceUrl, sourceImageUrl, targetLanguage, copyLanguages, hint, router]);

  const isPhoto = sourceType === 'photo_upload';

  return (
    <PolarisGate>
      <s-page>
        <DsPageHeader
          title="Nova landing (Autopilot)"
          breadcrumb={<BackLink />}
          primaryAction={
            <DsButton variant="primary" onClick={submit} loading={isPending} disabled={isPending}>
              Iniciar geração IA
            </DsButton>
          }
        />
        <s-stack gap="base">
          <ActionFeedback
            feedback={banner ? { tone: 'critical', error: banner.message } : null}
            onDismiss={() => setBanner(null)}
          />

          <s-section>
            <s-stack gap="base">
              <s-heading>Fonte do produto</s-heading>
              <s-stack gap="base">
                <s-paragraph color="subdued">
                  A IA vai extrair identidade, especificações, VOC (voice-of-customer) e
                  inteligência de mercado. O tempo médio de execução é ~2-4 minutos.
                </s-paragraph>
                <DsChoiceList
                  label="Tipo de entrada"
                  value={sourceType}
                  options={SOURCE_CHOICES}
                  onChange={(v) => handleSourceTypeChange([v])}
                />
              </s-stack>
            </s-stack>
          </s-section>

          <s-section>
            <s-stack gap="base">
              <s-heading>{isPhoto ? 'URL da imagem' : 'URL do produto'}</s-heading>
              {isPhoto ? (
                <DsTextField
                  label="URL da foto"
                  labelHidden
                  value={sourceImageUrl}
                  onChange={setSourceImageUrl}
                  placeholder="https://.../produto.jpg"
                  details="Cole uma URL pública da imagem. Google Lens buscará matches visuais."
                  disabled={isPending}
                />
              ) : (
                <DsTextField
                  label="URL do produto"
                  labelHidden
                  value={sourceUrl}
                  onChange={setSourceUrl}
                  placeholder="https://aliexpress.com/item/..."
                  details="Cole a URL completa da página do produto."
                  disabled={isPending}
                />
              )}
            </s-stack>
          </s-section>

          <s-section>
            <s-stack gap="base">
              <s-heading>Idioma-alvo (pesquisa)</s-heading>
              <DsSelect
                label="Idioma da pesquisa Squad 1 (PIR)"
                options={LANGUAGE_OPTIONS}
                value={targetLanguage}
                onChange={(v) => setTargetLanguage(v as AutopilotLanguage)}
                details="Define o mercado principal (Voice-of-Customer + market intel). Copy multi-idioma no card abaixo."
                disabled={isPending}
              />
            </s-stack>
          </s-section>

          <s-section>
            <s-stack gap="base">
              <s-heading>Idiomas de copy</s-heading>
              <s-stack gap="base">
                <s-paragraph color="subdued">
                  EN é sempre gerado. Idiomas adicionais geram um Squad 2 completo por
                  idioma (~$0.60-0.90 cada).
                </s-paragraph>
                <div role="group" aria-label="Idiomas de copy">
                  <s-stack gap="small-200">
                    {COPY_LANGUAGE_CHOICES.map((choice) => (
                      <DsCheckbox
                        key={choice.value}
                        label={choice.label}
                        details={choice.helpText}
                        checked={copyLanguages.includes(choice.value)}
                        disabled={isPending || choice.disabled}
                        onChange={(checked) =>
                          handleCopyLanguagesChange(
                            checked ? [...copyLanguages, choice.value] : copyLanguages.filter((v) => v !== choice.value),
                          )
                        }
                      />
                    ))}
                  </s-stack>
                </div>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section>
            <s-stack gap="base">
              <s-heading>Hint pra IA (opcional)</s-heading>
              <DsTextArea
                label="Instruções livres"
                labelHidden
                value={hint}
                onChange={handleHintChange}
                rows={4}
                placeholder="Ex: focar em avatar 40+ anos, dor de sono, evitar comparações com marcas concorrentes."
                maxLength={HINT_MAX}
                disabled={isPending}
              />
            </s-stack>
          </s-section>

          <s-section>
            <s-stack gap="base">
              <s-heading>O que acontece quando você clicar &quot;Iniciar geração IA&quot;</s-heading>
              <s-ordered-list>
                <s-list-item>Uma landing draft é criada agora com placeholder.</s-list-item>
                <s-list-item>A fila do worker executa o Squad 1 (Product Research) em ~2-4 min.</s-list-item>
                <s-list-item>Você acompanha o progresso na tela de edição da landing.</s-list-item>
                <s-list-item>
                  Após o PIR pronto, as próximas ondas (Copy, Visual, Build) rodam
                  automaticamente (features futuras).
                </s-list-item>
              </s-ordered-list>
            </s-stack>
          </s-section>
        </s-stack>
      </s-page>
    </PolarisGate>
  );
}
