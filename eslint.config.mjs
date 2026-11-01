import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/*.tmp.mjs', 'out/**', 'release/**', 'node_modules/**', 'tests/fixtures/**', 'resources/**', '.claude/**', 'test-results/**', 'screens/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Electron 直接运行的 CommonJS 工具脚本
    files: ['scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', __dirname: 'readonly', setTimeout: 'readonly', Buffer: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
)
