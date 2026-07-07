// Pulls the [MISSING FACT] and [CANON TENSION] lines out of a draft, returning the
// clean prose (markers stripped) plus the extracted statements for the UI to
// surface as alerts above the editor.

export interface ExtractedMarkers {
  clean: string;
  missingFacts: string[];
  canonTensions: string[];
}

export function extractMarkers(text: string): ExtractedMarkers {
  const missingFacts: string[] = [];
  const canonTensions: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const miss = line.match(/^\s*\[MISSING FACT\]:\s*(.*)$/i);
    const tension = line.match(/^\s*\[CANON TENSION\]:\s*(.*)$/i);
    if (miss) {
      if (miss[1].trim()) missingFacts.push(miss[1].trim());
    } else if (tension) {
      if (tension[1].trim()) canonTensions.push(tension[1].trim());
    } else {
      kept.push(line);
    }
  }
  return { clean: kept.join("\n").trim(), missingFacts, canonTensions };
}

// Delimiter separating streamed prose from the trailing JSON control frame. A
// distinctive printable sentinel that will never occur in generated prose, so the
// client can split the stream unambiguously.
export const CONTROL_DELIM = "\n<<<BOOKFORGE_CTRL>>>\n";
