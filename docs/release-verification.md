# Release Verification

## Reproducible checks

Reproduce the local release checks with:

```sh
npm ci
npx playwright install chromium
npm test
npm run build
npm run build:pages
```

Hosted CI runs `npm ci`, installs Chromium with its Linux dependencies, runs `npm test`, and builds the project-prefixed output with `npm run build:pages`. The commands above also build the root-path output locally. `npm test` covers routing and assets, scaffolding, fragment composition and slot contracts, Tailwind state generation and scoped CSS, script scheduling and idle fallback, rebuild behavior, static-page runtime absence, and source-aware diagnostics for invalid includes/directives/slots and output collisions. The docs output check rejects unexpanded fragments, slots, directives, or template placeholders and limits published files to the authored pages and public asset. The release-browser pass checks root and project-prefix routes in desktop and mobile Chromium, rendered named/default slot content, keyboard/focus behavior, code layout, assets, console/network failures, nested accent inheritance, and each rendered example state. It writes screenshots to `test-results/release-verification/`; CI uploads any screenshots produced after the test step, including on failure, with 14-day retention.

## Navigation measurements

One local headless run on 2026-11-10 with Playwright Chromium 158.0.8127.18 measured navigation to the documentation home page. Cold is the first home-page navigation in a fresh browser context; repeat is a later home-page navigation in that same context after the route and example checks. Timings are wall-clock milliseconds through the page `load` event.

| Build path | Viewport | Cold | Repeat |
| --- | --- | ---: | ---: |
| `/` | 1440x1000 desktop | 22.23 ms | 14.03 ms |
| `/` | 390x844 mobile | 11.84 ms | 13.57 ms |
| `/DOMinion/` | 1440x1000 desktop | 11.76 ms | 14.10 ms |
| `/DOMinion/` | 390x844 mobile | 12.27 ms | 13.65 ms |

Conditions: localhost HTTP, default Chromium cache enabled, no network throttling, page load event, fresh context for each cold navigation, and the same context/cache reused for the later navigation. These are representative local observations, not a performance guarantee or a deployed-host measurement. The timing test also reports browser `PerformanceNavigationTiming` duration and transfer size.

Dynamic-data wait: not applicable to this documentation site. It makes no API requests; the example state button changes local UI state synchronously and is not counted as data latency.

## Publication status

The Pages workflow verifies the site, builds with `/DOMinion/`, uploads only `dist/`, and deploys with the Pages artifact actions. Node.js, a runtime framework, and the development watcher are not part of the published artifact; the generated site is static HTML/assets with page-specific CSS and authored browser behavior where required.

GitHub Pages is configured for workflow deployment at <https://hamiescripts.github.io/DOMinion/>. No deployment from this integration branch has been verified yet: the Pages workflow is introduced here and will run when the branch is merged to `main`. After that run succeeds, verify the deployed navigation and assets at the project URL before claiming publication complete.