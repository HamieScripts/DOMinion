import { parse } from "parse5";

const SCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

const TIMING_DIRECTIVES = new Set(["#defer", "#immediate", "#idle"]);
const ROOT_ATTRIBUTE = "data-dominion-root";

export function scriptKind(node) {
  const attributes = new Map((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
  const type = (attributes.get("type") ?? "").trim().toLowerCase();
  if (type === "module") {
    return "module";
  }
  if (!type || SCRIPT_MIME_TYPES.has(type.split(";", 1)[0].trim())) {
    return "classic";
  }
  return null;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) {
    walk(child, visit);
  }
  if (node.content) {
    walk(node.content, visit);
  }
}

function sourceError(instance, node, message) {
  const location = node.sourceCodeLocation;
  const sourceLocation = location?.startLine
    ? `${instance.sourcePath}:${location.startLine}:${location.startCol}`
    : instance.sourcePath;
  return new Error(`${sourceLocation}: ${message}; include chain: ${instance.includeChain.join(" -> ")}`);
}

function ownedInstance(instances, offset) {
  return instances.find((instance) => instance.scopeRanges.some((range) => (
    range.start <= offset && offset < range.end
  )));
}

function findAuthoredRoots(tree, instance) {
  const rootOffsets = new Set(instance.rootRanges.map((range) => range.startOffset));
  const roots = [];
  walk(tree, (node) => {
    if (node.tagName
      && !["script", "style"].includes(node.tagName)
      && rootOffsets.has(node.sourceCodeLocation?.startOffset)) {
      roots.push(node);
    }
  });
  return roots;
}

function replaceSource(source, edits) {
  let result = "";
  let cursor = 0;
  for (const edit of edits.sort((left, right) => left.start - right.start)) {
    result += source.slice(cursor, edit.start);
    result += edit.value;
    cursor = edit.end;
  }
  return result + source.slice(cursor);
}

function remapOffset(offset, edits) {
  return offset + edits.reduce((shift, edit) => (
    edit.end <= offset ? shift + edit.value.length - (edit.end - edit.start) : shift
  ), 0);
}

function remapInstances(instances, edits) {
  return instances.map((instance) => ({
    ...instance,
    startOffset: remapOffset(instance.startOffset, edits),
    endOffset: remapOffset(instance.endOffset, edits),
    rootRanges: instance.rootRanges.map((range) => ({
      startOffset: remapOffset(range.startOffset, edits),
      endOffset: remapOffset(range.endOffset, edits),
    })),
    scopeRanges: instance.scopeRanges.map((range) => ({
      start: remapOffset(range.start, edits),
      end: remapOffset(range.end, edits),
    })),
  }));
}

function removeDirectiveAttributes(startTag, node, directives) {
  const locations = node.sourceCodeLocation.attrs ?? {};
  const removals = directives.map((directive) => {
    const location = locations[directive];
    let start = location.startOffset - node.sourceCodeLocation.startTag.startOffset;
    const end = location.endOffset - node.sourceCodeLocation.startTag.startOffset;
    if (/\s/.test(startTag[start - 1] ?? "")) {
      start -= 1;
    }
    return { start, end };
  }).sort((left, right) => right.start - left.start);

  let output = startTag;
  for (const removal of removals) {
    output = `${output.slice(0, removal.start)}${output.slice(removal.end)}`;
  }
  return output;
}

function rootSelector(instance) {
  return `[${ROOT_ATTRIBUTE}="${instance.id}"]`;
}

function classicScript(node, html, timing, selector) {
  const location = node.sourceCodeLocation;
  const body = html.slice(location.startTag.endOffset, location.endTag.startOffset);
  const invoke = `const invoke=()=>{const root=document.querySelector(${JSON.stringify(selector)});const run=function(){\n${body}\n};return run.call(window)};`;
  let schedule;
  if (timing === "immediate") {
    schedule = "invoke();";
  } else if (timing === "idle") {
    schedule = "const afterParsing=callback=>{if(document.readyState===\"loading\"){document.addEventListener(\"DOMContentLoaded\",callback,{once:true})}else{callback()}};afterParsing(()=>{if(typeof window.requestIdleCallback===\"function\"){window.requestIdleCallback(invoke)}else{window.setTimeout(invoke,0)}});";
  } else {
    schedule = "if(document.readyState===\"loading\"){document.addEventListener(\"DOMContentLoaded\",invoke,{once:true})}else{invoke()};";
  }

  return `(()=>{${invoke}${schedule}})()`;
}

function moduleScript(instance, node, html, directives, selector) {
  const attributes = new Map((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
  const nativeTiming = attributes.has("async");
  if (directives.includes("#immediate") || directives.includes("#idle")) {
    throw sourceError(instance, node, "module scripts cannot use #immediate or #idle without changing native module execution semantics; use #defer or omit a timing directive");
  }
  if (nativeTiming && directives.includes("#defer")) {
    throw sourceError(instance, node, "#defer conflicts with the native async attribute on a module script; remove async or #defer");
  }

  const location = node.sourceCodeLocation;
  const body = html.slice(location.startTag.endOffset, location.endTag.startOffset);
  return `const root=document.querySelector(${JSON.stringify(selector)});\n${body}`;
}

function parseTiming(instance, node) {
  const directives = (node.attrs ?? [])
    .map((attribute) => attribute.name)
    .filter((name) => name.startsWith("#"));
  const unknown = directives.filter((directive) => !TIMING_DIRECTIVES.has(directive));
  if (unknown.length > 0) {
    throw sourceError(instance, node, `unknown script timing directive ${unknown.join(", ")}; use #immediate, #defer, or #idle`);
  }
  if (directives.length > 1) {
    throw sourceError(instance, node, `multiple script timing directives are not allowed: ${directives.join(", ")}; choose one of #immediate, #defer, or #idle`);
  }
  return directives;
}

export function emitFragmentScripts(html, context) {
  const instances = context.fragmentInstances ?? [];
  if (instances.length === 0) {
    return html;
  }

  const tree = parse(html, { sourceCodeLocationInfo: true });
  const scripts = [];
  walk(tree, (node) => {
    if (node.tagName !== "script") {
      return;
    }
    const instance = ownedInstance(instances, node.sourceCodeLocation.startOffset);
    if (!instance) {
      return;
    }
    const kind = scriptKind(node);
    const directives = (node.attrs ?? []).map((attribute) => attribute.name).filter((name) => name.startsWith("#"));
    if (!kind) {
      if (directives.length > 0) {
        parseTiming(instance, node);
        throw sourceError(instance, node, "script timing directives apply only to executable classic or module scripts; data blocks such as application/json are left unchanged");
      }
      return;
    }
    if (!node.sourceCodeLocation?.startTag || !node.sourceCodeLocation?.endTag) {
      throw sourceError(instance, node, "fragment scripts must have explicit opening and closing tags");
    }
    scripts.push({ instance, node });
  });
  if (scripts.length === 0) {
    return html;
  }

  const roots = new Set();
  const edits = [];
  for (const { instance, node } of scripts) {
    const kind = scriptKind(node);
    const directives = parseTiming(instance, node);
    const attributes = new Map((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
    if (attributes.has("src")) {
      throw sourceError(instance, node, "external fragment scripts are not supported; use an inline classic or module script to preserve instance-local root binding");
    }
    if (kind === "classic" && (attributes.has("async") || attributes.has("defer"))) {
      throw sourceError(instance, node, "native async/defer attributes do not schedule inline classic scripts; use #immediate, #defer, or #idle");
    }

    const selector = rootSelector(instance);
    let generatedBody;
    if (kind === "module") {
      generatedBody = moduleScript(instance, node, html, directives, selector);
    } else {
      const timing = directives[0]?.slice(1) ?? "defer";
      generatedBody = classicScript(node, html, timing, selector);
    }
    const location = node.sourceCodeLocation;
    const startTag = html.slice(location.startTag.startOffset, location.startTag.endOffset);
    const cleanStartTag = removeDirectiveAttributes(startTag, node, (node.attrs ?? [])
      .filter((attribute) => attribute.name.startsWith("#"))
      .map((attribute) => attribute.name));
    roots.add(instance);
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      value: `${cleanStartTag}${generatedBody}</script>`,
    });
  }

  for (const instance of roots) {
    const authoredRoots = findAuthoredRoots(tree, instance);
    if (authoredRoots.length !== 1) {
      throw new Error(`${instance.sourcePath}: scripts require exactly one authored root; include chain: ${instance.includeChain.join(" -> ")}`);
    }
    const [root] = authoredRoots;
    if (!root?.sourceCodeLocation?.startTag) {
      throw new Error(`${instance.sourcePath}: unable to locate the authored root for fragment script binding; include chain: ${instance.includeChain.join(" -> ")}`);
    }
    let markerCollision;
    walk(tree, (node) => {
      if (node.attrs?.some((attribute) => attribute.name === ROOT_ATTRIBUTE && attribute.value === instance.id)) {
        markerCollision = node;
      }
    });
    if (markerCollision) {
      throw sourceError(instance, markerCollision, `the authored DOM uses reserved ${ROOT_ATTRIBUTE} value "${instance.id}"; remove it so DOMinion can bind fragment scripts`);
    }
    const location = root.sourceCodeLocation.startTag;
    const startTag = html.slice(location.startOffset, location.endOffset);
    const closing = startTag.lastIndexOf(">");
    const insertion = startTag[closing - 1] === "/" ? closing - 1 : closing;
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      value: `${startTag.slice(0, insertion)} ${ROOT_ATTRIBUTE}="${instance.id}"${startTag.slice(insertion)}`,
    });
  }
  const output = replaceSource(html, edits);
  context.fragmentInstances = remapInstances(instances, edits);
  return output;
}