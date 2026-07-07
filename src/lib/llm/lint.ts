// Post-generation lint. The em-dash rule is a hard reject (retry once); the
// Britishism rule is a soft warning tripwire.

export const EM_DASH = "—"; // U+2014

// Rejects a true em-dash, or a double hyphen used as one (a hyphen pair with a
// non-hyphen on each side, e.g. "word--word" or "word -- word").
export function hasEmDash(text: string): boolean {
  if (text.includes(EM_DASH)) return true;
  if (/(?:^|[^-])--(?:[^-]|$)/.test(text)) return true;
  return false;
}

// Very rough tripwire: a Britishism term appearing in a paragraph that does not
// contain the designated character's dialogue attribution. Imperfect by design.
export interface BritishismWarning {
  term: string;
  paragraph: string;
}

export function britishismWarnings(
  text: string,
  args: { terms: string[]; designatedCharacter: string },
): BritishismWarning[] {
  const warnings: BritishismWarning[] = [];
  if (args.terms.length === 0) return warnings;
  const paragraphs = text.split(/\n{2,}/);
  const name = args.designatedCharacter.toLowerCase();
  for (const para of paragraphs) {
    const lower = para.toLowerCase();
    // If the paragraph names the designated character, assume it is their line.
    const attributed = name.length > 0 && lower.includes(name);
    if (attributed) continue;
    for (const term of args.terms) {
      const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
      if (re.test(para)) warnings.push({ term, paragraph: para.trim() });
    }
  }
  return warnings;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
