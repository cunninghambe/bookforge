import { splitParagraphs } from "./paragraphs";
import { cacheKey } from "./cache";

// The audio manifest for a chapter: the paragraph count, the serving format, and
// per-paragraph cache state. The player reads it to render the position display
// and to know which paragraphs are already synthesized. The shape is built by a
// pure function so it can be unit-tested without touching the filesystem; the route
// supplies the real cache-state probe.

export interface ManifestParagraph {
  index: number;
  chars: number;
  cached: boolean;
}

export interface AudioManifest {
  chapterId: number;
  paragraphCount: number;
  format: string;
  paragraphs: ManifestParagraph[];
}

// Pure: assemble the manifest from a draft's content. `probeCached(key)` reports
// whether a paragraph's audio is already on disk; passing () => false yields the
// pristine (nothing cached) shape.
export function buildManifest(args: {
  chapterId: number;
  content: string;
  voiceId: string;
  format: string;
  ext: string;
  probeCached: (key: string, ext: string) => boolean;
}): AudioManifest {
  const paragraphs = splitParagraphs(args.content);
  return {
    chapterId: args.chapterId,
    paragraphCount: paragraphs.length,
    format: args.format,
    paragraphs: paragraphs.map((text, index) => ({
      index,
      chars: text.length,
      cached: args.probeCached(cacheKey(text, args.voiceId), args.ext),
    })),
  };
}
