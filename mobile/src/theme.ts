import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';
import { useColorScheme } from 'react-native';

const lightTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: '#2455a4',
    background: '#f4f6fa',
    card: '#ffffff',
    text: '#182333',
    border: '#cad2df',
  },
};

const darkTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: '#a6c8ff',
    background: '#111821',
    card: '#1c2633',
    text: '#edf2fa',
    border: '#465467',
  },
};

export function useAppTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}
