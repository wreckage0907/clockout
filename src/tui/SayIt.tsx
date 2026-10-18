import { Box, Text } from "ink";

/** The always-focused input. Keys and pastes are handled by the App so shortcuts can share them. */
export function SayIt({
  value,
  busy,
  status,
  width,
}: {
  value: string;
  busy: string | null;
  status: string | null;
  width: number;
}) {
  const room = Math.max(10, width - 8);
  const shown = value.length > room ? `…${value.slice(-(room - 1))}` : value;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={busy ? "gray" : "cyan"}
      paddingX={1}
      width={width}
    >
      <Text>
        <Text color="cyan" bold>
          Say it
        </Text>
        <Text dimColor> · dictate with Wispr or type, Enter to send · Esc clears</Text>
      </Text>
      {busy ? (
        <Text color="cyan">{busy}</Text>
      ) : (
        <Text>
          <Text color="cyan">› </Text>
          {shown}
          <Text inverse> </Text>
          {value === "" && status ? <Text dimColor> {status}</Text> : null}
        </Text>
      )}
    </Box>
  );
}
