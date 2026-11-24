import * as SecureStore from 'expo-secure-store';
import { apiAddress, validToken, type ConnectionCredentials } from './api';

export type StorageOperation = 'read' | 'write' | 'delete';

export class CredentialsError extends Error {
  constructor(readonly operation: StorageOperation, readonly damaged = false) {
    super('Не удалось обработать защищённые данные подключения.');
    this.name = 'CredentialsError';
  }
}

const key = 'bot-connection-v1';
const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

function validate(value: unknown): ConnectionCredentials {
  if (!value || typeof value !== 'object' || !('apiUrl' in value) || typeof value.apiUrl !== 'string' ||
      !('token' in value) || !validToken(value.token)) throw new Error();
  return { apiUrl: apiAddress(value.apiUrl), token: value.token };
}

export function createCredentialsStore() {
  let mutations = Promise.resolve();
  async function bounded<T>(operation: StorageOperation, action: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(reject, 5000); }),
      ]);
    } catch {
      throw new CredentialsError(operation);
    } finally {
      clearTimeout(timer);
    }
  }

  function mutate(operation: StorageOperation, action: () => Promise<void>): Promise<void> {
    const result = mutations.then(action);
    mutations = result.catch(() => {});
    return bounded(operation, result);
  }

  return {
    async read(): Promise<ConnectionCredentials | null> {
      const raw = await bounded('read', Promise.resolve().then(() => SecureStore.getItemAsync(key, options)));
      if (raw === null) return null;
      try {
        const record: unknown = JSON.parse(raw);
        if (!record || typeof record !== 'object' || !('format' in record) || record.format !== 1) throw new Error();
        return validate(record);
      } catch {
        throw new CredentialsError('read', true);
      }
    },
    save(value: ConnectionCredentials): Promise<void> {
      let record: ConnectionCredentials;
      try {
        record = validate(value);
      } catch {
        return Promise.reject(new CredentialsError('write'));
      }
      return mutate('write', () => SecureStore.setItemAsync(key, JSON.stringify({ format: 1, ...record }), options));
    },
    remove(): Promise<void> {
      return mutate('delete', () => SecureStore.deleteItemAsync(key, options));
    },
  };
}

export const credentialsStore = createCredentialsStore();
