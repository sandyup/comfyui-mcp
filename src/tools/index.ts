import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowExecuteTools } from "./workflow-execute.js";
import { registerWorkflowVisualizeTools } from "./workflow-visualize.js";
import { registerWorkflowComposeTools } from "./workflow-compose.js";
import { registerWorkflowValidateTools } from "./workflow-validate.js";
import { registerQueueManagementTools } from "./queue-management.js";
import { registerRegistrySearchTools } from "./registry-search.js";
import { registerModelManagementTools } from "./model-management.js";
import { registerSkillGeneratorTools } from "./skill-generator.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerWorkflowLibraryTools } from "./workflow-library.js";
import { registerProcessControlTools } from "./process-control.js";
import { registerImageManagementTools } from "./image-management.js";
import { registerMemoryManagementTools } from "./memory-management.js";
import { registerGenerationTrackerTools } from "./generation-tracker.js";
import { registerAssetTools } from "./assets.js";
import { registerAutoloadedWorkflows } from "./workflow-autoload.js";
import { registerDefaultsTools } from "./defaults.js";
import { registerGenerateImageTool } from "./generate-image.js";
import { registerConditionedGenerationTools } from "./generate-conditioned.js";
import { registerWorkflowDslTools } from "./workflow-dsl.js";
import { registerUpdateComfyUITools } from "./update-comfyui.js";
import { DefaultsManager } from "../services/defaults-manager.js";

export async function registerAllTools(server: McpServer): Promise<void> {
  // Hydrate persisted defaults before any tool registration so subsequent
  // tools can consult DefaultsManager.apply() against a fully-resolved view.
  await DefaultsManager.load();
  registerWorkflowExecuteTools(server);
  registerWorkflowVisualizeTools(server);
  registerWorkflowComposeTools(server);
  registerWorkflowValidateTools(server);
  registerQueueManagementTools(server);
  registerRegistrySearchTools(server);
  registerModelManagementTools(server);
  registerSkillGeneratorTools(server);
  registerDiagnosticsTools(server);
  registerWorkflowLibraryTools(server);
  registerProcessControlTools(server);
  registerImageManagementTools(server);
  registerMemoryManagementTools(server);
  registerGenerationTrackerTools(server);
  registerAssetTools(server);
  registerDefaultsTools(server);
  registerGenerateImageTool(server);
  registerConditionedGenerationTools(server);
  registerWorkflowDslTools(server);
  registerUpdateComfyUITools(server);
  await registerAutoloadedWorkflows(server);
}
