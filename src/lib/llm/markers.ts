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

// Pulls the trailing [CONSISTENCY FIXES] block out of a revision output. The block
// is the marker line followed by one entry per line (each a declared out-of-span
// change with its justification). Everything from the marker to the end of the text
// is stripped from the prose; each entry is returned with any leading list bullet
// removed. Entries before the marker are ignored (the block lives at the very end).
export interface ExtractedFixes {
  clean: string;
  fixes: string[];
}

export function extractConsistencyFixes(text: string): ExtractedFixes {
  const lines = text.split("\n");
  let markerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[CONSISTENCY FIXES\]:/i.test(lines[i])) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx === -1) return { clean: text.trim(), fixes: [] };

  const fixes: string[] = [];
  // Any inline text after the marker on its own line counts as a first entry.
  const firstLine = lines[markerIdx].replace(/^\s*\[CONSISTENCY FIXES\]:\s*/i, "");
  if (firstLine.trim()) fixes.push(stripBullet(firstLine));
  for (let i = markerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line) fixes.push(stripBullet(line));
  }
  const clean = lines.slice(0, markerIdx).join("\n").trim();
  return { clean, fixes };
}

function stripBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "").trim();
}

// Delimiter separating streamed prose from the trailing JSON control frame. A
// distinctive printable sentinel that will never occur in generated prose, so the
// client can split the stream unambiguously.
export const CONTROL_DELIM = "\n<<<BOOKFORGE_CTRL>>>\n";
