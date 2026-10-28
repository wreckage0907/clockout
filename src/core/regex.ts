// A project rule's `title` is a regular expression, and it's run against titles other people
// write (meeting invites, PR titles). A pattern that backtracks without end would hang the app,
// so patterns are length-capped and the classic shapes are refused: a repeated group with a
// repeat inside it, `(a+)+`, and a repeated group of alternatives that overlap, `(a|a)*`.
// A heuristic, not a proof; it catches what's easy to write by accident or plant on purpose.

/** The longest title pattern accepted. */
export const MAX_TITLE_PATTERN = 200;

interface Frame {
  /** An unbounded quantifier somewhere inside this group. */
  loop: boolean;
  alts: string[];
  cur: string;
}

/** Why a title pattern isn't accepted, or undefined when it is. (A leading `(?i)` is allowed.) */
export function unsafePatternReason(pattern: string): string | undefined {
  if (pattern.length > MAX_TITLE_PATTERN) return `is longer than ${MAX_TITLE_PATTERN} characters`;
  const src = pattern.startsWith("(?i)") ? pattern.slice(4) : pattern;
  const stack: Frame[] = [{ loop: false, alts: [], cur: "" }];
  const top = () => stack[stack.length - 1] as Frame;
  let i = 0;
  /** Reads a quantifier at i, if there is one; `unbounded` when it can repeat without limit. */
  const quantifier = (): { unbounded: boolean } | undefined => {
    const c = src[i];
    if (c === "*" || c === "+" || c === "?") {
      i++;
      if (src[i] === "?") i++;
      return { unbounded: c !== "?" };
    }
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (!m) return undefined;
      i += m[0].length;
      if (src[i] === "?") i++;
      const open = m[2] !== undefined && m[3] === "";
      const big = Number(m[3] || m[1]) > 1000;
      return { unbounded: open || big };
    }
    return undefined;
  };
  /** An atom was just read into `cur`: note whether it repeats without limit. */
  const atom = () => {
    if (quantifier()?.unbounded) top().loop = true;
  };
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\\") {
      top().cur += src.slice(i, i + 2);
      i += 2;
      atom();
    } else if (c === "[") {
      let j = i + 1;
      while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      top().cur += src.slice(i, j + 1);
      i = j + 1;
      atom();
    } else if (c === "(") {
      i++;
      const kind = /^\?(?::|=|!|<=|<!|<[^>]*>)/.exec(src.slice(i));
      if (kind) i += kind[0].length;
      stack.push({ loop: false, alts: [], cur: "" });
    } else if (c === ")") {
      i++;
      if (stack.length === 1) return undefined; // unbalanced: new RegExp refuses it
      const g = stack.pop() as Frame;
      g.alts.push(g.cur);
      const q = quantifier();
      const parent = top();
      if (q?.unbounded) {
        if (g.loop) return "has a repeat inside a repeat, which can hang the app";
        const alts = g.alts.map((a) => a.toLowerCase());
        const overlap = alts.some((a, x) => alts.some((b, y) => x !== y && b.startsWith(a)));
        if (alts.length > 1 && overlap)
          return "repeats alternatives that overlap, which can hang the app";
        parent.loop = true;
      } else if (g.loop) parent.loop = true;
      parent.cur += "(…)";
    } else if (c === "|") {
      const f = top();
      f.alts.push(f.cur);
      f.cur = "";
      i++;
    } else {
      top().cur += c;
      i++;
      atom();
    }
  }
  return undefined;
}
