import { stripVTControlCharacters } from "node:util";

// Titles come from other people (meeting invites, PR titles, commit subjects) and from the AI,
// and end up on the terminal and in exports: no escape codes that could recolour the terminal
// or set its title, and no line breaks that would break a row.

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** One line of plain text: escape sequences dropped, other control characters and runs of whitespace as one space. */
export function cleanText(text: string): string {
  const plain = [...stripVTControlCharacters(text)]
    .map((ch) => (isControl(ch.codePointAt(0) ?? 0) ? " " : ch))
    .join("");
  return plain.replace(/\s+/g, " ").trim();
}
