import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ImageContent as PiImageContent } from "@mariozechner/pi-ai";

export interface ExtractedContent {
  text: string;
  images: PiImageContent[];
}

export function extractContentFromBlocks(blocks: ContentBlock[]): ExtractedContent {
  const textParts: string[] = [];
  const images: PiImageContent[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "image") {
      images.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
    } else if (block.type === "resource_link") {
      const resourceBlock = block as { uri?: string; text?: string };
      if (resourceBlock.text) {
        textParts.push(resourceBlock.text);
      } else if (resourceBlock.uri) {
        textParts.push(`[Resource: ${resourceBlock.uri}]`);
      }
    }
  }

  return {
    text: textParts.join("\n\n"),
    images,
  };
}
