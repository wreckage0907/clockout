import { Box, Text } from "ink";
import type { ReactNode } from "react";

export const ACCENT = "blue";

/**
 * Input with a left accent bar: the box is quiet, the bar says "type here".
 * `meta` is a second, dim line inside the box.
 */
export function InputBar({
  value,
  placeholder,
  meta,
  width,
  accent = ACCENT,
}: {
  value: string;
  placeholder: string;
  meta?: ReactNode;
  width: number;
  accent?: string;
}) {
  return (
    <Box width={width}>
      <Box flexDirection="column">
        <Text color={accent}>▏</Text>
        {meta ? <Text color={accent}>▏</Text> : null}
      </Box>
      <Box flexDirection="column" paddingLeft={1} width={width - 2}>
        <Text>
          {value === "" ? (
            <Text dimColor>{placeholder}</Text>
          ) : (
            <>
              {value}
              <Text inverse> </Text>
            </>
          )}
        </Text>
        {meta ? <Text dimColor>{meta}</Text> : null}
      </Box>
    </Box>
  );
}

/** One dim line at the very bottom. The only place keys are ever mentioned. */
export function Hint({ text }: { text: string }) {
  return <Text dimColor> {text}</Text>;
}
