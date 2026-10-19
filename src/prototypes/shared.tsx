import { Box, Text } from "ink";

export const ACCENT = "blue";

/** The wordmark: a small clock glyph and the name, two-tone. */
export function Wordmark({ tagline = true }: { tagline?: boolean }) {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text>
        <Text color={ACCENT}>◷ </Text>
        <Text bold>clock</Text>
        <Text bold color={ACCENT}>
          out
        </Text>
      </Text>
      {tagline ? <Text dimColor>your day, ready to paste</Text> : null}
    </Box>
  );
}
