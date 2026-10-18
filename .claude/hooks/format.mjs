// PostToolUse hook: format the file Claude just wrote with Biome.
import { spawnSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const file = JSON.parse(input).tool_input?.file_path;
if (file) {
  spawnSync("pnpm", ["exec", "biome", "check", "--write", "--no-errors-on-unmatched", file], {
    stdio: "ignore",
  });
}
