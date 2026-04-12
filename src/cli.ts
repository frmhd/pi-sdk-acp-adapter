#!/usr/bin/env node
/**
 * Pi SDK ACP Adapter - CLI Entry Point
 *
 * This is the main entry point for running the ACP adapter as a CLI tool.
 * It sets up the ACP protocol connection over stdio and bridges requests
 * to the Pi Coding Agent SDK.
 *
 * Usage:
 *   node dist/cli/main.mjs
 *   # or when installed globally:
 *   pi-acp
 *
 * The adapter communicates with ACP-compatible clients (like Zed) over
 * stdin/stdout using newline-delimited JSON (NDJSON).
 */

import * as acp from "@agentclientprotocol/sdk";
import { Writable, Readable } from "node:stream";
import * as os from "node:os";
import * as path from "node:path";

import { AcpAgent } from "./adapter/AcpAgent.js";
import { createAcpAgentRuntime } from "./runtime/AcpAgentRuntime.js";
import { ModelRegistry, AuthStorage, getAgentDir } from "@mariozechner/pi-coding-agent";
import type { CreateAcpAgentRuntimeOptions } from "./runtime/AcpAgentRuntime.js";

// =============================================================================
// Error Handling
// =============================================================================

/**
 * Format and log an error, then exit with code 1.
 */
function fatalError(error: unknown): never {
  if (error instanceof Error) {
    console.error(`[pi-acp] Fatal error: ${error.message}`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
  } else {
    console.error(`[pi-acp] Fatal error: ${String(error)}`);
  }
  process.exit(1);
}

// =============================================================================
// Signal Handling & Cleanup
// =============================================================================

/**
 * Set up graceful shutdown handlers for the CLI.
 */
function setupSignalHandlers(): void {
  // Handle SIGINT (Ctrl+C)
  process.on("SIGINT", () => {
    console.error("[pi-acp] Received SIGINT, shutting down...");
    process.exit(130);
  });

  // Handle SIGTERM
  process.on("SIGTERM", () => {
    console.error("[pi-acp] Received SIGTERM, shutting down...");
    process.exit(143);
  });

  // Handle EPIPE — client disconnected without reading to EOF
  // This is normal for interactive tools; don't crash
  process.stdout.on("error", (err: any) => {
    if (err.code === "EPIPE" || err.code === "ECONNRESET") {
      process.exit(0);
    }
    throw err;
  });

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    fatalError(error);
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason) => {
    fatalError(reason);
  });
}

// =============================================================================
// Adapter Configuration
// =============================================================================

/**
 * Create the adapter configuration from environment and defaults.
 */
function createAdapterConfig(): {
  modelRegistry: ModelRegistry;
  agentDir: string;
} {
  // Create auth storage for API key resolution
  const authStorage = AuthStorage.create();

  // Create model registry for API key resolution
  const modelRegistry = ModelRegistry.create(authStorage);

  // Get agent directory from Pi SDK
  let agentDir: string;
  try {
    agentDir = getAgentDir();
  } catch {
    // Fall back to default, expanded for the current user
    agentDir = path.join(os.homedir(), ".pi/agent");
  }

  return {
    modelRegistry,
    agentDir,
  };
}

// =============================================================================
// Runtime Factory for Sessions
// =============================================================================

/**
 * Creates the runtime factory function required by AcpAgent.
 *
 * This factory is called for each new session to create a Pi AgentSession
 * configured with ACP tool delegation.
 */
function createRuntimeFactory(
  acpConnection: acp.AgentSideConnection,
  config: { agentDir: string },
) {
  return async (
    options: Omit<CreateAcpAgentRuntimeOptions, "acpConnection" | "agentDir">,
  ): Promise<{
    session: import("@mariozechner/pi-coding-agent").AgentSession;
    dispose: () => void;
  }> => {
    return createAcpAgentRuntime({
      ...options,
      acpConnection,
      agentDir: config.agentDir,
    });
  };
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Main entry point for the ACP adapter CLI.
 *
 * Sets up:
 * 1. Stdio streams for ACP communication
 * 2. NDJSON stream for protocol encoding/decoding
 * 3. ACP connection with Pi Agent
 * 4. Graceful shutdown handlers
 */
async function main(): Promise<void> {
  // Log startup
  console.error("[pi-acp] Starting Pi ACP Adapter...");

  try {
    // Get adapter configuration
    const config = createAdapterConfig();

    // Convert Node.js stdio streams to Web Streams for the ACP NDJSON layer.
    // process.stdout is a Node.js Socket; ndJsonStream needs WritableStream.
    // process.stdin is a Node.js ReadStream; ndJsonStream needs ReadableStream.
    // Using Readable.toWeb / Writable.toWeb is required — raw casts won't work.
    const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

    // Create NDJSON stream for protocol encoding/decoding
    const stream = acp.ndJsonStream(output, input);

    // Keep track of the agent for cleanup
    let agent: AcpAgent | undefined;

    // Create the ACP connection
    // The callback is invoked when a new connection is established
    const connection = new acp.AgentSideConnection((conn: acp.AgentSideConnection) => {
      // Create runtime factory for this connection
      const runtimeFactory = createRuntimeFactory(conn, {
        agentDir: config.agentDir,
      });

      // Create the ACP Agent with Pi integration
      // agentDir is passed here so AcpAgent.newSession can use this.config.agentDir directly
      agent = new AcpAgent(
        conn,
        { modelRegistry: config.modelRegistry, agentDir: config.agentDir },
        runtimeFactory,
      );

      return agent;
    }, stream);

    // Set up signal handlers for graceful shutdown
    setupSignalHandlers();

    // Handle connection closure
    connection.signal.addEventListener("abort", () => {
      console.error("[pi-acp] Connection closed, shutting down...");
      if (agent) {
        agent.shutdown().catch((err) => {
          console.error("[pi-acp] Error during shutdown:", err);
        });
      }
    });

    // Wait for connection to close
    // This keeps the process running until the client disconnects
    await connection.closed;

    console.error("[pi-acp] Connection ended normally");
    process.exit(0);
  } catch (error) {
    fatalError(error);
  }
}

// =============================================================================
// Module Entry Point
// =============================================================================

// Run main if this is the entry point
main().catch(fatalError);

// Export for testing
export { main, createAdapterConfig, createRuntimeFactory };
