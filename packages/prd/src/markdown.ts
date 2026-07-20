import type { Nodes, Root } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import type { MarkdownAstNode, MarkdownContent } from "./contracts"

function childrenOf(node: Nodes): readonly Nodes[] {
  if ("children" in node && Array.isArray(node.children)) return node.children
  return []
}

function textOfNode(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
    case "html":
      return node.value
    case "image":
      return node.alt ?? ""
    case "break":
      return "\n"
    case "paragraph":
    case "heading":
    case "blockquote":
    case "listItem":
      return childrenOf(node).map(textOfNode).join("").trim()
    case "list":
    case "root":
      return childrenOf(node).map(textOfNode).filter(Boolean).join("\n")
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
      return childrenOf(node).map(textOfNode).join("")
    case "thematicBreak":
    case "yaml":
    case "definition":
    case "footnoteDefinition":
    case "footnoteReference":
    case "imageReference":
    case "linkReference":
      return ""
  }
  return ""
}

function sanitizeNode(node: Nodes): MarkdownAstNode | undefined {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
    case "html":
      return {
        type: node.type,
        value: node.value,
        ...(node.type === "code" && node.lang !== undefined ? { lang: node.lang } : {}),
      }
    case "break":
      return { type: "break" }
    case "image":
      return {
        type: "image",
        url: node.url,
        ...(node.title !== undefined ? { title: node.title } : {}),
        ...(node.alt !== undefined ? { alt: node.alt } : {}),
      }
    case "paragraph":
    case "blockquote":
    case "emphasis":
    case "strong":
    case "delete":
      return {
        type: node.type,
        children: childrenOf(node).flatMap((child) => {
          const sanitized = sanitizeNode(child)
          return sanitized ? [sanitized] : []
        }),
      }
    case "link":
      return {
        type: "link",
        url: node.url,
        ...(node.title !== undefined ? { title: node.title } : {}),
        children: node.children.flatMap((child) => {
          const sanitized = sanitizeNode(child)
          return sanitized ? [sanitized] : []
        }),
      }
    case "list":
      return {
        type: "list",
        ...(node.ordered !== null ? { ordered: node.ordered } : {}),
        ...(node.start !== undefined ? { start: node.start } : {}),
        children: node.children.flatMap((child) => {
          const sanitized = sanitizeNode(child)
          return sanitized ? [sanitized] : []
        }),
      }
    case "listItem":
      return {
        type: "listItem",
        ...(node.checked !== undefined ? { checked: node.checked } : {}),
        children: node.children.flatMap((child) => {
          const sanitized = sanitizeNode(child)
          return sanitized ? [sanitized] : []
        }),
      }
    case "root":
      return undefined
    case "heading": {
      const text = textOfNode(node)
      return text ? { type: "text", value: text } : undefined
    }
    case "thematicBreak":
    case "yaml":
    case "definition":
    case "footnoteDefinition":
    case "footnoteReference":
    case "imageReference":
    case "linkReference":
      return undefined
  }
  return undefined
}

function normalizeText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

export function parseMarkdownFragment(markdown: string): MarkdownContent {
  const tree: Root = fromMarkdown(markdown)
  return {
    markdown,
    text: normalizeText(textOfNode(tree)),
    ast: tree.children.flatMap((node) => {
      const sanitized = sanitizeNode(node)
      return sanitized ? [sanitized] : []
    }),
  }
}

export function markdownNodeText(node: Nodes): string {
  return normalizeText(textOfNode(node))
}

export function markdownTreeText(tree: Root): string {
  return normalizeText(textOfNode(tree))
}

export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown)
}
