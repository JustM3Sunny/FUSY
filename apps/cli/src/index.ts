import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadConfig } from "@fusy/config";
import { createInitialState } from "@fusy/core";
import { logInfo } from "@fusy/telemetry";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const state = createInitialState("default");

  logInfo(`Starting CLI in ${config.nodeEnv} mode`);

  const rl = createInterface({ input, output });
  const answer = await rl.question("What should I do? ");

  output.write(`Received: ${answer}\n`);
  output.write(`Current state: ${state.status}\n`);
  rl.close();
};

void main();
