import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist-cli', 'examples/generated', 'node_modules', 'schema']
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
    files: ['**/*.ts'],
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
  }
)
