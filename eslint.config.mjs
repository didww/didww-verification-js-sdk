import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      '**/coverage/**',
      '**/android/build/**',
      '**/.gradle/**',
      // `expo prebuild` output: generated native projects, not ours to lint.
      'examples/expo-app/android/**',
      'examples/expo-app/ios/**',
      '**/.expo/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // A computed specifier is the one hole in check-no-node-builtins: esbuild cannot
      // resolve it, so a `node:` builtin could reach the React Native bundle unseen.
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression[source.type!='Literal']",
          message: 'Import specifiers must be string literals.',
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.type!='Literal']",
          message: 'Require specifiers must be string literals.',
        },
      ],
    },
  },
  {
    // `react-native` is a peer dependency, so npm installs it and `tsc` resolves its types --
    // but vitest cannot parse its Flow-typed source, and a type-only import is erased before
    // vitest would ever notice, so lint is the only gate that sees either form.
    files: ['packages/verification-react-native/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              message:
                'No source file in this package may import react-native; the SMS gate reads the native module instead.',
            },
          ],
          patterns: ['react-native/*'],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Repository tooling runs on Node. Declared by hand rather than pulling in
    // `globals`; extend the list when a script needs another one.
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
