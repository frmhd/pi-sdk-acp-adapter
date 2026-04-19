import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";

import { createStructuredToolCallContent } from "../types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getOptionalObjectField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null | undefined {
  const value = record[field];
  return value === null ? null : isRecord(value) ? value : undefined;
}

export function getOptionalStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  return typeof record[field] === "string" ? (record[field] as string) : undefined;
}

export function getOptionalNumberField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  return typeof record[field] === "number" ? (record[field] as number) : undefined;
}

export function mapPiContentBlock(block: unknown): ContentBlock | undefined {
  if (!isRecord(block)) {
    return undefined;
  }

  if (block.type === "text" && typeof block.text === "string") {
    return {
      type: "text",
      text: block.text,
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  const mimeType =
    getOptionalStringField(block, "mimeType") ?? getOptionalStringField(block, "mime_type");

  if (block.type === "image" && typeof block.data === "string" && mimeType) {
    return {
      type: "image",
      data: block.data,
      mimeType,
      ...(getOptionalStringField(block, "uri")
        ? { uri: getOptionalStringField(block, "uri") }
        : {}),
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  if (block.type === "audio" && typeof block.data === "string" && mimeType) {
    return {
      type: "audio",
      data: block.data,
      mimeType,
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  if (
    block.type === "resource_link" &&
    typeof block.name === "string" &&
    typeof block.uri === "string"
  ) {
    return {
      type: "resource_link",
      name: block.name,
      uri: block.uri,
      ...(getOptionalStringField(block, "title")
        ? { title: getOptionalStringField(block, "title") }
        : {}),
      ...(getOptionalStringField(block, "description")
        ? { description: getOptionalStringField(block, "description") }
        : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(getOptionalNumberField(block, "size") !== undefined
        ? { size: getOptionalNumberField(block, "size") }
        : {}),
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  if (block.type === "resource") {
    const resource = getOptionalObjectField(block, "resource");
    if (!resource || typeof resource.uri !== "string") {
      return undefined;
    }

    const resourceMimeType =
      getOptionalStringField(resource, "mimeType") ?? getOptionalStringField(resource, "mime_type");
    const embeddedResource =
      typeof resource.text === "string"
        ? {
            text: resource.text,
            uri: resource.uri,
            ...(resourceMimeType ? { mimeType: resourceMimeType } : {}),
            ...(getOptionalObjectField(resource, "_meta") !== undefined
              ? { _meta: getOptionalObjectField(resource, "_meta") }
              : {}),
          }
        : typeof resource.blob === "string"
          ? {
              blob: resource.blob,
              uri: resource.uri,
              ...(resourceMimeType ? { mimeType: resourceMimeType } : {}),
              ...(getOptionalObjectField(resource, "_meta") !== undefined
                ? { _meta: getOptionalObjectField(resource, "_meta") }
                : {}),
            }
          : undefined;

    if (!embeddedResource) {
      return undefined;
    }

    return {
      type: "resource",
      resource: embeddedResource,
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  return undefined;
}

export function mapPiContentBlockToAcp(block: unknown): ToolCallContent | undefined {
  const content = mapPiContentBlock(block);
  return content ? createStructuredToolCallContent(content) : undefined;
}
