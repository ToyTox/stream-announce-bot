import { useTheme } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useConnection, type ConnectionState } from './connection';

export type RootTabs = {
  Pairing: undefined;
  Status: undefined;
  Message: undefined;
  Settings: undefined;
  Logs: undefined;
};

export const sections = {
  Pairing: {
    title: 'Сопряжение',
    description: 'Здесь появятся сканирование кода, подключение к боту и отключение телефона.',
    symbol: '1',
  },
  Status: {
    title: 'Статус',
    description: 'Здесь появятся состояние эфира, результаты проверок площадок и ошибки.',
    symbol: '2',
  },
  Message: {
    title: 'Сообщение',
    description: 'Здесь появятся текст, картинка и предпросмотр анонса.',
    symbol: '3',
  },
  Settings: {
    title: 'Настройки',
    description: 'Здесь появятся основные настройки площадок, таймингов и тестового режима.',
    symbol: '4',
  },
  Logs: {
    title: 'Лог',
    description: 'Здесь появятся последние записи о работе бота.',
    symbol: '5',
  },
} satisfies Record<keyof RootTabs, { title: string; description: string; symbol: string }>;

export function PlaceholderScreen({ route }: BottomTabScreenProps<RootTabs>) {
  const { colors } = useTheme();
  const { state, forget } = useConnection();
  const section = sections[route.name];

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{section.title}</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.description, { color: colors.text }]}>{section.description}</Text>
          <Text style={[styles.notice, { color: colors.text }]}>
            Это каркас приложения. Рабочие действия появятся позже.
          </Text>
          {route.name === 'Pairing' && state.kind === 'ready' && <>
            <Text style={[styles.description, { color: colors.text }]}>Бот подключён. API совместим.</Text>
            <Text style={[styles.notice, { color: colors.text }]}>Удаление токена с телефона не отзывает устройство на сервере.</Text>
            <Button title="Удалить токен с телефона" accessibilityLabel="Удалить токен с телефона" color={colors.primary} onPress={forget} />
          </>}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function connectionMessage(state: ConnectionState): { title: string; description: string } {
  switch (state.kind) {
    case 'loading': return { title: 'Проверка подключения', description: 'Восстанавливаем защищённые данные и проверяем API бота.' };
    case 'authorization': return { title: 'Токен не принят', description: 'Токен устройства недействителен или отозван. Нужно новое сопряжение.' };
    case 'forbidden': return { title: 'Доступ запрещён', description: 'Бот отклонил доступ с этого устройства. Проверьте настройки доступа.' };
    case 'incompatible': return { title: 'Несовместимая версия API', description: 'Приложение поддерживает только API версии 1. Обновите приложение или бота.' };
    case 'rate-limit': return { title: 'Слишком много запросов', description: 'Бот ограничил частоту запросов. Повторите проверку после ожидания.' };
    case 'response': return { title: 'Некорректный ответ API', description: 'Бот вернул ответ, который приложение не может проверить.' };
    case 'http': return { title: 'Ошибка API', description: 'Бот не выполнил запрос. Повторите проверку позже.' };
    case 'address': return { title: 'Некорректный адрес бота', description: 'Сохранённый адрес должен указывать на /api/v1. Удалите данные и выполните новое сопряжение.' };
    case 'storage': return {
      title: 'Ошибка защищённого хранилища',
      description: state.damaged ? 'Сохранённые данные повреждены. Удалите их и выполните новое сопряжение.' :
        state.operation === 'delete' ? 'Не удалось удалить токен. Он может оставаться на телефоне. Повторите удаление.' :
        state.operation === 'write' ? 'Не удалось подтвердить сохранение подключения. Повторите сохранение.' : 'Не удалось прочитать подключение. Разблокируйте телефон и повторите попытку.',
    };
    default: return { title: 'Бот недоступен', description: 'Проверьте, что бот запущен и телефон имеет доступ к его сети. Сохранённое подключение не удалено.' };
  }
}

export function ConnectionGate({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const { state, retry, forget } = useConnection();
  const ready = state.kind === 'empty' || state.kind === 'ready';
  const retryAt = 'retryAt' in state ? state.retryAt ?? 0 : 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const message = connectionMessage(state);

  return (
    <View style={styles.screen}>
      <View style={{ flex: 1, display: ready ? 'flex' : 'none' }} accessibilityElementsHidden={!ready} importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}>
        {children}
      </View>
      {!ready && <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{message.title}</Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.description, { color: colors.text }]}>{message.description}</Text>
            {state.kind === 'loading' ? <ActivityIndicator color={colors.primary} accessibilityLabel="Подключение к боту" /> : <>
              {remaining > 0 && <Text style={[styles.notice, { color: colors.text }]}>Повтор доступен через {remaining} с.</Text>}
              <Button title="Повторить" accessibilityLabel="Повторить" color={colors.primary} disabled={remaining > 0} onPress={retry} />
            </>}
            <Button title="Удалить токен с телефона" accessibilityLabel="Удалить токен с телефона" color={colors.primary} onPress={forget} />
            <Text style={[styles.notice, { color: colors.text }]}>Удаление локальных данных не отзывает устройство на сервере. Экран нового сопряжения появится позже.</Text>
          </View>
        </ScrollView>
      </SafeAreaView>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, padding: 24, gap: 24 },
  title: { fontSize: 28, fontWeight: '700' },
  card: { padding: 20, borderRadius: 16, borderWidth: 1, gap: 20 },
  description: { fontSize: 18, lineHeight: 28 },
  notice: { fontSize: 16, lineHeight: 24 },
});
