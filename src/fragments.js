import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse, parseFragment } from "parse5";
import { scriptKind } from "./scripts.js";

const FRAGMENT_NAME = /^dominion-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) {
    walk(child, visit);
  }
  if (node.content) {
    walk(node.content, visit);
  }
}

function parseSource(source, contextTag) {
  if (!contextTag) {
    return parse(source, { sourceCodeLocationInfo: true });
  }
  const context = {
    nodeName: contextTag,
    tagName: contextTag,
    attrs: [],
    namespaceURI: "http://www.w3.org/1999/xhtml",
    childNodes: [],
  };
  return parseFragment(context, source, { sourceCodeLocationInfo: true });
}

function getLocation(node) {
  return node.sourceCodeLocation;
}

function findIncludes(tree, source) {
  const includes = [];
  walk(tree, (node) => {
    if (node.tagName?.startsWith("dominion")) {
      const location = getLocation(node);
      if (location?.startTag && location.endTag) {
        includes.push({ node, location });
      } else {
        includes.push({ node, location });
      }
    }
  });

  return includes
    .filter((include) => !includes.some((other) => (
      other !== include
      && other.location?.startOffset <= include.location?.startOffset
      && other.location?.endOffset >= include.location?.endOffset
    )))
    .map((include) => ({
      ...include,
      rawTag: include.location?.startTag
        ? source.slice(include.location.startTag.startOffset, include.location.startTag.endOffset)
        : "",
    }))
    .sort((left, right) => (left.location?.startOffset ?? 0) - (right.location?.startOffset ?? 0));
}

function insertionContext(tree, location) {
  let context;
  let contextWidth = Infinity;
  walk(tree, (node) => {
    const candidate = getLocation(node);
    if (!node.tagName || !candidate || node === tree) {
      return;
    }
    if (candidate.startOffset <= location.startOffset && candidate.endOffset >= location.endOffset) {
      const width = candidate.endOffset - candidate.startOffset;
      if (width < contextWidth) {
        context = node.tagName;
        contextWidth = width;
      }
    }
  });
  return context;
}

function applyReplacements(source, replacements) {
  let html = "";
  let cursor = 0;
  const instances = [];
  for (const replacement of replacements.sort((left, right) => left.start - right.start)) {
    html += source.slice(cursor, replacement.start);
    const offset = html.length;
    const value = typeof replacement.value === "string"
      ? { html: replacement.value, instances: [] }
      : replacement.value;
    html += value.html;
    instances.push(...value.instances.map((instance) => shiftInstance(instance, offset)));
    cursor = replacement.end;
  }
  html += source.slice(cursor);
  return { html, instances };
}

function shiftInstance(instance, offset) {
  return {
    ...instance,
    startOffset: instance.startOffset + offset,
    endOffset: instance.endOffset + offset,
    rootRanges: instance.rootRanges.map((range) => ({
      startOffset: range.startOffset + offset,
      endOffset: range.endOffset + offset,
    })),
  };
}

function mapOffset(offset, replacements) {
  return offset + replacements.reduce((shift, replacement) => {
    if (replacement.end > offset) {
      return shift;
    }
    const value = typeof replacement.value === "string" ? replacement.value : replacement.value.html;
    return shift + value.length - (replacement.end - replacement.start);
  }, 0);
}

function remapInstances(instances, replacements) {
  return instances.map((instance) => ({
    ...instance,
    startOffset: mapOffset(instance.startOffset, replacements),
    endOffset: mapOffset(instance.endOffset, replacements),
    rootRanges: instance.rootRanges.map((range) => ({
      startOffset: mapOffset(range.startOffset, replacements),
      endOffset: mapOffset(range.endOffset, replacements),
    })),
  }));
}

function describeLocation(sourcePath, node) {
  const location = getLocation(node);
  return location?.startLine
    ? `${sourcePath}:${location.startLine}:${location.startCol}`
    : sourcePath;
}

function nodeIsMeaningful(node) {
  return node.tagName !== undefined || (node.nodeName === "#text" && /\S/.test(node.value));
}

function sourceError(sourcePath, node, message, chain) {
  return new Error(`${describeLocation(sourcePath, node)}: ${message}; include chain: ${chain.join(" -> ")}`);
}

function findSlots(tree, source, sourcePath, chain) {
  const slots = [];
  const names = new Map();
  let defaultSlot;

  walk(tree, (node) => {
    if (node.tagName !== "slot") {
      return;
    }
    const location = getLocation(node);
    const attributes = new Map((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
    const name = attributes.get("name");
    if (!name) {
      throw sourceError(sourcePath, node, "slot declaration requires a non-empty name", chain);
    }
    if (!location?.startTag || !location.endTag) {
      throw sourceError(sourcePath, node, `<slot name="${name}"> must have an explicit closing tag`, chain);
    }
    for (const attribute of node.attrs ?? []) {
      if (!["name", "#default", "#required"].includes(attribute.name)) {
        throw sourceError(sourcePath, node, `unsupported slot declaration attribute: ${attribute.name}`, chain);
      }
    }
    if ([...names.values()].includes(name)) {
      throw sourceError(sourcePath, node, `duplicate slot name: ${name}`, chain);
    }
    if (attributes.has("#default")) {
      if (defaultSlot) {
        throw sourceError(sourcePath, node, "only one slot may be marked #default", chain);
      }
      defaultSlot = node;
    }
    if ((node.childNodes ?? []).some(nodeIsMeaningful)) {
      throw sourceError(sourcePath, node, "slot fallback content is not supported", chain);
    }

    names.set(node, name);
    slots.push({
      node,
      name,
      required: attributes.has("#required"),
      isDefault: attributes.has("#default"),
      location,
      context: insertionContext(tree, location),
    });
  });

  return { slots, defaultSlot: slots.find((slot) => slot.isDefault) };
}

function validateAuthoredRoot(tree, sourcePath, chain) {
  let hasBehaviorOrStyles = false;
  walk(tree, (node) => {
    if (node.tagName === "style" || (node.tagName === "script" && scriptKind(node))) {
      hasBehaviorOrStyles = true;
    }
  });
  if (!hasBehaviorOrStyles) {
    return;
  }

  const roots = (tree.childNodes ?? []).filter((node) => node.tagName && !["script", "style"].includes(node.tagName));
  if (roots.length !== 1) {
    throw sourceError(sourcePath, tree, `fragments with behavior or styles must have exactly one authored root (found ${roots.length})`, chain);
  }
}

function removeSlotAttribute(source, node, sourceOffset) {
  const location = getLocation(node)?.attrs?.slot;
  if (!location) {
    return source;
  }
  let start = location.startOffset - sourceOffset;
  const end = location.endOffset - sourceOffset;
  if (/\s/.test(source[start - 1] ?? "")) {
    start -= 1;
  }
  return `${source.slice(0, start)}${source.slice(end)}`;
}

function distributeContent(source, contextTag, slots, defaultSlot, sourcePath, definitionPath, chain) {
  const contentTree = parseSource(source, contextTag);
  const slotByName = new Map(slots.map((slot) => [slot.name, slot]));
  const distributed = new Map(slots.map((slot) => [slot.name, []]));

  for (const node of contentTree.childNodes ?? []) {
    const location = getLocation(node);
    if (!location || location.startOffset === undefined || location.endOffset === undefined) {
      continue;
    }
    let destination;
    let value = source.slice(location.startOffset, location.endOffset);
    if (node.tagName) {
      const assignment = node.attrs?.find((attribute) => attribute.name === "slot");
      if (assignment) {
        destination = slotByName.get(assignment.value);
        if (!destination) {
          throw sourceError(sourcePath, node, `unknown slot destination: ${assignment.value}`, chain);
        }
        value = removeSlotAttribute(value, node, location.startOffset);
      }
    }

    const meaningful = nodeIsMeaningful(node);
    if (!destination && defaultSlot) {
      destination = defaultSlot;
    }
    if (destination) {
      distributed.get(destination.name).push({ value, meaningful, node });
    } else if (meaningful) {
      throw sourceError(sourcePath, node, "meaningful supplied content has no matching slot or #default", chain);
    }
  }

  for (const slot of slots) {
    const supplied = distributed.get(slot.name);
    if (slot.required && !supplied.some((item) => item.meaningful)) {
      throw sourceError(definitionPath, slot.node, `required slot is missing content: ${slot.name}`, chain);
    }
  }

  return distributed;
}

async function expandInstance(source, supplied, sourcePath, contextTag, name, state) {
  const id = `fragment-${state.ids.next++}`;
  const tree = parseSource(source, contextTag);
  validateAuthoredRoot(tree, sourcePath, state.chain);
  const { slots, defaultSlot } = findSlots(tree, source, sourcePath, state.chain);
  const expandedTemplate = await expandSource(source, sourcePath, contextTag, {
    ...state,
    parentInstanceId: id,
  });
  const expandedSlots = slots.map((slot) => ({
    ...slot,
    location: {
      ...slot.location,
      startOffset: mapOffset(slot.location.startOffset, expandedTemplate.replacements),
      endOffset: mapOffset(slot.location.endOffset, expandedTemplate.replacements),
    },
  }));
  const assignments = distributeContent(supplied, contextTag, slots, defaultSlot, state.callerPath, sourcePath, state.chain);
  const replacements = [];

  for (const slot of expandedSlots) {
    let value = "";
    const instances = [];
    for (const item of assignments.get(slot.name)) {
      const expandedContent = await expandSource(item.value, state.callerPath, slot.context, {
        ...state,
        parentInstanceId: id,
      });
      instances.push(...expandedContent.instances.map((instance) => shiftInstance(instance, value.length)));
      value += expandedContent.html;
    }
    replacements.push({
      start: slot.location.startOffset,
      end: slot.location.endOffset,
      value: { html: value, instances },
    });
  }

  const distributed = applyReplacements(expandedTemplate.html, replacements);
  const childInstances = [
    ...remapInstances(expandedTemplate.instances, replacements),
    ...distributed.instances,
  ].sort((left, right) => left.startOffset - right.startOffset);
  const finalTree = parseSource(distributed.html, contextTag);
  const rootRanges = (finalTree.childNodes ?? [])
    .filter((node) => node.tagName && getLocation(node))
    .map((node) => ({
      startOffset: getLocation(node).startOffset,
      endOffset: getLocation(node).endOffset,
    }))
    .filter((range) => !childInstances.some((instance) => (
      instance.startOffset === range.startOffset && instance.endOffset === range.endOffset
    )));
  const instance = {
    id,
    name,
    sourcePath,
    includeChain: [...state.chain],
    parentInstanceId: state.parentInstanceId ?? null,
    startOffset: 0,
    endOffset: distributed.html.length,
    rootRanges,
  };
  return { html: distributed.html, instances: [instance, ...childInstances] };
}

async function expandSource(source, sourcePath, contextTag, state) {
  if (!/<\/?dominion/i.test(source)) {
    return { html: source, instances: [], replacements: [] };
  }

  const tree = parseSource(source, contextTag);
  const includes = findIncludes(tree, source);
  if (includes.length === 0) {
    return { html: source, instances: [], replacements: [] };
  }

  const replacements = [];
  for (const include of includes) {
    const { node, location, rawTag } = include;
    const sourceLocation = describeLocation(sourcePath, node);
    const match = rawTag.match(/^<(dominion-[^\s/>]+)([^>]*)>$/);
    const fragmentName = match?.[1];
    const nameMatch = fragmentName?.match(FRAGMENT_NAME);
    if (!nameMatch) {
      throw new Error(`${sourceLocation}: invalid shared fragment name in ${rawTag || node.tagName}; include chain: ${state.chain.join(" -> ")}`);
    }
    if (node.attrs?.length || match[2].trim()) {
      throw new Error(`${sourceLocation}: <${fragmentName}> inclusion placeholders cannot have attributes; include chain: ${state.chain.join(" -> ")}`);
    }
    if (!location?.startTag || !location.endTag) {
      throw new Error(`${sourceLocation}: <${fragmentName}> must have an explicit closing tag; include chain: ${state.chain.join(" -> ")}`);
    }

    const name = nameMatch[1];
    const fragmentPath = path.join(state.rootDir, "shared", `${name}.html`);
    const fragmentSourcePath = `shared/${name}.html`;
    const nextChain = [...state.chain, fragmentSourcePath];
    if (state.fragmentStack.includes(name)) {
      throw new Error(`${sourceLocation}: circular shared fragment inclusion; include chain: ${nextChain.join(" -> ")}`);
    }

    let fragmentSource;
    try {
      fragmentSource = await readFile(fragmentPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      throw new Error(`${sourceLocation}: shared fragment not found: ${fragmentSourcePath}; include chain: ${nextChain.join(" -> ")}`);
    }

    const content = source.slice(location.startTag.endOffset, location.endTag.startOffset);
    const context = insertionContext(tree, location);
    const value = await expandInstance(fragmentSource, content, fragmentSourcePath, context, name, {
      ...state,
      chain: nextChain,
      fragmentStack: [...state.fragmentStack, name],
      callerPath: sourcePath,
    });
    replacements.push({
      start: location.startOffset,
      end: location.endOffset,
      value,
    });
  }

  return { ...applyReplacements(source, replacements), replacements };
}

function buildScopeRanges(instances) {
  return instances.map((instance) => {
    const children = instances
      .filter((candidate) => candidate.parentInstanceId === instance.id)
      .sort((left, right) => left.startOffset - right.startOffset);
    const scopeRanges = [];
    let cursor = instance.startOffset;
    for (const child of children) {
      if (child.startOffset > cursor) {
        scopeRanges.push({ start: cursor, end: child.startOffset });
      }
      cursor = Math.max(cursor, child.endOffset);
    }
    if (cursor < instance.endOffset) {
      scopeRanges.push({ start: cursor, end: instance.endOffset });
    }
    return { ...instance, scopeRanges };
  });
}

export async function expandSharedFragments(html, rootDir, context) {
  const result = await expandSource(html, context.sourcePath, undefined, {
    rootDir,
    chain: [context.sourcePath],
    fragmentStack: [],
    ids: { next: 1 },
    callerPath: context.sourcePath,
    parentInstanceId: null,
  });
  context.fragmentInstances = buildScopeRanges(result.instances);
  return result.html;
}