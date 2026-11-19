import { useTheme } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
  const section = sections[route.name];

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{section.title}</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.description, { color: colors.text }]}>{section.description}</Text>
          <Text style={[styles.notice, { color: colors.text }]}>
            Это каркас приложения. Подключение к боту пока недоступно.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
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
