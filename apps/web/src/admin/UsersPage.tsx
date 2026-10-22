import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { SYSTEM_ROLES } from '../api/types';
import type { AdminUser, Permission, RoleInfo } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { can, roleLabel, rolesLabel, useSession } from '../app/session';
import { formatDateTime } from '../lib/format';
import { passwordProblems } from '../lib/password';

interface NewUser {
  email: string;
  name: string;
  password: string;
  roles: string[];
}

/**
 * Checkbox list of role keys with each role's permissions as a hint. A role with a permission the
 * viewer lacks cannot be added unless `beyondOwn` (the server decides the same way); it can still
 * be removed.
 */
function RolePicker({
  options,
  value,
  onChange,
  label,
  held,
  beyondOwn = false,
}: {
  options: { key: string; permissions?: Permission[] }[];
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  held: readonly Permission[];
  beyondOwn?: boolean;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="font-medium">{label}</legend>
      {options.map((r) => (
        <label key={r.key} className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={value.includes(r.key)}
            disabled={
              !beyondOwn &&
              !value.includes(r.key) &&
              !!r.permissions?.some((p) => !held.includes(p))
            }
            onChange={(e) =>
              onChange(e.target.checked ? [...value, r.key] : value.filter((k) => k !== r.key))
            }
          />
          <span>
            {roleLabel(r.key)}
            {r.permissions && (
              <span className="block text-[11px] text-muted">{r.permissions.join(' · ')}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function UsersPage() {
  const qc = useQueryClient();
  const { user: me } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState<NewUser | null>(null);
  const [resetting, setResetting] = useState<{ user: AdminUser; password: string } | null>(null);
  const [editingRoles, setEditingRoles] = useState<{ user: AdminUser; roles: string[] } | null>(
    null,
  );
  const [modalError, setModalError] = useState<unknown>(null);
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ items: AdminUser[] }>('/api/admin/users'),
  });
  // Assigning roles (on creation or later) needs ADMIN.ROLES as well as ADMIN.USERS.
  const assignsRoles = can(me, 'ADMIN.ROLES');
  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.get<{ items: RoleInfo[] }>('/api/admin/roles'),
    enabled: assignsRoles,
  });
  const roleOptions: { key: string; permissions?: Permission[] }[] =
    roles.data?.items ?? SYSTEM_ROLES.map((key) => ({ key }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });

  async function saveRoles() {
    if (!editingRoles) return;
    setModalError(null);
    try {
      await api.put(`/api/admin/users/${editingRoles.user.id}/roles`, {
        roles: editingRoles.roles,
      });
      setEditingRoles(null);
      void refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  async function patch(id: string, body: Partial<Pick<AdminUser, 'name' | 'active'>>) {
    setError(null);
    try {
      await api.patch(`/api/admin/users/${id}`, body);
      void refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function create() {
    if (!creating) return;
    setModalError(null);
    try {
      await api.post('/api/admin/users', { ...creating, email: creating.email.trim() });
      setCreating(null);
      void refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  async function reset() {
    if (!resetting) return;
    setModalError(null);
    try {
      await api.post(`/api/admin/users/${resetting.user.id}/reset-password`, {
        password: resetting.password,
      });
      setResetting(null);
      void refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  const createProblems = creating ? passwordProblems(creating.password) : [];
  const resetProblems = resetting ? passwordProblems(resetting.password) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Usuários</h1>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!assignsRoles}
          title={assignsRoles ? undefined : 'Criar usuários exige a permissão ADMIN.ROLES'}
          onClick={() => {
            setModalError(null);
            setCreating({ email: '', name: '', password: '', roles: ['VIEWER'] });
          }}
        >
          Novo usuário
        </button>
      </div>
      <p className="text-xs text-muted">
        Leitor: consultas e tabelas temporárias · Operador: + INSERT/UPDATE · Administrador:
        administração e auditoria, sem gravação de dados do ERP. As permissões efetivas somam os
        papéis do usuário e dos seus grupos ativos. Novos usuários e senhas redefinidas exigem troca
        no próximo login.
      </p>
      <ErrorBox error={error ?? users.error} />
      <div className="overflow-auto rounded border border-line bg-panel">
        <table className="table-std text-xs" data-testid="users-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Papéis</th>
              <th>Status</th>
              <th>Último login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data?.items ?? []).map((u) => {
              const self = u.id === me.id;
              return (
                <tr key={u.id} className={u.active ? '' : 'opacity-60'}>
                  <td>
                    {u.name}
                    {self && <span className="ml-1 text-muted">(você)</span>}
                  </td>
                  <td>{u.email}</td>
                  <td data-testid={`roles-${u.email}`} title={u.permissions.join('\n')}>
                    {rolesLabel(u.roles)}
                  </td>
                  <td>
                    {u.active ? 'ativo' : 'inativo'}
                    {u.mustChangePassword && (
                      <span className="badge ml-1 text-warn">troca de senha pendente</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{formatDateTime(u.lastLoginAt)}</td>
                  <td className="whitespace-nowrap">
                    <button
                      type="button"
                      className="btn"
                      disabled={self}
                      onClick={() => {
                        const verb = u.active ? 'Desativar' : 'Reativar';
                        if (window.confirm(`${verb} ${u.email}?`))
                          void patch(u.id, { active: !u.active });
                      }}
                    >
                      {u.active ? 'Desativar' : 'Reativar'}
                    </button>{' '}
                    <button
                      type="button"
                      className="btn"
                      disabled={self || !assignsRoles}
                      title={
                        self
                          ? 'Ninguém altera as próprias permissões'
                          : assignsRoles
                            ? undefined
                            : 'Atribuir papéis exige a permissão ADMIN.ROLES'
                      }
                      onClick={() => {
                        setModalError(null);
                        setEditingRoles({ user: u, roles: u.directRoles });
                      }}
                    >
                      Papéis
                    </button>{' '}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setModalError(null);
                        setResetting({ user: u, password: '' });
                      }}
                    >
                      Redefinir senha
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal
        open={creating !== null}
        title="Novo usuário"
        onClose={() => setCreating(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreating(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                !creating?.email.trim() ||
                !creating.name.trim() ||
                creating.roles.length === 0 ||
                createProblems.length > 0
              }
              onClick={() => void create()}
            >
              Criar
            </button>
          </>
        }
      >
        {creating && (
          <div className="space-y-2 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                value={creating.name}
                maxLength={120}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">E-mail</span>
              <input
                className="input w-full"
                type="email"
                autoComplete="off"
                value={creating.email}
                onChange={(e) => setCreating({ ...creating, email: e.target.value })}
              />
            </label>
            <RolePicker
              label="Papéis"
              options={roleOptions}
              held={me?.permissions ?? []}
              value={creating.roles}
              onChange={(next) => setCreating({ ...creating, roles: next })}
            />
            <label className="block space-y-1">
              <span className="font-medium">Senha inicial</span>
              <input
                className="input w-full"
                type="password"
                autoComplete="new-password"
                value={creating.password}
                onChange={(e) => setCreating({ ...creating, password: e.target.value })}
              />
            </label>
            {creating.password && createProblems.length > 0 && (
              <ul className="list-disc pl-4 text-warn">
                {createProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>

      <Modal
        open={editingRoles !== null}
        title={`Papéis${editingRoles ? ` — ${editingRoles.user.email}` : ''}`}
        onClose={() => setEditingRoles(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditingRoles(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void saveRoles()}>
              Salvar papéis
            </button>
          </>
        }
      >
        {editingRoles && (
          <div className="space-y-2 text-xs">
            <p className="text-muted">
              Papéis atribuídos diretamente. Papéis recebidos por grupos continuam valendo, e a
              alteração vale a partir da próxima requisição do usuário.
            </p>
            <p className="text-muted">
              {editingRoles.user.mustChangePassword
                ? 'Papéis com permissões que você não tem ficam disponíveis depois que este usuário entrar e definir a própria senha.'
                : 'Você pode atribuir papéis com permissões que você não tem (por exemplo Operador); isso não muda as suas permissões.'}
            </p>
            <RolePicker
              label="Papéis diretos"
              options={roleOptions}
              held={me?.permissions ?? []}
              // Same rule as the server: another user (this modal is never for oneself) who
              // chose their own password, assigned by a role administrator.
              beyondOwn={assignsRoles && !editingRoles.user.mustChangePassword}
              value={editingRoles.roles}
              onChange={(next) => setEditingRoles({ ...editingRoles, roles: next })}
            />
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>

      <Modal
        open={resetting !== null}
        title={`Redefinir senha${resetting ? ` — ${resetting.user.email}` : ''}`}
        onClose={() => setResetting(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setResetting(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={resetProblems.length > 0}
              onClick={() => void reset()}
            >
              Redefinir
            </button>
          </>
        }
      >
        {resetting && (
          <div className="space-y-2 text-xs">
            <p className="text-muted">
              As sessões ativas do usuário serão encerradas e ele precisará trocar a senha no
              próximo login.
            </p>
            <label className="block space-y-1">
              <span className="font-medium">Nova senha temporária</span>
              <input
                className="input w-full"
                type="password"
                autoComplete="new-password"
                value={resetting.password}
                onChange={(e) => setResetting({ ...resetting, password: e.target.value })}
              />
            </label>
            {resetting.password && resetProblems.length > 0 && (
              <ul className="list-disc pl-4 text-warn">
                {resetProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>
    </div>
  );
}
