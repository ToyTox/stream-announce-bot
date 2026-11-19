module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts?(x)'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)/|expo(nent)?(/|-)|@expo(nent)?/|@react-navigation/|react-native-safe-area-context/|react-native-screens/)',
  ],
  restoreMocks: true,
};
