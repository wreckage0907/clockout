import { stripVTControlCharacters } from "node:util";

// Titles come from other people (meeting invites, PR titles, commit subjects) and from the AI,
// and end up on the terminal and in exports: no escape codes that could recolour the terminal
// or set its title, no line breaks that would break a row, and no invisible format characters
// (bidi overrides, zero-width spaces) that could make one text look like another.

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);
const FORMAT = /^\p{Cf}$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const ZWJ = "‍";

/**
 * Characters as they should be shown: escape sequences dropped, control characters (line breaks
 * only when `keepNewlines`) as a space, format characters dropped. A zero-width joiner stays
 * between two emoji, where it builds one (a family, a person with a profession).
 */
function sanitize(text: string, keepNewlines: boolean): string {
  const chars = [...stripVTControlCharacters(text)];
  let out = "";
  chars.forEach((ch, i) => {
    const code = ch.codePointAt(0) ?? 0;
    if (keepNewlines && ch === "\n") out += ch;
    else if (isControl(code)) out += " ";
    else if (ch === ZWJ) {
      const prev = chars[i - 1] === "️" ? chars[i - 2] : chars[i - 1];
      if (prev && PICTOGRAPH.test(prev) && PICTOGRAPH.test(chars[i + 1] ?? "")) out += ch;
    } else if (!FORMAT.test(ch)) out += ch;
  });
  return out;
}

/** One line of plain text: escape sequences dropped, other control characters and runs of whitespace as one space. */
export function cleanText(text: string): string {
  return sanitize(text, false).replace(/\s+/g, " ").trim();
}

/** Like `cleanText` but keeps the line breaks (a description with several lines). */
export function cleanLines(text: string): string {
  return sanitize(text.replace(/\r\n?/g, "\n"), true)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}
