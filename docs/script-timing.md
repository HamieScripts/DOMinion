# Fragment Scripts

Fragment scripts run independently for each fragment instance. Every executable script block has a local `root` variable for that instance's authored root; nested fragment roots belong to their own scripts. A fragment containing executable scripts must have exactly one authored root.

## Supported Forms

DOMinion compiles inline classic scripts and inline module scripts inside fragments. Classic scripts are those without a `type`, with an empty type, or with a JavaScript MIME type. `type="module"` keeps native module execution, module scope, `import.meta`, and import behavior; DOMinion only adds a local `root` binding before the authored module source. External fragment scripts using `src` are rejected because DOMinion cannot bind their source to an instance without changing how the script is loaded.

Non-executable script data blocks, including `type="application/json"`, are preserved as authored and do not require a fragment root. Timing directives are valid only on executable scripts. Unknown hash directives and multiple timing directives are build errors. Native `async` or `defer` attributes are not accepted on inline classic fragment scripts; use a DOMinion timing directive instead. Module scripts may use `#defer` or no directive, but `#immediate` and `#idle` are rejected because they would change native module semantics. Module `async` conflicts with `#defer`.

## Timing And Order

- No directive and `#defer` run classic code after parsing, when `DOMContentLoaded` fires. All default/deferred classic blocks run in document source order, including across fragment instances.
- `#immediate` runs synchronously when the parser encounters that script. Only markup already parsed can be queried; later siblings are not available yet.
- `#idle` becomes eligible after parsing. DOMinion uses `requestIdleCallback` when available and `setTimeout(callback, 0)` otherwise. Idle work is not ordered relative to deferred blocks, and neither policy delays transfer of inline bytes or makes long-running code nonblocking.
- Module scripts retain the browser's native module scheduling and ordering. They execute with module semantics before `DOMContentLoaded`; their ordering relative to classic scripts therefore follows native module scheduling, not a DOMinion cross-type ordering guarantee.

Each classic script block has its own private function scope. Its `var`, `let`, `const`, and function declarations are not visible to other blocks, even in the same fragment instance. Module blocks retain their normal per-module scope; bindings are not shared across module elements. Share state through the fragment DOM via `root`, or through an explicitly chosen browser API. DOMinion does not publish instance functions or create a global callback registry. Directives are removed from generated HTML.