// Story 20.1 — design system do painel novo (Polaris Web Components 2.x).
// Guia: docs/ux/guia-padroes-de-tela.md · Decisão: docs/architecture/adr-003-polaris-web-components-backoffice.md

export { PolarisGate, GateSkeleton, POLARIS_LOAD_ERROR_MESSAGE } from './PolarisGate';
export type { PolarisGateProps, PolarisGateStatus } from './PolarisGate';
export { DsButton } from './DsButton';
export type { DsButtonProps } from './DsButton';
export { DsTextField } from './DsTextField';
export type { DsTextFieldProps } from './DsTextField';
export { DsPasswordField } from './DsPasswordField';
export type { DsPasswordFieldProps } from './DsPasswordField';
export { DsNumberField } from './DsNumberField';
export type { DsNumberFieldProps } from './DsNumberField';
// Story 20.11c — campo de data controlado (s-date-field, AAAA-MM-DD).
export { DsDateField } from './DsDateField';
export type { DsDateFieldProps } from './DsDateField';
export { DsSelect } from './DsSelect';
export type { DsSelectOption, DsSelectProps } from './DsSelect';
export { DsModal } from './DsModal';
export type { DsModalAction, DsModalProps } from './DsModal';
export { DsSalesChart } from './DsSalesChart';
export type { DsSalesChartPoint, DsSalesChartProps } from './DsSalesChart';
export {
  ErrorBanner,
  EmptyBlock,
  LoadingCard,
  ConfirmModal,
  StateBoundary,
  DEFAULT_ERROR_MESSAGE,
  SLOW_LOADING_MESSAGE,
} from './states';
export type { ErrorBannerProps, ConfirmModalProps, StateBoundaryProps, StateBoundaryStatus, StateBoundaryEmpty } from './states';
export { useElementEvent, useElementProperties } from './use-custom-element';
// Story 20.5e — linha clicável do s-table-row (clickDelegate → s-link, navegação SPA).
export { isModifiedClick, isNewTabClick, ROW_CONTROL_SELECTOR, useRowLink } from './use-row-link';
// Story 20.5a — checkbox controlado e feedback de ações (substitui o Toast).
export { DsCheckbox } from './DsCheckbox';
export type { DsCheckboxProps } from './DsCheckbox';
export { ActionFeedback, useActionFeedback, ACTION_FEEDBACK_SUCCESS_MS } from './ActionFeedback';
export type { ActionFeedbackProps, ActionFeedbackValue, ActionFeedbackState } from './ActionFeedback';
// Stories 20.11c/d — indicador de salvamento automático (SaveIndicator) no visual novo.
export { DsSaveIndicator } from './DsSaveIndicator';
export type { DsSaveIndicatorProps } from './DsSaveIndicator';
export { DsSearchField } from './DsSearchField';
export type { DsSearchFieldProps } from './DsSearchField';
export { DsPagination, paginationSummary } from './DsPagination';
export type { DsPaginationProps } from './DsPagination';
// Story 20.11d — área de arrastar/escolher arquivo (no lugar do DropZone do Polaris React).
export { DsFileDrop } from './DsFileDrop';
export type { DsFileDropProps } from './DsFileDrop';
// Story 20.5b — área de texto controlada (descrição e ficha técnica do produto; também usada
// na assinatura/política do Atendimento da loja, Story 17.6c).
export { DsTextArea } from './DsTextArea';
export type { DsTextAreaProps } from './DsTextArea';
// Story 20.5f — aviso de "Ver na loja" desabilitado (endereço da vitrine ausente/local em produção).
export { StorefrontUrlWarning } from './StorefrontUrlWarning';
// Story 20.5f — cabeçalho de página com ações na linha do título (substitui os slots de ação do s-page).
export { DsPageHeader, MAX_INLINE_SECONDARY, MORE_ACTIONS_LABEL } from './DsPageHeader';
export type { DsPageHeaderProps } from './DsPageHeader';
// Story 20.5g — página larga (s-page inlineSize="large" com o respiro lateral da largura padrão).
export { DsWidePage } from './DsWidePage';
export type { DsWidePageProps } from './DsWidePage';
// Story 20.10c — escolha única com texto de apoio (s-choice-list) e cartão-botão de alternância.
export { DsChoiceList } from './DsChoiceList';
export type { DsChoiceListProps, DsChoiceOption } from './DsChoiceList';
export { DsToggleCard } from './DsToggleCard';
export type { DsToggleCardProps } from './DsToggleCard';
// Story 20.10d (PR B) — link de linha clicável (useRowLink embutido) e abas de fila com contador.
export { DsRowLink } from './DsRowLink';
export type { DsRowLinkProps } from './DsRowLink';
export { DsQueueTabs } from './DsQueueTabs';
export type { DsQueueTab, DsQueueTabsProps } from './DsQueueTabs';
// Story 20.16a — botão de alternância controlado (s-press-button): AND/OR e presets de países do Tracker.
export { DsPressButton } from './DsPressButton';
export type { DsPressButtonProps } from './DsPressButton';
// Stories 20.11b/c/d — estado de toast ({ content, error? }) como aviso do DS (ActionFeedback).
export { DsToast } from './DsToast';
export type { DsToastProps, DsToastState } from './DsToast';
// Story 20.7d-2 — editor de tema: controle deslizante, campo de cor (amostra + código) e grupo recolhível.
export { DsRangeSlider } from './DsRangeSlider';
export type { DsRangeSliderProps } from './DsRangeSlider';
export { DsColorField } from './DsColorField';
export type { DsColorFieldProps } from './DsColorField';
export { DsDisclosure } from './DsDisclosure';
export type { DsDisclosureProps } from './DsDisclosure';
// Story 20.15a — barra do menu interno de uma área (abas-link) e painel ancorado (lista do sino).
export { DsNavTabs } from './DsNavTabs';
export type { DsNavTabsProps } from './DsNavTabs';
export { DsAnchoredPanel } from './DsAnchoredPanel';
export type { DsAnchoredPanelProps } from './DsAnchoredPanel';
// Story 20.15a — selo a partir dos tons do Polaris React dos dicionários (attention → caution).
export { DsToneBadge } from './DsToneBadge';
export type { DsToneBadgeProps, DsToneBadgeTone } from './DsToneBadge';
// Story 20.15a — aviso com título no conteúdo e ação (substitui o AlertBanner do TrustShield).
export { DsAlertBanner } from './DsAlertBanner';
export type { DsAlertBannerProps } from './DsAlertBanner';
// Story 20.15b — aviso simples com fechar (Banner do Polaris React) e botão só-ícone.
export { DsNoticeBanner } from './DsNoticeBanner';
export type { DsNoticeBannerProps } from './DsNoticeBanner';
export { DsIconButton } from './DsIconButton';
export type { DsIconButtonProps } from './DsIconButton';
// Story 20.15b (PR C) — selos do Atendimento pelo dicionário PT-BR (substituem design/StatusBadge).
export { DsCategoryBadge, DsRefundStatusBadge, DsStatusBadge, DsVerificationBadge } from './DsEnumBadges';
// Story 20.15c — tabela por colunas (s-table; substitui o DataTable do TrustShield).
export { DsDataTable } from './DsDataTable';
export type { DsDataTableColumn, DsDataTableProps } from './DsDataTable';
