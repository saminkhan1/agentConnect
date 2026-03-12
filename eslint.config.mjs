import neostandard, { resolveIgnoresFromGitignore } from 'neostandard';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...neostandard({
    ts: true,
    noStyle: true,
    ignores: resolveIgnoresFromGitignore(),
  }),
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      camelcase: 'off',
      'no-void': ['error', { allowAsStatement: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['eslint.config.mjs', 'scripts/setup-git-hooks.cjs'],
  },
);
