import { NavigationContainer } from '@react-navigation/native';
import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { Platform, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigation } from './src/navigation';
import { ConnectionProvider } from './src/connection';
import { ConnectionGate } from './src/screens';
import { useAppTheme } from './src/theme';

export default function App() {
  const theme = useAppTheme();

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <StatusBar style={theme.dark ? 'light' : 'dark'} />
        {Platform.OS === 'android' && <NavigationBar style={theme.dark ? 'light' : 'dark'} />}
        <NavigationContainer theme={theme}>
          <ConnectionProvider>
            <ConnectionGate>
              <AppNavigation />
            </ConnectionGate>
          </ConnectionProvider>
        </NavigationContainer>
      </View>
    </SafeAreaProvider>
  );
}
