import type { AnyTool } from "../core/tool.js";
import { askLibrary, getJobResult } from "./agent.js";
import { checkAvailability, estimateWait, findLibrary, getTitle, searchCatalog } from "./catalog.js";
import { healthCheck } from "./health.js";
import { getBranch, listBranches, listEvents } from "./places.js";
import { cancelWatch, listWatches, watchTitle } from "./watch.js";

/** Every tool the server exposes, in the order agents should discover them. */
export const TOOLS: AnyTool[] = [
  findLibrary,
  searchCatalog,
  getTitle,
  checkAvailability,
  estimateWait,
  listBranches,
  getBranch,
  listEvents,
  askLibrary,
  getJobResult,
  watchTitle,
  listWatches,
  cancelWatch,
  healthCheck,
];
