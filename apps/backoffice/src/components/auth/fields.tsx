'use client';

// @ds-migrated — Story 22.1b: campos das telas de acesso (HTML nativo, sem Polaris).
// `<label>` visível ligado ao campo, erro por campo em `aria-describedby` + `aria-invalid`, aviso
// geral em `role="alert"` com foco, mostrar/ocultar senha com `aria-pressed`, colar liberado e sem
// `maxLength` cortando senha (T6).

import { forwardRef, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';

import { passwordChecks } from './password-policy';

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type' | 'className'>;

export interface TextFieldProps extends InputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email';
  error?: string | null;
  hint?: ReactNode;
  optional?: boolean;
}

export const AuthTextField = forwardRef<HTMLInputElement, TextFieldProps>(function AuthTextField(
  { label, value, onChange, type = 'text', error, hint, optional, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? `f${autoId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ds-auth-field">
      <label className="ds-auth-field__label" htmlFor={inputId}>
        {label}
        {optional ? <span className="ds-auth-field__optional"> (opcional)</span> : null}
      </label>
      <input
        {...rest}
        ref={ref}
        id={inputId}
        type={type}
        className="ds-auth-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint ? (
        <p id={hintId} className="ds-auth-field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="ds-auth-field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export interface PasswordFieldProps extends Omit<InputProps, 'autoComplete'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error?: string | null;
  /** Lista de conferência da política (Decisão 10) abaixo do campo. */
  checklist?: { email?: string | null } | false;
}

function EyeIcon({ crossed }: { crossed: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M10 4.5c-4 0-6.9 3.2-7.8 5.5.9 2.3 3.8 5.5 7.8 5.5s6.9-3.2 7.8-5.5c-.9-2.3-3.8-5.5-7.8-5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="10" cy="10" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {crossed ? <path d="M3.5 3.5l13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /> : null}
    </svg>
  );
}

export const AuthPasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function AuthPasswordField(
  { label, value, onChange, autoComplete, error, checklist, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? `p${autoId}`;
  const errorId = `${inputId}-error`;
  const checklistId = `${inputId}-checklist`;
  const [visible, setVisible] = useState(false);
  const checks = checklist ? passwordChecks(value, checklist.email) : [];
  const describedBy = [checks.length > 0 ? checklistId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ds-auth-field">
      <label className="ds-auth-field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="ds-auth-field__control">
        <input
          {...rest}
          ref={ref}
          id={inputId}
          type={visible ? 'text' : 'password'}
          className="ds-auth-input ds-auth-input--with-toggle"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        <button
          type="button"
          className="ds-auth-toggle"
          aria-label={`Mostrar ${label.toLowerCase()}`}
          aria-pressed={visible}
          aria-controls={inputId}
          onClick={() => setVisible((v) => !v)}
        >
          <EyeIcon crossed={visible} />
        </button>
      </div>
      {checks.length > 0 ? (
        <ul id={checklistId} className="ds-auth-checklist" aria-label="Requisitos da senha">
          {checks.map((c) => (
            <li key={c.id} className={c.ok ? 'ds-auth-checklist__item ds-auth-checklist__item--ok' : 'ds-auth-checklist__item'}>
              {c.label}
              <span className="ds-auth-honeypot">{c.ok ? ' (atendido)' : ' (pendente)'}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p id={errorId} className="ds-auth-field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export interface AuthAlertProps {
  tone: 'critical' | 'success' | 'warning';
  children: ReactNode;
  /** Leva o foco ao aviso quando ele aparece/muda (erros do envio). */
  focusOnShow?: boolean;
  testId?: string;
}

/** Erro = `role="alert"`; sucesso/aviso = `role="status"` (anunciados sem roubar o foco). */
export function AuthAlert({ tone, children, focusOnShow = false, testId }: AuthAlertProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnShow) ref.current?.focus();
  }, [focusOnShow, children]);
  return (
    <div
      ref={ref}
      className={`ds-auth-alert ds-auth-alert--${tone}`}
      role={tone === 'critical' ? 'alert' : 'status'}
      tabIndex={focusOnShow ? -1 : undefined}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
