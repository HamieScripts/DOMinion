# Styling

Tailwind v4 utilities are the default styling model. Add project tokens in the root `tailwind.css` file, for example:

```css
@theme {
  --color-brand: #123456;
}
```

`dominion build` expands each page and its fragments, then invokes the Tailwind CLI with source detection disabled by default and explicitly enabled for that generated page only. Each output page receives minified CSS in one `<style>` element in its document head. Utility classes in templates are detected at build time, including classes for inactive states; runtime-generated class names are not.

Fragment-authored `<style>` blocks are an escape hatch. They are emitted only for used fragments, inside native `@scope` rules rooted at each fragment's authored root. DOMinion adds `data-dominion-scope` attributes to those roots so scopes remain explicit after the CSS moves into the head. Descendant fragment roots become exclusive scope limits; supplied slot content remains in its receiving fragment's scope. CSS inheritance and custom properties continue through those limits.

Tailwind's `theme` and `base` layers precede fragment escape-hatch rules in the `components` layer, which precedes Tailwind's `utilities` layer. Therefore a utility wins over a fragment rule when both set the same property. Page-authored style blocks, if present, remain global and unlayered, so they take precedence over layered Tailwind and fragment rules.

Fragment styles may use `@media`, `@supports`, `@container`, and `@starting-style`. Other at-rules are rejected because constructs such as `@font-face`, `@keyframes`, and `@import` have global effects that `@scope` cannot contain. URLs in inlined CSS resolve relative to the generated page, not the fragment source file.

Native `@scope` is required; DOMinion does not add a runtime or legacy-browser fallback. As of November 2026, the documented minimum stable versions are Chrome/Edge 118, Firefox 146, and Safari 26.4 (including their corresponding mobile engines). See [MDN's `@scope` compatibility table](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@scope#browser_compatibility) for updates.