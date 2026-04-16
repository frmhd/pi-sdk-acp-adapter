# ACP Terminal Capability Fallback Strategy

## Problem Statement

WebStorm and other JetBrains IDEs advertise `terminal: false` (or omit the terminal capability) in their ACP client capabilities. The current Pi ACP Adapter implementation **requires** terminal support and throws an error during session initialization if it's missing.

This blocks Pi from working in WebStorm, even though the agent could fall back to local command execution.

### Current Behavior

```typescript
// src/runtime/AcpAgentRuntime.ts (lines 224-227)
const missingCapabilities = getMissingRequiredClientCapabilities(options.clientCapabilities);
if (missingCapabilities.length > 0) {
  throw new Error(createMissingClientCapabilitiesMessage(missingCapabilities));
}
```

**Required capabilities (current):**

- `fs.readTextFile` ✓
- `fs.writeTextFile` ✓
- `terminal` ✗ ← **This blocks WebStorm**

### Affected Environments

| Client               | Terminal Support | Impact               |
| -------------------- | ---------------- | -------------------- |
| **Zed Editor**       | ✓ Full support   | Works correctly      |
| **WebStorm**         | ✗ Not supported  | **Blocked entirely** |
| **IntelliJ IDEA**    | ✗ Not supported  | **Blocked entirely** |
| **PyCharm**          | ✗ Not supported  | **Blocked entirely** |
| **VS Code (future)** | ? TBD            | Potential issue      |

### ACP Protocol Compliance

The [ACP Protocol Specification](https://agentclientprotocol.com/protocol/terminals) states:

> "If `terminal` is `false` or not present, the Agent **MUST NOT** attempt to call any terminal methods."

This means:

1. We **must not** call `terminal/create`, `terminal/output`, etc. when capability is false
2. It does **not** mean the agent cannot execute commands through other means
3. The protocol allows agents to use alternative execution strategies

---

## Research Findings

### How Other ACP Agents Handle Missing Terminal

Based on web research of production ACP agents:

| Agent         | Strategy                                                                             |
| ------------- | ------------------------------------------------------------------------------------ |
| **Kimi CLI**  | Detects capability → swaps Shell tool to internal execution when `terminal: false`   |
| **Crow CLI**  | Routes to MCP server (`crow-mcp`) with PTY-backed bash when ACP terminal unavailable |
| **Zeph**      | Uses internal terminal with configurable timeouts                                    |
| **Qoder CLI** | Internal execution when IDE doesn't provide terminal                                 |

### Kimi CLI's Approach (Reference Implementation)

From [Kimi CLI ACP integration](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/acp/AGENTS.md):

> "If the client advertises `terminal` capability, the `Shell` tool is replaced by an ACP-backed `Terminal` tool. Uses ACP `terminal/create`, waits for exit, streams `TerminalToolCallContent`, then releases the terminal handle."

**Key Pattern:** Dynamic tool swapping based on capability detection.

---

## Suggested Fix: Internal Execution Fallback

### Architecture

When ACP terminal is unavailable, fall back to Node.js `child_process` execution:

```typescript
// Pseudocode for the solution
class BashOperations {
  async exec(command, cwd, options) {
    if (clientCapabilities.terminal) {
      // ACP path: Use terminal/create, terminal/wait_for_exit
      return executeViaAcpTerminal(command, cwd, options);
    } else {
      // Fallback path: Use child_process.spawn/exec
      return executeLocally(command, cwd, options);
    }
  }
}
```

---

## References

1. [ACP Terminal Protocol](https://agentclientprotocol.com/protocol/terminals)
2. [JetBrains WebStorm ACP Docs](https://www.jetbrains.com/help/webstorm/use-ai-agents-with-webstorm.html)
3. [Kimi CLI ACP Integration](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/acp/AGENTS.md)
4. [Crow CLI Dual-Mode Architecture](https://github.com/crow-cli/crow-cli)
5. [OpenClaw Bridge Limitations](https://shashikantjagtap.net/openclaw-acp-what-coding-agent-users-need-to-know-about-protocol-gaps/)
