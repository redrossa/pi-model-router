/**
 * Minimal structural typing for the surface of Pi's ExtensionAPI this
 * extension relies on. Intentionally loose (not imported from
 * @mariozechner/pi-coding-agent) so this file compiles standalone; swap for
 * the real package types once it's installed as a dependency in your Pi
 * checkout. See docs/extensions.md in earendil-works/pi for the authoritative
 * shape.
 */
export interface PiUi {
  notify(message: string, level?: "info" | "warn" | "error"): void;
  setStatus?(text: string | null): void;
}

export interface PiCtx {
  ui: PiUi;
  model?: { id: string };
  session?: { id: string };
}

export interface BeforeAgentStartEvent {
  prompt: string;
  systemPrompt: string;
}

export interface BeforeProviderRequestEvent {
  payload: { model?: string; [key: string]: unknown };
}

export interface CommandArgs {
  raw: string;
  args: string[];
}

export interface PiExtensionAPI {
  projectDir: string;
  on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: PiCtx) => unknown | Promise<unknown>): void;
  on(
    event: "before_provider_request",
    handler: (event: BeforeProviderRequestEvent, ctx: PiCtx) => unknown | Promise<unknown>,
  ): void;
  on(event: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): void;
  registerCommand(name: string, def: { description: string; handler: (args: CommandArgs, ctx: PiCtx) => unknown | Promise<unknown> }): void;
  listModels?(): Array<{ id: string; provider: string; loggedIn?: boolean }>;
  isModelAvailable?(modelId: string): boolean;
  config?: { get(key: string): string | undefined };
}
