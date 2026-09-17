import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RouterCriteria, CriteriaCategory } from "./types.js";

const DEFAULT_CRITERIA_PATH = new URL("../config/default-criteria.json", import.meta.url);

export const USER_CONFIG_FILENAMES = ["pi-model-router.json", ".pi-model-router.json"];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function findUserConfigPath(projectDir: string): string | null {
  const candidates = [
    ...USER_CONFIG_FILENAMES.map((f) => join(projectDir, ".pi", f)),
    ...USER_CONFIG_FILENAMES.map((f) => join(projectDir, f)),
    ...USER_CONFIG_FILENAMES.map((f) => join(homedir(), ".pi", "agent", f)),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function mergeCategory(base: CriteriaCategory | undefined, override: Partial<CriteriaCategory>): CriteriaCategory {
  return {
    description: override.description ?? base?.description ?? "",
    models: override.models ?? base?.models ?? [],
  };
}

/**
 * Deep-merges a user-supplied criteria file on top of the shipped default.
 * Users can override individual categories, add new ones, or replace
 * top-level fields (question/instructions/fallback/confidenceThreshold)
 * without having to restate the whole file.
 */
export function mergeCriteria(base: RouterCriteria, override: Partial<RouterCriteria>): RouterCriteria {
  const categories: Record<string, CriteriaCategory> = { ...base.categories };
  if (override.categories) {
    for (const [key, value] of Object.entries(override.categories)) {
      categories[key] = mergeCategory(base.categories[key], value);
    }
  }
  return {
    question: override.question ?? base.question,
    instructions: override.instructions ?? base.instructions,
    categories,
    fallback: { ...base.fallback, ...override.fallback },
    confidenceThreshold: override.confidenceThreshold ?? base.confidenceThreshold,
  };
}

export function loadDefaultCriteria(): RouterCriteria {
  return readJson(DEFAULT_CRITERIA_PATH.pathname) as RouterCriteria;
}

/**
 * Loads the effective criteria config: shipped default merged with the first
 * user config found in (in order) `<project>/.pi/pi-model-router.json`,
 * `<project>/pi-model-router.json`, or `~/.pi/agent/pi-model-router.json`.
 */
export function loadCriteria(projectDir: string): { criteria: RouterCriteria; sourcePath: string | null } {
  const base = loadDefaultCriteria();
  const userPath = findUserConfigPath(projectDir);
  if (!userPath) return { criteria: base, sourcePath: null };
  try {
    const override = readJson(userPath) as Partial<RouterCriteria>;
    return { criteria: mergeCriteria(base, override), sourcePath: userPath };
  } catch (err) {
    throw new Error(`pi-model-router: failed to parse ${userPath}: ${(err as Error).message}`);
  }
}
