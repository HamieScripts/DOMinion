export function walkTree(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) {
    walkTree(child, visit);
  }
  if (node.content) {
    walkTree(node.content, visit);
  }
}