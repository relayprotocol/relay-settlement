# CODE RULES

- TypeScript code should have no comments at all (except TODO, FIXME, or other temporary comments).
- Use strict, precise types and avoid `any`.
- Use modern React: function components and hooks, derive values during render instead of syncing state in effects.
- Let the React Compiler memoize. Do not add `useMemo`, `useCallback` or `memo`.
- Read server data with TanStack Query through shared `queryOptions` factories. Never fetch in `useEffect`.
- Style with Tailwind utilities and the design tokens in `src/index.css`. Use inline styles only for dynamic values.
- Layouts must work from 300 px to wide desktop screens, in light and dark mode, without horizontal page scroll.
- Use semantic HTML. Icon-only controls need an accessible label and all controls need a visible focus state.
- Add unit tests sparingly - only focused, high-quality, high-value unit tests should ever be added.
- When extending or updating markdown documentation (e.g. README.md) include only essential information (no verbosity).
- Always make an effort to use latest library patterns, language idioms/patterns, functional style over procedural style (where appropriate).
- The target for code and documentation should always be low-entropy, simplicity, succinctness, tidiness and consistency.

# BUILD RULES

- Format and lint with `yarn lint --fix`.
- Type check and build with `yarn build`.
- Test with `yarn test` after fixing type and lint issues first.
- Check UI changes with `yarn dev` at mobile and desktop widths in both themes.
