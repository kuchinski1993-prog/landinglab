// Modelos de funil do wizard (F1b): etapas em ordem, encadeadas por nextStepId, nomes/caminhos PT-BR.
import type { VslRenderMode, VslStepType } from './funnels.js';

export const VSL_FUNNEL_TEMPLATES = ['BLANK', 'VSL_CHECKOUT', 'ADVERTORIAL_VSL_CHECKOUT', 'QUIZ_VSL_CHECKOUT', 'PRESELL_QUIZ_VSL_CHECKOUT', 'LANDING_CHECKOUT'] as const;
export type VslFunnelTemplate = (typeof VSL_FUNNEL_TEMPLATES)[number];
export interface TemplateStep { name: string; pathname: string; type: VslStepType; renderMode: VslRenderMode }

const PRESELL: TemplateStep = { name: 'Pré-venda', pathname: '/pre-venda', type: 'PRESELL', renderMode: 'IMPORTED_PAGE' };
const ADVERTORIAL: TemplateStep = { name: 'Advertorial', pathname: '/artigo', type: 'PRESELL', renderMode: 'IMPORTED_PAGE' };
const QUIZ: TemplateStep = { name: 'Quiz', pathname: '/quiz', type: 'QUIZ', renderMode: 'IMPORTED_PAGE' };
const VSL: TemplateStep = { name: 'VSL', pathname: '/video', type: 'VSL', renderMode: 'IMPORTED_PAGE' };
const LANDING: TemplateStep = { name: 'Página de vendas', pathname: '/oferta', type: 'PAGE', renderMode: 'IMPORTED_PAGE' };
const CHECKOUT: TemplateStep = { name: 'Checkout', pathname: '/checkout', type: 'CHECKOUT', renderMode: 'REDIRECT' };

export const FUNNEL_TEMPLATE_STEPS: Record<VslFunnelTemplate, readonly TemplateStep[]> = {
  BLANK: [],
  VSL_CHECKOUT: [VSL, CHECKOUT],
  ADVERTORIAL_VSL_CHECKOUT: [ADVERTORIAL, VSL, CHECKOUT],
  QUIZ_VSL_CHECKOUT: [QUIZ, VSL, CHECKOUT],
  PRESELL_QUIZ_VSL_CHECKOUT: [PRESELL, QUIZ, VSL, CHECKOUT],
  LANDING_CHECKOUT: [LANDING, CHECKOUT],
};

export function isFunnelTemplate(value: unknown): value is VslFunnelTemplate {
  return typeof value === 'string' && (VSL_FUNNEL_TEMPLATES as readonly string[]).includes(value);
}
