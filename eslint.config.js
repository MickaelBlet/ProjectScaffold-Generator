import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: ['dist-web', 'dist-tauri', 'dist-electron', 'dist-vscode', 'vscode/out', 'vscode/media', 'node_modules', 'schema', 'src-tauri']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Type-only imports may stay separate from value imports of the same module.
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }]
    }
  },
  {
    // Type-aware rules (floating promises, unsafe any...) on the TypeScript sources.
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } }
  },
  {
    // Parsed YAML / JSON fixtures are untyped.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended]
  },
  {
    // Electron main process (ES module) and preload script (CommonJS), run by Node.
    files: ['electron/**/*.{js,cjs}'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', module: 'writable' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
)
