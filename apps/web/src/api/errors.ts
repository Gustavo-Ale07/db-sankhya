import { ApiError } from './client';

/** pt-BR messages for the API error codes (the API itself answers in English). */
export const ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Faça login para continuar.',
  INVALID_CREDENTIALS:
    'E-mail ou senha inválidos. Após várias falhas seguidas, a conta fica bloqueada por um tempo.',
  SESSION_EXPIRED: 'Sua sessão expirou. Faça login novamente.',
  ACCOUNT_LOCKED: 'Conta bloqueada temporariamente por excesso de tentativas. Tente mais tarde.',
  FORBIDDEN: 'Você não tem permissão para esta ação.',
  PASSWORD_CHANGE_REQUIRED: 'Defina uma nova senha antes de continuar.',
  CSRF_REJECTED: 'Requisição recusada pela proteção CSRF. Recarregue a página.',
  VALIDATION_ERROR: 'Dados inválidos na requisição.',
  NOT_FOUND: 'Registro não encontrado.',
  CONFLICT: 'Conflito com o estado atual.',
  RATE_LIMITED: 'Muitas requisições. Aguarde alguns segundos.',
  RESOURCE_NOT_FOUND: 'Tabela desconhecida. Consulte a árvore de tabelas à esquerda.',
  COLUMN_NOT_FOUND: 'Coluna desconhecida. Expanda a tabela na árvore para ver as colunas.',
  AMBIGUOUS_COLUMN: 'Coluna ambígua: qualifique com o alias da tabela.',
  SQL_PARSE_ERROR: 'Erro de sintaxe SQL.',
  SQL_UNSUPPORTED: 'Recurso SQL não suportado por este dialeto.',
  SQL_FORBIDDEN: 'Comando recusado: apenas um SELECT, sem comentários nem palavras de escrita.',
  OPERATION_NOT_SUPPORTED: 'Esta operação não é suportada para a tabela.',
  COLUMN_NOT_WRITABLE: 'Esta coluna não pode ser alterada.',
  REQUIRED_COLUMN_MISSING: 'Faltam colunas obrigatórias no INSERT.',
  READ_ONLY_MODE: 'O sistema está em modo somente leitura (SAFE_MODE).',
  INSERT_DISABLED: 'INSERT está desabilitado no servidor.',
  UPDATE_DISABLED: 'UPDATE está desabilitado no servidor.',
  DELETE_DISABLED: 'DELETE está desabilitado no servidor.',
  WHERE_REQUIRED: 'UPDATE e DELETE exigem cláusula WHERE.',
  WRITE_ROW_LIMIT_EXCEEDED: 'A escrita afetaria mais registros que o limite permitido.',
  WRITE_NO_TARGETS: 'Nenhum registro corresponde ao WHERE.',
  CONFIRMATION_REQUIRED: 'Esta operação exige confirmação.',
  CONFIRMATION_INVALID: 'Confirmação inválida. Gere uma nova prévia.',
  CONFIRMATION_EXPIRED: 'A prévia expirou. Execute novamente para gerar uma nova prévia.',
  CONFIRMATION_USED: 'Esta confirmação já foi utilizada.',
  TARGETS_CHANGED: 'Os dados mudaram desde a prévia. Gere uma nova prévia antes de continuar.',
  QUERY_ROW_LIMIT_EXCEEDED: 'O LIMIT pedido excede o máximo de linhas permitido.',
  QUERY_LIMIT_EXCEEDED: 'A consulta excede os limites configurados.',
  API_CALL_LIMIT_EXCEEDED: 'A consulta exigiria chamadas demais ao gateway. Adicione filtros.',
  JOIN_CARDINALITY_LIMIT: 'O JOIN geraria linhas demais. Restrinja as tabelas com WHERE.',
  QUERY_TIMEOUT: 'A consulta excedeu o tempo limite.',
  QUERY_CANCELLED: 'Consulta cancelada.',
  SANKHYA_AUTH_ERROR:
    'O gateway Sankhya recusou a autenticação. Verifique as credenciais da conexão.',
  SANKHYA_RATE_LIMITED: 'O gateway Sankhya limitou as requisições. Aguarde e tente novamente.',
  SANKHYA_UNAVAILABLE: 'O gateway Sankhya está indisponível no momento.',
  SANKHYA_API_ERROR: 'O Sankhya recusou a operação.',
  SANKHYA_BAD_RESPONSE: 'O gateway Sankhya retornou uma resposta inesperada.',
  SANKHYA_NOT_CONFIGURED: 'Nenhuma conexão Sankhya está configurada.',
  SANKHYA_TIMEOUT: 'O gateway Sankhya não respondeu a tempo.',
  WRITE_OUTCOME_UNKNOWN:
    'Não foi possível confirmar o resultado da escrita. Verifique o registro no Sankhya antes de tentar de novo.',
  INTERNAL_ERROR: 'Erro interno do servidor.',
  NETWORK_ERROR: 'Não foi possível contatar o servidor.',
  HTTP_ERROR: 'Erro na requisição.',
};

export function translateCode(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Erro inesperado.';
}

/**
 * pt-BR for the server messages a user sees (result notes, error details). The server answers in
 * English and its codes never change; a message not listed here is shown as it came.
 */
const MESSAGES: [RegExp, (...m: string[]) => string][] = [
  [
    /^Result truncated to (\d+) rows\. Add filters or an explicit LIMIT\/OFFSET to page through the data\.$/,
    (n) =>
      `Resultado limitado a ${n} linhas. Adicione filtros ou um LIMIT/OFFSET explícito para paginar.`,
  ],
  [/^Result truncated to (\d+) rows\.$/, (n) => `Resultado limitado a ${n} linhas.`],
  [
    /^Result truncated by the gateway at (\d+) rows\.$/,
    (n) => `O gateway cortou o resultado em ${n} linhas.`,
  ],
  [
    /^Sankhya part \(([^)]*)\) cut at (\d+) rows\.$/,
    (tables, n) => `A parte do Sankhya (${tables}) foi cortada em ${n} linhas.`,
  ],
  [/^Table not found$/, () => 'Tabela não encontrada.'],
  [
    /^The change affects more than (\d+) rows, the most its preview may read; the write limit is (\d+)\.$/,
    (n, limit) =>
      `A alteração afeta mais de ${n} linhas, o máximo que a prévia pode ler; o limite de escrita é ${limit}.`,
  ],
  [/^The change affects more than (\d+) rows\.$/, (n) => `A alteração afeta mais de ${n} linhas.`],
  [
    /^Table (\S+) is not in the catalog of this connection; the catalog is incomplete, refresh it and try again$/,
    (t) =>
      `A tabela ${t} não está no catálogo desta conexão; o catálogo está incompleto: recarregue-o e tente de novo.`,
  ],
  [
    /^Table (\S+) is not in the catalog of this connection$/,
    (t) => `A tabela ${t} não está no catálogo desta conexão.`,
  ],
  [
    /^Unknown table "([^"]*)"\.(?: Did you mean "([^"]*)"\?)?$/,
    (t, hint) => `Tabela desconhecida "${t}".${hint ? ` Você quis dizer "${hint}"?` : ''}`,
  ],
  [
    /^Unknown column "([^"]*)"\.(?: Did you mean "([^"]*)"\?)?$/,
    (c, hint) => `Coluna desconhecida "${c}".${hint ? ` Você quis dizer "${hint}"?` : ''}`,
  ],
  [
    /^Unknown table or alias "([^"]*)"\.(?: Did you mean "([^"]*)"\?)?$/,
    (t, hint) => `Tabela ou alias desconhecido "${t}".${hint ? ` Você quis dizer "${hint}"?` : ''}`,
  ],
];

export function translateMessage(message: string): string {
  for (const [pattern, render] of MESSAGES) {
    const m = pattern.exec(message);
    if (m) return render(...m.slice(1).map((g) => g ?? ''));
  }
  return message;
}

export interface DisplayError {
  code: string;
  title: string;
  detail: string | undefined;
  requestId: string | undefined;
}

/** The pt-BR title plus the server's own (English, more specific) message as detail. */
export function describeError(err: unknown): DisplayError {
  if (err instanceof ApiError) {
    const title = translateCode(err.code);
    return {
      code: err.code,
      title,
      detail: err.message && err.message !== title ? translateMessage(err.message) : undefined,
      requestId: err.requestId,
    };
  }
  return {
    code: 'UNKNOWN',
    title: 'Erro inesperado.',
    detail: err instanceof Error ? err.message : undefined,
    requestId: undefined,
  };
}
