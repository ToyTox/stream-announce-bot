import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { PlaceholderScreen, sections, type RootTabs } from './screens';

const Tabs = createBottomTabNavigator<RootTabs>();

export function AppNavigation() {
  return (
    <Tabs.Navigator
      initialRouteName="Pairing"
      backBehavior="history"
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarAccessibilityLabel: `Раздел «${sections[route.name].title}»`,
        tabBarLabelStyle: { fontSize: 11 },
        tabBarIcon: ({ color }) => <Text accessible={false} style={{ color, fontSize: 18 }}>{sections[route.name].symbol}</Text>,
        animation: 'none',
      })}
    >
      {(Object.keys(sections) as (keyof RootTabs)[]).map((name) => (
        <Tabs.Screen key={name} name={name} component={PlaceholderScreen} options={{ title: sections[name].title }} />
      ))}
    </Tabs.Navigator>
  );
}
