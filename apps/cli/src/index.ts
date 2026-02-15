import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { type WorkflowCheckpoint, WorkflowStateMachine, createInitialState } from "@fusy/core";
import { loadConfig } from "@fusy/config";
import { DEFAULT_TOOL_REGISTRY, executeTool } from "@fusy/tools";
import { logInfo } from "@fusy/telemetry";

const CHECKPOINT_FILE = ".fusy-session-checkpoint.json";

const normalizeYesNo = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
};

const isDestructiveAction = (text: string): boolean => {
  const destructivePatterns = ["rm ", "--force", "git reset", "truncate", "delete", "docker push"];
  return destructivePatterns.some((pattern) => text.toLowerCase().includes(pattern));
};

const persistCheckpoint = async (checkpoint: WorkflowCheckpoint): Promise<void> => {
  await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), "utf8");
};

const parseJsonArgs = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool args must be a JSON object");
  }

  return parsed as Record<string, unknown>;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const state = createInitialState("default");
  const machine = new WorkflowStateMachine();

  logInfo(`Starting CLI in ${config.nodeEnv} mode`);

  const rl = createInterface({ input, output });

  const handleInterrupt = async (): Promise<void> => {
    machine.rollbackForInterruption();
    const checkpoint = machine.checkpointHistory.at(-1);
    if (checkpoint) {
      await persistCheckpoint(checkpoint);
    }

    output.write("Session interrupted. Rolled back and stored checkpoint.\n");
    rl.close();
    process.exit(130);
  };

  process.once("SIGINT", () => {
    void handleInterrupt();
  });

  const intent = await rl.question("What should I do? ");
  machine.advance({ intent });

  const plan = await rl.question("Plan for this task: ");
  machine.advance({ plan });

  output.write(`Available tools (${Object.keys(DEFAULT_TOOL_REGISTRY).length}):\n`);
  output.write(`${Object.keys(DEFAULT_TOOL_REGISTRY).join(", ")}\n`);

  const selectedTools = await rl.question("Tools to run (comma-separated): ");
  const selectedToolNames = selectedTools
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  machine.advance({ selectedTools: selectedToolNames });

  const toolResults: string[] = [];
  for (const toolName of selectedToolNames) {
    if (!DEFAULT_TOOL_REGISTRY[toolName]) {
      output.write(`Skipping unknown tool: ${toolName}\n`);
      continue;
    }

    const argsRaw = await rl.question(`JSON args for ${toolName}: `);
    let args: Record<string, unknown>;

    try {
      args = parseJsonArgs(argsRaw);
    } catch (error) {
      output.write(`Invalid args for ${toolName}: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }

    if (toolName === "runCommand") {
      const command = String(args.command ?? "");
      if (!command) {
        output.write("runCommand requires {\"command\":\"...\"}\n");
        continue;
      }

      if (isDestructiveAction(command)) {
        const destructiveApproval = await rl.question(
          "Destructive action detected. Approve execution? (y/N): "
        );
        if (!normalizeYesNo(destructiveApproval)) {
          output.write("Destructive action rejected by user.\n");
          continue;
        }
      }

      const commandApproval = await rl.question("Execute command now? (y/N): ");
      if (!normalizeYesNo(commandApproval)) {
        output.write("Command execution cancelled.\n");
        continue;
      }
    }

    try {
      const result = await machine.runTool(
        { name: toolName, args },
        {
          cwd: process.cwd(),
          policy: {
            requireApproval: true,
            approved: true,
            denyList: ["shutdown", "reboot", "mkfs", "dd"]
          }
        },
        (request, context) => executeTool(request.name, request.args, context)
      );

      const rendered = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      output.write(`Tool ${toolName} result:\n${rendered}\n`);
      toolResults.push(toolName);
    } catch (error) {
      output.write(`Tool ${toolName} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  machine.advance({ toolResults });

  const observations = await rl.question("Observations: ");
  machine.advance({ observations });

  const patch = await rl.question("Patch preview text (optional):\n");
  if (patch.trim()) {
    output.write("--- Patch Preview ---\n");
    output.write(`${patch}\n`);
    output.write("--- End Preview ---\n");

    const patchDecision = await rl.question("Apply patch, reject patch, or skip? (apply/reject/skip): ");
    if (patchDecision.trim().toLowerCase() === "apply") {
      try {
        await executeTool(
          "gitApplyPatch",
          { patch },
          {
            cwd: process.cwd(),
            policy: {
              requireApproval: true,
              approved: true,
              denyList: ["shutdown", "reboot", "mkfs", "dd"]
            }
          }
        );
        output.write("Patch applied successfully.\n");
      } catch (error) {
        output.write(`Patch apply failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    } else if (patchDecision.trim().toLowerCase() === "reject") {
      output.write("Patch rejected by user.\n");
    } else {
      output.write("Patch skipped.\n");
    }
  }
  machine.advance({ patch });

  const verificationAnswer = await rl.question("Did verification pass? (y/N): ");
  const verificationSuccess = normalizeYesNo(verificationAnswer);
  machine.advance({
    verification: {
      success: verificationSuccess,
      details: verificationSuccess ? "Verification passed" : "Verification failed"
    }
  });

  if (!verificationSuccess) {
    const checkpoint = machine.checkpointHistory.at(-1);
    if (checkpoint) {
      await persistCheckpoint(checkpoint);
    }

    output.write("Verification failed. Rolled back to PATCH and checkpoint created.\n");
  }

  const summary = await rl.question("Summary: ");
  machine.advance({ summary });

  output.write(`Received: ${intent}\n`);
  output.write(`Current state: ${state.status}\n`);
  output.write(`Workflow state: ${machine.state}\n`);

  rl.close();
};

void main();
