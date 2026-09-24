/* @ts-ignore */
import { Config } from '@jest/types';

const config: Config.InitialOptions = {
  testEnvironment: 'node',
  preset: 'ts-jest',
  transform: {
    '^.+\\.(ts)$': [
      'ts-jest', {
        tsconfig: 'tsconfig.json'
      }
    ]
  },
  moduleNameMapper: {
    '^@/(.+)$': '<rootDir>/src/$1'
  },
  moduleFileExtensions: [
    'ts',
    'js',
    'json'
  ],
  testMatch: [
    '<rootDir>/test/**/*.spec.(js|ts)'
  ],
  collectCoverage: true,
  collectCoverageFrom: [
    '<rootDir>/src/**/*.{js,ts}',
    '!<rootDir>/src/__test__/**'
  ],
  coveragePathIgnorePatterns: [
  ],
  coverageDirectory: '<rootDir>/test/coverage',
  coverageReporters: [
    'lcov',
    'text-summary'
  ]
};

export default config;
