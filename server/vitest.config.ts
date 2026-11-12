import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      BUNIH_DATA_DIR: './.vitest-data',
      TELEGRAM_MODE: 'off',
      BUNIH_ENABLE_SCHEDULER: 'false',
      BUNIH_SECRET_KEY: 'kunci-uji-coba-saja',
    },
  },
});
