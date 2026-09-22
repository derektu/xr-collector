# App Shell extension points

The App Shell owns the four stable top-level routes and the shared presentation surface. It does not own collection, document, Vault, job, search, or activity behaviour. Those tickets attach a page component or source capability without changing navigation.

## Add a source

1. Add a `SourceDefinition` to `sourceRegistry` in `src/web/app-shell.ts`. The registry provides the source to the Sources page.
2. Use `availability: 'planned'` until the source has a delivered capability. The page labels planned sources as unavailable and provides no successful-looking action.
3. Register test fixtures with `availability: 'test-only'`. They remain available to direct registry tests but are excluded from `publicSources()` and the product UI.
4. Put the actual source operation behind the existing shared HTTP API. The Shell is deliberately not an Electron IPC business boundary.

## Add a page

`src/web/App.tsx` maps a `ShellPage` to its path, navigation label, title and page component. A new top-level page changes those mappings together. Each page heading receives focus after route changes so keyboard navigation has a stable destination.

## Theme persistence

The shared `ThemeStore` interface in `src/web/app-shell.ts` keeps page rendering independent from its persistence location.

- Browser mode uses `localStorage` key `xr-collector.theme` on the current origin.
- Electron mode exposes only `read()` and `write('dark' | 'light')` through its preload bridge. Electron main stores `{ "theme": "dark" | "light" }` in `appearance.json` under the Electron device profile. It contains no Vault path, document data, Agent token or credential.

The Electron bridge is desktop integration for appearance only. Business screens continue to call the local HTTP API. The UI waits for Electron's stored value before enabling theme controls, so first render never writes the default over a saved value. A read of an invalid value falls back to dark; a write failure remains visible, reports that it was not saved, and offers retry.
