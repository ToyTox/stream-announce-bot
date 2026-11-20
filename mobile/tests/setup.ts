jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

jest.unmock('react-native/Libraries/Utilities/useColorScheme');
