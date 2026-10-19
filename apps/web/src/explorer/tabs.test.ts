import { beforeEach, describe, expect, it } from 'vitest';
import { clearSavedTabs, loadTabs, newTab, saveTabs } from './tabs';

describe('saved editor tabs', () => {
  beforeEach(() => localStorage.clear());

  it('restores the tabs of the same user', () => {
    const tab = {
      ...newTab([], "SELECT * FROM clientes WHERE cidade = 'Xique-Xique'"),
      title: 'SP',
    };
    saveTabs('u1', [tab], tab.id);
    expect(loadTabs('u1').tabs[0]?.sql).toContain('Xique-Xique');
    expect(loadTabs('u2').tabs[0]?.sql).not.toContain('Xique-Xique');
  });

  it('removes every saved tab on logout and leaves other settings alone', () => {
    const tab = newTab([], 'SELECT 1');
    saveTabs('u1', [tab], tab.id);
    saveTabs('u2', [tab], tab.id);
    localStorage.setItem('dbx.theme', 'dark');
    clearSavedTabs();
    expect(Object.keys(localStorage).filter((k) => k.startsWith('dbx.tabs.'))).toEqual([]);
    expect(localStorage.getItem('dbx.theme')).toBe('dark');
  });
});
