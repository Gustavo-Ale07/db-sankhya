// Editor tabs are a per-browser convenience (drafts); saved queries live on the server.

export interface EditorTab {
  id: string;
  title: string;
  sql: string;
  savedId?: string | undefined;
  dirty?: boolean;
}

const WELCOME = `-- Bem-vindo ao DB-Sankhya.
-- Ctrl+Enter (ou F5) executa a instrução sob o cursor; Ctrl+Space sugere tabelas e colunas.
SELECT CODPARC, NOMEPARC, CODCID
FROM TGFPAR
WHERE ATIVO = 'S'
ORDER BY NOMEPARC;
`;

const MAX_TABS = 30;
const key = (userId: string) => `dbx.tabs.${userId}`;

export function newTab(existing: EditorTab[], sql = ''): EditorTab {
  let n = existing.length + 1;
  const titles = new Set(existing.map((t) => t.title));
  while (titles.has(`Consulta ${n}`)) n++;
  return { id: crypto.randomUUID(), title: `Consulta ${n}`, sql };
}

function isTab(v: unknown): v is EditorTab {
  const t = v as EditorTab;
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.id === 'string' &&
    typeof t.title === 'string' &&
    typeof t.sql === 'string'
  );
}

export function loadTabs(userId: string): { tabs: EditorTab[]; activeId: string } {
  try {
    const raw = localStorage.getItem(key(userId));
    if (raw) {
      const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
      const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isTab).slice(0, MAX_TABS) : [];
      if (tabs.length > 0) {
        const activeId =
          typeof parsed.activeId === 'string' && tabs.some((t) => t.id === parsed.activeId)
            ? parsed.activeId
            : tabs[0]!.id;
        return { tabs, activeId };
      }
    }
  } catch {
    // Corrupt or unavailable storage: start fresh.
  }
  const first = { ...newTab([], WELCOME), title: 'Consulta 1' };
  return { tabs: [first], activeId: first.id };
}

/** Drops every saved editor tab: SQL text can hold customer data, so nothing outlives a logout. */
export function clearSavedTabs(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('dbx.tabs.')) localStorage.removeItem(k);
    }
  } catch {
    // Storage unavailable: nothing was saved either.
  }
}

export function saveTabs(userId: string, tabs: EditorTab[], activeId: string): void {
  try {
    localStorage.setItem(key(userId), JSON.stringify({ tabs: tabs.slice(0, MAX_TABS), activeId }));
  } catch {
    // Quota exceeded or storage disabled: tabs just won't survive a reload.
  }
}
