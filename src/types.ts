import type { SpawnOptions } from "node:child_process";
/** JSON documents validated at the configuration / extension / API boundary. */
export type JsonObject = Record<string, any>;
export interface CliOptions {
  [name: string]: string | boolean | undefined;
  config?: string; profile?: string; url?: string; tenant?: string; token?: string;
  version?: string; from?: string; sha256?: string; runtime?: string; port?: string;
  template?: string; "cli-package"?: string; format?: string; status?: string;
  search?: string; "version-id"?: string;
}
export interface BuildOptions { signal?: AbortSignal; frozenLockfile?: boolean; mode?: string }
export interface ExtensionPlan {
  aliases: Record<string, string>; requireAliases?: Record<string, string>;
  preload: string[]; components: string[]; imports: string[]; permissions: string[];
  witDirectories: string[]; packages: Record<string, string>; metadata: JsonObject;
}
export interface ProcessOptions extends SpawnOptions {
  stopTimeoutMs?: number; capture?: boolean; maxBuffer?: number; timeout?: number;
}
export interface RequestOptions { method?: string; body?: any; auth?: boolean; signal?: AbortSignal }
export interface BrowserOptions { noBrowser?: boolean; open?: (url: string) => Promise<void>; timeoutMs?: number; signal?: AbortSignal; log?: (message: string) => void }
export interface RuntimeOptions { fetcher?: typeof fetch; home?: string; target?: string; signal?: AbortSignal }
