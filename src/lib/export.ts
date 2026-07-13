// Export (SPEC section 8). Concatenates locked chapters, latest draft version
// each, in order_index order, into a single Markdown file. Nothing fancier.

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { listChapters } from "./repo/chapters";
import { latestDraft } from "./repo/drafts";
import type { Project } from "./repo/projects";

type Db = BetterSQLite3Database<typeof schema>;

export interface ExportResult {
  filename: string;
  content: string;
}

// Builds the exported Markdown. Only 'locked' chapters are included (planned,
// interrogating, drafting, and review chapters are excluded); each contributes
// its latest draft version. Heading level is a judgment call (D31): the book
// title is a level-1 heading and each chapter is level-2, so the concatenation
// reads as one document rather than a flat list of H1s. A book with no locked
// chapters yet still produces a valid, readable document rather than an empty
// string.
export function buildExport(db: Db, project: Project): ExportResult {
  const locked = listChapters(db, project.id).filter((c) => c.status === "locked");

  const sections = locked.map((c) => {
    const draft = latestDraft(db, c.id);
    const heading = c.title?.trim() || `Chapter ${c.orderIndex + 1}`;
    const body = draft ? draft.content.trim() : "";
    return `## ${heading}\n\n${body}`;
  });

  const content =
    sections.length > 0
      ? `# ${project.title}\n\n${sections.join("\n\n")}\n`
      : `# ${project.title}\n\n(no locked chapters yet)\n`;

  return { filename: `${slugify(project.title)}.md`, content };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "book";
}
