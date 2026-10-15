# App Shell extension points

The App Shell owns the four top-level pages (來源, 文件, 活動, 設定), the sidebar with the 加入內容 button and the background status, and the shared presentation surface. It does not own collection, document, Vault, job, search, or activity behaviour. Those tickets attach a page component or a source type without changing navigation.

## Add a source type

A source type is declared on the server, so the UI and Agents read the same description and use the same URL recognition.

1. Add a `SourceTypeDeclaration` to `SOURCE_TYPES` in `src/sources/source-types.ts`. Its public part (`id`, `label`, `icon`, `kinds`, `requiresLogin`, `settings`) is served by `GET /api/source-types`; the UI builds the type chips, row icons, type labels and recognition card titles from it.
2. Implement `owns(input, url)` and `recognize(input, context)`. `recognize` returns a `UrlRecognition` whose `actions` carry the HTTP `request` to perform. The Add Content dialog and Agents replay that request as given, so a new type needs no UI branch for its URL kinds.
3. A type with `requiresLogin: true` is answered with `status: 'login_required'` before `recognize` runs.
4. Put the actual collection behind the shared HTTP API. `SourceCatalog` (`src/sources/source-catalog.ts`) serves `GET /api/sources` and `GET /api/sources/:type/:id` from the YouTube channel subscriptions; a type with subscriptions of its own adds them there. The Shell is deliberately not an Electron IPC business boundary.
5. Give the type an icon in `src/web/icons.tsx` under the declared `icon` key.

## Add a page

`src/web/app-shell.ts` maps each `ShellPage` to its path, and `src/web/App.tsx` maps it to its navigation label, icon and page component. A new top-level page changes those mappings together. Detail pages (`/sources/<type>/<id>`, `/documents/<id>`) belong to their list page in the navigation. Each page heading receives focus after route changes so keyboard navigation has a stable destination.

## Theme persistence

The theme control is the 外觀 section of the Settings page: a radio group 主題 with 跟隨系統, 深色 and 淺色. The stored preference is `system`, `dark` or `light`; `system` follows the operating system's light or dark appearance through the `prefers-color-scheme` media query and switches as soon as the system appearance changes. Electron's `prefers-color-scheme` follows the system through `nativeTheme`, so Browser and Electron share one renderer path and Electron main does not set `nativeTheme.themeSource`. The shared `ThemeStore` interface in `src/web/app-shell.ts` keeps page rendering independent from its persistence location.

- Browser mode uses `localStorage` key `xr-collector.theme` on the current origin.
- Electron mode exposes only `read()` and `write('system' | 'dark' | 'light')` through its preload bridge. Electron main stores `{ "theme": "system" | "dark" | "light" }` in `appearance.json` under the Electron device profile and completes writes one at a time. It contains no Vault path, document data, Agent token or credential.

The Electron bridge is desktop integration for appearance only. Business screens continue to call the local HTTP API. The UI waits for Electron's stored value before showing the app, so first render never writes the default over a saved value; a value is written only when the user picks one. A missing or invalid value follows the system. A failed write is logged; the chosen theme stays applied for the running session.

The radio group follows the WAI-ARIA radio pattern: the chosen option is the group's only Tab stop, arrow keys move to the previous or next option with wrap-around, Home and End jump to the ends, and focus and selection move together. The options stay enabled while a write is in progress, so keyboard focus remains on the chosen option.
