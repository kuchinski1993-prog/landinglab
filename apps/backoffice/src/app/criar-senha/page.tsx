'use client';

// Story 22.1b — link do e-mail (`PASSWORD_LINK_PATH` da API = `/criar-senha`): a mesma tela de
// /login/criar-senha, sem redirecionar (redirecionar levaria o token para outra URL e para o histórico).

import { SetPasswordScreen } from '@/components/auth/SetPasswordScreen';

export default function CriarSenhaPage(): JSX.Element {
  return <SetPasswordScreen />;
}
