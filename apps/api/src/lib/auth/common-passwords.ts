// Story 22.1a-1 · D8 — lista LOCAL de senhas comuns (sem chamada externa tipo HIBP).
//
// Duas camadas, ambas comparadas em minúsculas:
//  1. COMMON_BASES — palavras/sequências que aparecem no topo de vazamentos públicos (inglês e
//     pt-BR) e termos óbvios deste negócio. Senha cujo "miolo" (sem dígitos/símbolos nas pontas)
//     é uma base é recusada: `Password2026!`, `!!senha123456`, `blackshop12345`.
//  2. COMMON_PASSWORDS — senhas inteiras comuns com 12+ caracteres (o mínimo da política) que não
//     caem na regra 1 (sequências de teclado/dígitos, frases curtas coladas) + expansão
//     determinística das bases com os sufixos mais usados.
// Total ≈ 1.000 itens (teste em auth-passwords.test.ts). Atualizar = editar este arquivo.

export const COMMON_BASES: readonly string[] = [
  // inglês — topo de vazamentos
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'pass', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn',
  'zxcvbnm', 'letmein', 'welcome', 'admin', 'administrator', 'login', 'master', 'monkey', 'dragon', 'football',
  'baseball', 'basketball', 'soccer', 'hockey', 'superman', 'batman', 'spiderman', 'iloveyou', 'trustno1', 'sunshine',
  'princess', 'shadow', 'michael', 'jennifer', 'jordan', 'hunter', 'ranger', 'buster', 'thomas', 'robert',
  'charlie', 'daniel', 'jessica', 'ashley', 'bailey', 'pepper', 'cheese', 'computer', 'internet', 'secret',
  'starwars', 'whatever', 'freedom', 'mustang', 'harley', 'killer', 'summer', 'winter', 'spring', 'autumn',
  'flower', 'hello', 'helloworld', 'changeme', 'default', 'abc', 'abcdef', 'abcdefgh', 'test', 'tester',
  'testing', 'guest', 'root', 'toor', 'user', 'access', 'matrix', 'samsung', 'apple', 'google',
  'microsoft', 'windows', 'linux', 'facebook', 'instagram', 'twitter', 'youtube', 'amazon', 'netflix', 'spotify',
  'liverpool', 'chelsea', 'arsenal', 'barcelona', 'realmadrid', 'manchester', 'pokemon', 'minecraft', 'fortnite', 'naruto',
  'loveme', 'lovely', 'mylove', 'babygirl', 'angel', 'family', 'forever', 'friends', 'blessed', 'jesus',
  'iloveu', 'qazwsx', 'qazwsxedc', '1qaz2wsx', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'zaq12wsx', 'azerty', 'qwertz',
  'aa', 'aaa', 'abc123', 'pass123', 'admin123', 'root123', 'welcome1', 'password1', 'letmein1', 'monkey1',
  // pt-BR
  'senha', 'senhas', 'minhasenha', 'senhasegura', 'senhaforte', 'mudar', 'mudarsenha', 'trocar', 'trocarsenha', 'acesso',
  'entrar', 'brasil', 'brazil', 'saopaulo', 'riodejaneiro', 'flamengo', 'corinthians', 'palmeiras', 'santos', 'gremio',
  'cruzeiro', 'vasco', 'botafogo', 'fluminense', 'internacional', 'saopaulofc', 'atletico', 'bahia', 'sport', 'vitoria',
  'amor', 'meuamor', 'teamo', 'amomuito', 'familia', 'deus', 'deusefiel', 'jesuscristo', 'felicidade', 'saudade',
  'gabriel', 'lucas', 'pedro', 'mateus', 'matheus', 'rafael', 'gustavo', 'felipe', 'bruno', 'leonardo',
  'juliana', 'fernanda', 'amanda', 'camila', 'beatriz', 'mariana', 'larissa', 'leticia', 'carolina', 'gabriela',
  'maria', 'joao', 'jose', 'ana', 'paulo', 'carlos', 'marcos', 'antonio', 'francisco', 'luiz',
  'futebol', 'cachorro', 'gatinho', 'princesa', 'estrela', 'chocolate', 'morango', 'banana', 'abacaxi', 'computador',
  'teclado', 'usuario', 'administrador', 'sistema', 'empresa', 'trabalho', 'escritorio', 'loja', 'minhaloja', 'vendas',
  'dinheiro', 'sucesso', 'vitoria2', 'bemvindo', 'olamundo', 'segredo', 'qualquer', 'teste', 'testando', 'padrao',
  // este negócio / painel
  'blackshop', 'black', 'shop', 'shopify', 'loja123', 'backoffice', 'painel', 'dashboard', 'authenlondon', 'landinglab',
  'trustshield', 'kuchinski', 'checkout', 'stripe', 'resend', 'railway', 'vercel', 'supabase', 'ecommerce', 'dropshipping',
];

const LONG_COMMON: readonly string[] = [
  // sequências de dígitos/teclado com 12+ caracteres
  '123456789012', '1234567890123', '12345678901234', '123456789012345', '1234567890qwerty', '0123456789ab', '098765432112',
  '111111111111', '000000000000', '123123123123', '121212121212', '112233445566', '987654321098', '147258369147',
  '159753159753', '123321123321', '123456123456', '654321654321', '101010101010', '696969696969', '777777777777',
  'qwertyuiopas', 'qwertyuiop12', 'qwertyuiop123', 'qwertyuiopasdf', 'qwertyuiopasdfgh', 'asdfghjkl123', 'asdfghjklqwe',
  'zxcvbnm12345', 'zxcvbnmasdfg', '1q2w3e4r5t6y', '1q2w3e4r5t6y7u', 'q1w2e3r4t5y6', 'qazwsxedcrfv', '1qaz2wsx3edc',
  '1qaz2wsx3edc4rfv', 'zaq1xsw2cde3', 'qweasdzxc123', 'qwerty123456', '123456qwerty', 'asdf1234asdf', 'abcd1234abcd',
  'abcdefghijkl', 'abcdefghijklm', 'abcdefgh1234', 'aaaaaaaaaaaa', 'abcabcabcabc', 'qwertyqwerty', 'asdasdasdasd',
  // frases coladas
  'iloveyouiloveyou', 'iloveyoubaby', 'iloveyoumom', 'letmeinplease', 'letmeinnow123', 'welcometomyworld', 'helloworld123',
  'correcthorsebatterystaple', 'thequickbrownfox', 'thequickbrownfoxjumpsoverthelazydog', 'opensesame123', 'changemeplease',
  'passwordpassword', 'mypasswordis', 'thisismypassword', 'notmypassword', 'nopassword123', 'supersecretpassword',
  'eusouofilho', 'euteamomuito', 'teamomeuamor', 'amominhafamilia', 'deuseamor123', 'deusnocomando', 'gloriaadeus123',
  'minhasenhaforte', 'minhasenhasecreta', 'senhasecreta123', 'naoseiasenha', 'esqueciasenha', 'troqueasenha',
];

const SUFFIXES: readonly string[] = ['123', '1234', '12345', '123456', '12345678', '!', '2025', '2026'];

function build(): ReadonlySet<string> {
  const out = new Set<string>(LONG_COMMON);
  // Só interessa o que passaria do mínimo de 12 (o resto já cai na regra de tamanho).
  for (const base of COMMON_BASES) {
    for (const candidate of [base, ...SUFFIXES.map((suffix) => `${base}${suffix}`)]) {
      if (candidate.length >= 12) out.add(candidate);
    }
  }
  return out;
}

export const COMMON_PASSWORDS: ReadonlySet<string> = build();

const BASE_SET: ReadonlySet<string> = new Set(COMMON_BASES);

/** Senha comum? (lista inteira OU base comum cercada só de dígitos/símbolos; caixa ignorada) */
export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (core.length > 0 && BASE_SET.has(core)) return true;
  // Repetição de uma base comum ("senhasenhasenha", "passwordpassword1").
  for (const base of COMMON_BASES) {
    if (base.length >= 4 && core.length >= base.length * 2 && core.replace(new RegExp(base, 'g'), '') === '') return true;
  }
  return false;
}
