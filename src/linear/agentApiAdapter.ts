import type { Task } from "../queue/db.ts";
import type {
  FailureDiagnostics,
  LinearAdapter,
  ProgressEvent,
} from "./adapter.ts";

/**
 * v2 stub. Will be implemented against the Linear Agent API
 * (AgentSession lifecycle + AgentActivity stream) once the v1 loop is proven.
 *
 * https://linear.app/developers/agents
 * https://linear.app/developers/agent-interaction
 */
export const agentApiAdapter: LinearAdapter = {
  async notifyStarted(_task: Task): Promise<void> {
    throw new Error("agentApiAdapter not implemented; use webhookAdapter for v1");
  },
  async notifyProgress(_task: Task, _event: ProgressEvent): Promise<void> {
    throw new Error("agentApiAdapter not implemented");
  },
  async notifyPrOpened(_task: Task, _prUrl: string): Promise<void> {
    throw new Error("agentApiAdapter not implemented");
  },
  async notifyDone(_task: Task): Promise<void> {
    throw new Error("agentApiAdapter not implemented");
  },
  async notifyFailed(_task: Task, _diag: FailureDiagnostics): Promise<void> {
    throw new Error("agentApiAdapter not implemented");
  },
};
