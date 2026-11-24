jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

jest.unmock('react-native/Libraries/Utilities/useColorScheme');

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

beforeEach(() => {
  const storage = jest.requireMock('expo-secure-store');
  storage.getItemAsync.mockReset().mockResolvedValue(null);
  storage.setItemAsync.mockReset().mockResolvedValue(undefined);
  storage.deleteItemAsync.mockReset().mockResolvedValue(undefined);
});
