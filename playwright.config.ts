import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  workers: 1,
  // CI 上偶发的启动时序问题（比如 10 秒内没等到预览页）重试一次；稳定复现的失败重试后照样失败
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  expect: { timeout: 8_000 }
})
