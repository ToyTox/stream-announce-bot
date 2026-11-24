import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InfoResponse } from '../../shared/api-v1';
import { ApiError, createApiClient, type ApiFailure, type ConnectionCredentials } from './api';
import { CredentialsError, credentialsStore, type StorageOperation } from './credentials';

export type ConnectionState =
  | { kind: 'loading' | 'empty' }
  | { kind: 'ready'; info: InfoResponse }
  | { kind: 'storage'; operation: StorageOperation; damaged: boolean }
  | { kind: ApiFailure; retryAt?: number };

type Intent = { kind: 'restore' | 'delete' } | { kind: 'connect'; credentials: ConnectionCredentials };

interface ConnectionContextValue {
  state: ConnectionState;
  retry: () => void;
  forget: () => void;
  connect: (credentials: ConnectionCredentials) => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionState>({ kind: 'loading' });
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const retryAt = useRef(0);
  const intent = useRef<Intent>({ kind: 'restore' });

  async function run(next: Intent) {
    const current = ++generation.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    intent.current = next;
    busy.current = true;
    retryAt.current = 0;
    setState({ kind: 'loading' });
    const latest = () => current === generation.current;
    try {
      if (next.kind === 'delete') {
        await credentialsStore.remove();
        if (latest()) {
          intent.current = { kind: 'restore' };
          setState({ kind: 'empty' });
        }
        return;
      }
      const credentials = next.kind === 'connect' ? next.credentials : await credentialsStore.read();
      if (!latest()) return;
      if (!credentials) {
        setState({ kind: 'empty' });
        return;
      }
      const client = createApiClient(credentials);
      if (next.kind === 'connect') await credentialsStore.save(credentials);
      if (!latest()) return;
      const info = await client.checkConnection(controller.signal);
      if (latest()) setState({ kind: 'ready', info });
    } catch (error) {
      if (!latest()) return;
      if (error instanceof CredentialsError) {
        setState({ kind: 'storage', operation: error.operation, damaged: error.damaged });
      } else if (error instanceof ApiError) {
        retryAt.current = error.retryAt ?? 0;
        setState({ kind: error.kind, retryAt: error.retryAt });
      } else {
        setState({ kind: 'unavailable' });
      }
    } finally {
      if (latest()) busy.current = false;
    }
  }

  useEffect(() => {
    void run({ kind: 'restore' });
    return () => {
      ++generation.current;
      active.current?.abort();
    };
  }, []);

  return (
    <ConnectionContext.Provider value={{
      state,
      retry: () => { if (!busy.current && Date.now() >= retryAt.current) void run(intent.current); },
      forget: () => { void run({ kind: 'delete' }); },
      connect: (credentials) => { void run({ kind: 'connect', credentials: { ...credentials } }); },
    }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error('Не найдено состояние подключения.');
  return value;
}
