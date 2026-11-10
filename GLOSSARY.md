# DOMinion

DOMinion concerns the creation of HTML-first websites for static hosting.

## Language

**DOMinion**:
A build-time system that produces deployable, HTML-first websites without requiring a runtime framework. Native browser capabilities are the baseline; build-time tools and application-specific JavaScript are permitted.
_Avoid_: Client-side framework, JavaScript-free website generator

**Shared fragment**:
A reusable piece of HTML source that a page or another shared fragment can include. It is not a standalone published page or a runtime component.
_Avoid_: Runtime component, partial page

**Fragment instance**:
A particular occurrence of a shared fragment within a page. Each occurrence has its own initialization when the fragment contains behavior, even when the same fragment appears elsewhere on the page.
_Avoid_: Fragment definition, runtime component

**Fragment scope**:
The region of a page belonging to a fragment instance, including its root but excluding nested fragment roots and their contents. It bounds the fragment's custom style selectors, not normal CSS inheritance.
_Avoid_: Style sandbox, Shadow DOM boundary

**Content slot**:
A named insertion point in a shared fragment for HTML supplied by its including page or fragment. It is filled during the build, not by a browser-side component system.
_Avoid_: Fragment property, Shadow DOM slot

**Default slot**:
A content slot explicitly designated to receive supplied content that does not name a destination.
_Avoid_: Fallback content

**Required slot**:
A content slot whose caller must supply at least one element or non-whitespace text node; comments and formatting whitespace do not satisfy it. This is a structural requirement, not a guarantee of visible content or runtime data.
_Avoid_: Required property, Runtime validation