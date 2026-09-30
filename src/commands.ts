import { parseArgs } from "node:util";
import type { CliOptions } from "./types.js";
interface Option { type: "string" | "boolean"; description: string; value?: string; short?: string }
interface Command { description: string; usage?: string; flags?: string[]; min?: number; max?: number; examples?: string[]; notes?: string; secretName?: boolean; actions?: Record<string, Command> }
interface ParsedCommand { versionOnly?: boolean; helpText?: string; command?: string; args?: string[]; values?: CliOptions }
const options: Record<string, Option> = {
  "help": {
    "type": "boolean",
    "description": "Show help for this command",
    "short": "h"
  },
  "json": {
    "type": "boolean",
    "description": "Output the complete API response as JSON"
  },
  "format": {
    "type": "string",
    "value": "FORMAT",
    "description": "pretty or json (default: pretty in a terminal, json when piped)"
  },
  "status": {
    "type": "string",
    "value": "STATUS",
    "description": "Filter invocation outcome: ok, error or canceled (HTTP status is separate)"
  },
  "search": {
    "type": "string",
    "value": "TEXT",
    "description": "Match literal, case-sensitive text in stdout or stderr"
  },
  "version-id": {
    "type": "string",
    "value": "ID",
    "description": "Filter by deployed version ID"
  },
  "verbose": {
    "type": "boolean",
    "description": "Include internal identifiers and the full version"
  },
  "config": {
    "type": "string",
    "value": "FILE",
    "description": "Project configuration (default: hibana.json)",
    "short": "c"
  },
  "template": {
    "type": "string",
    "value": "NAME",
    "description": "Hono application template (the only supported template)"
  },
  "no-install": {
    "type": "boolean",
    "description": "Create project files without installing npm dependencies"
  },
  "cli-package": {
    "type": "string",
    "value": "PATH",
    "description": "Pin a local CLI package in the new project"
  },
  "port": {
    "type": "string",
    "value": "PORT",
    "description": "Local HTTP port (default: 8787)"
  },
  "no-watch": {
    "type": "boolean",
    "description": "Run once without watching for file changes"
  },
  "frozen-lockfile": {
    "type": "boolean",
    "description": "Require hibana-lock.json to match extension sources; never update it"
  },
  "runtime": {
    "type": "string",
    "value": "PATH",
    "description": "Use a specific local runtime executable"
  },
  "profile": {
    "type": "string",
    "value": "NAME",
    "description": "Use a saved connection profile"
  },
  "url": {
    "type": "string",
    "value": "URL",
    "description": "Hibana management API URL"
  },
  "tenant": {
    "type": "string",
    "value": "TEAM",
    "description": "Tenant name"
  },
  "no-browser": {
    "type": "boolean",
    "description": "Print the login URL without opening a browser"
  },
  "version": {
    "type": "string",
    "value": "VERSION",
    "description": "Version to use"
  },
  "all": {
    "type": "boolean",
    "description": "Select all applications in the current tenant"
  },
  "all-tenants": {
    "type": "boolean",
    "description": "Select every tenant; requires BOOTSTRAP_ADMIN_TOKEN"
  },
  "dry-run": {
    "type": "boolean",
    "description": "Preview the operation without making changes"
  },
  "yes": {
    "type": "boolean",
    "description": "Confirm without prompting",
    "short": "y"
  },
  "from": {
    "type": "string",
    "value": "FILE",
    "description": "Install a runtime from a local file"
  },
  "sha256": {
    "type": "string",
    "value": "HASH",
    "description": "SHA-256 checksum; required with --from"
  }
};
const commands: Record<string, Command> = {
  "init": {
    "description": "Create a new application",
    "usage": "hibana init [directory]",
    "flags": [
      "template",
      "no-install",
      "cli-package"
    ],
    "min": 0,
    "max": 1,
    "examples": [
      "hibana init my-api"
    ],
    "notes": "Creates a Hono application and installs its npm dependencies.\nThe project pins this CLI version in devDependencies.\nProject scripts use the local CLI; no global installation is needed.\nUse --cli-package PATH for a local CLI tarball.\nUse an empty directory; omit the directory to create files in the current one."
  },
  "dev": {
    "description": "Run your application locally and reload changes",
    "usage": "hibana dev",
    "flags": [
      "config",
      "port",
      "no-watch",
      "runtime",
      "frozen-lockfile"
    ],
    "min": 0,
    "max": 0,
    "examples": [
      "hibana dev",
      "hibana dev --port 3000"
    ],
    "notes": "Open http://127.0.0.1:8787 (or your chosen port). Press Ctrl+C to stop.\nThe matching local runtime is installed automatically when needed and reused.\nFor a supplied executable, use --runtime PATH or HIBANA_RUNTIME_BIN.\nAllow local outbound connections with dev.allow_outbound in hibana.json (HOST:PORT).\nLocal Secrets belong in .dev.vars; deployment permissions and Secrets are separate."
  },
  "build": {
    "description": "Build a WebAssembly Component",
    "usage": "hibana build",
    "flags": [
      "config",
      "frozen-lockfile"
    ],
    "min": 0,
    "max": 0,
    "examples": [
      "hibana build"
    ],
    "notes": "Builds the project without starting a runtime or contacting a Hibana server.\nDeclare extension names and sources in hibana.json. The CLI installs them into .hibana/ and records hibana-lock.json. Commit the lockfile; use --frozen-lockfile in CI."
  },
  "deploy": {
    "description": "Build and deploy your application",
    "usage": "hibana deploy",
    "flags": [
      "config",
      "profile",
      "url",
      "version",
      "frozen-lockfile",
      "verbose"
    ],
    "min": 0,
    "max": 0,
    "examples": [
      "hibana deploy",
      "hibana deploy --profile staging --version 1.0.0"
    ],
    "notes": "Builds and activates a new version. A version is generated when --version is omitted.\nVersion names use 1..128 ASCII characters: start with a letter or digit, then letters, digits, '.', '_', '+', '-'.\nUses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
  },
  "tail": {
    "description": "Watch live application executions and their output",
    "usage": "hibana tail [NAME]",
    "flags": [
      "config",
      "profile",
      "url",
      "format",
      "status",
      "search",
      "version-id",
      "verbose"
    ],
    "min": 0,
    "max": 1,
    "examples": [
      "hibana tail",
      "hibana tail my-api --format pretty",
      "hibana tail my-api --status error",
      "hibana tail my-api --search 'connection failed'",
      "hibana tail my-api --format json"
    ],
    "notes": "Uses hibana.json when NAME is omitted. Requires Read permission.\nStarts watching now; completed invocations appear as they arrive. Press Ctrl+C to stop.\nok means the application completed, including HTTP 4xx/5xx. error includes traps and timeouts.\nHibana does not currently produce canceled invocations.\nJSON emits one execution per line; connection messages and gap warnings go to stderr.\nLive delivery is best effort. View stored logs in the Console's execution history.\nUses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
  },
  "rollback": {
    "description": "Restore a previously deployed version",
    "usage": "hibana rollback",
    "flags": [
      "config",
      "profile",
      "url",
      "version",
      "verbose"
    ],
    "min": 0,
    "max": 0,
    "examples": [
      "hibana rollback",
      "hibana rollback --version 1.0.0"
    ],
    "notes": "Restores the previous version when --version is omitted.\nUses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
  },
  "list": {
    "description": "List deployed applications",
    "usage": "hibana list",
    "flags": [
      "profile",
      "url",
      "all-tenants",
      "json"
    ],
    "min": 0,
    "max": 0,
    "notes": "Uses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
  },
  "delete": {
    "description": "Delete a deployed application",
    "usage": "hibana delete [NAME]",
    "flags": [
      "config",
      "profile",
      "url",
      "all",
      "all-tenants",
      "dry-run",
      "yes"
    ],
    "min": 0,
    "max": 1,
    "examples": [
      "hibana delete my-api --dry-run",
      "hibana delete my-api",
      "hibana delete --all -y"
    ],
    "notes": "Uses the name in hibana.json when NAME is omitted. Prompts before deletion.\nUse -y in scripts. --all-tenants requires --all and administrator credentials.\nUses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
  },
  "login": {
    "description": "Sign in and save a connection profile",
    "usage": "hibana login",
    "flags": [
      "profile",
      "url",
      "tenant",
      "no-browser"
    ],
    "min": 0,
    "max": 0,
    "examples": [
      "hibana login --url https://api.example.com --tenant team"
    ],
    "notes": "Opens your organization's login page in a browser on this computer.\nUse --no-browser to open the printed URL yourself on the same computer.\nReuses saved connection details; HIBANA_TENANT also supplies the tenant.\nCI: use a scoped HIBANA_TOKEN."
  },
  "logout": {
    "description": "Remove the saved token for a profile",
    "usage": "hibana logout",
    "flags": [
      "profile"
    ],
    "min": 0,
    "max": 0,
    "notes": "Uses the selected profile when --profile is omitted."
  },
  "profile": {
    "description": "Manage saved connections",
    "actions": {
      "list": {
        "description": "List saved profiles and the selected connection",
        "usage": "hibana profile list",
        "flags": [],
        "min": 0,
        "max": 0
      },
      "use": {
        "description": "Select the connection for subsequent commands",
        "usage": "hibana profile use NAME",
        "flags": [],
        "min": 1,
        "max": 1
      },
      "remove": {
        "description": "Remove a saved connection profile",
        "usage": "hibana profile remove NAME",
        "flags": [],
        "min": 1,
        "max": 1
      }
    }
  },
  "egress": {
    "description": "Manage application outbound destinations",
    "actions": {
      "list": {
        "description": "List allowed outbound destinations",
        "usage": "hibana egress list",
        "flags": [
          "config",
          "profile",
          "url",
          "json"
        ],
        "min": 0,
        "max": 0,
        "notes": "An empty allow_outbound list denies all outbound access.\nUses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
      },
      "allow": {
        "description": "Allow outbound destinations for every version",
        "usage": "hibana egress allow HOST:PORT [HOST:PORT ...]",
        "flags": [
          "config",
          "profile",
          "url"
        ],
        "min": 1,
        "max": 64,
        "examples": [
          "hibana egress allow db.example.com:5432"
        ],
        "notes": "Requires administrator credentials. Applies to past, current and future versions.\nSpecify destinations without a URL, password or wildcard. IPv6: [address]:port.\nUses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
      },
      "deny": {
        "description": "Revoke outbound destinations for every version",
        "usage": "hibana egress deny HOST:PORT [HOST:PORT ...]",
        "flags": [
          "config",
          "profile",
          "url"
        ],
        "min": 1,
        "max": 64,
        "examples": [
          "hibana egress deny db.example.com:5432"
        ],
        "notes": "Requires administrator credentials. Applies to past, current and future versions.\nSpecify destinations without a URL, password or wildcard. IPv6: [address]:port.\nUses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
      }
    }
  },
  "secret": {
    "description": "Manage application secrets",
    "actions": {
      "put": {
        "description": "Store a secret from standard input",
        "usage": "hibana secret put NAME",
        "flags": [
          "config",
          "profile",
          "url"
        ],
        "min": 1,
        "max": 1,
        "secretName": true,
        "notes": "Add the name to hibana.json secrets, allow deployment, then run hibana deploy.\nUses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login.",
        "examples": [
          "hibana secret put API_KEY < secret.txt"
        ]
      },
      "list": {
        "description": "List application secrets",
        "usage": "hibana secret list",
        "flags": [
          "config",
          "profile",
          "url",
          "json"
        ],
        "min": 0,
        "max": 0,
        "notes": "Uses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
      },
      "delete": {
        "description": "Delete a stored secret",
        "usage": "hibana secret delete NAME",
        "flags": [
          "config",
          "profile",
          "url"
        ],
        "min": 1,
        "max": 1,
        "secretName": true,
        "notes": "Uses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
      },
      "allow-deploy": {
        "description": "Allow a secret to be included in future deployments",
        "usage": "hibana secret allow-deploy NAME",
        "flags": [
          "config",
          "profile",
          "url"
        ],
        "min": 1,
        "max": 1,
        "secretName": true,
        "notes": "Uses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
      },
      "deny-deploy": {
        "description": "Prevent a secret from being included in future deployments",
        "usage": "hibana secret deny-deploy NAME",
        "flags": [
          "config",
          "profile",
          "url"
        ],
        "min": 1,
        "max": 1,
        "secretName": true,
        "notes": "Uses your selected profile. Override with --profile NAME or --url URL.\nCI: set HIBANA_URL and HIBANA_TOKEN. Sign in with hibana login."
      }
    }
  },
  "runtime": {
    "description": "Prepare a runtime for offline use or a specific version",
    "actions": {
      "install": {
        "description": "Prepare a local runtime (dev installs it automatically)",
        "usage": "hibana runtime install",
        "flags": [
          "version",
          "from",
          "sha256"
        ],
        "min": 0,
        "max": 0,
        "examples": [
          "hibana runtime install",
          "hibana runtime install --from /path/to/hibana-worker --sha256 HASH"
        ],
        "notes": "Installs the CLI's version by default and verifies the SHA-256 checksum.\nUse --from and --sha256 together to install a file brought into an offline environment."
      }
    }
  }
};

function rows(entries: string[][]) {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries
    .map(([label, description]) => `  ${label.padEnd(width)}  ${description}`)
    .join("\n");
}
export function help(command?: string, action?: string) {
  if (!command)
    return `Hibana — develop and deploy WebAssembly applications.

Usage: hibana <command> [options]

Get started:
  hibana init my-api
  cd my-api
  npm run dev

Development:
${rows(["init", "dev", "build", "deploy"].map((name) => [name, commands[name].description]))}

Applications and connections:
${rows(["login", "logout", "list", "tail", "rollback", "delete", "secret", "egress", "profile"].map((name) => [name, commands[name].description]))}

Advanced:
${rows(["runtime"].map((name) => [name, commands[name].description]))}

Run hibana <command> --help for options and examples.
Use --profile NAME on remote commands to select a saved connection.
hibana --version shows the installed CLI version.`;
  const parent = commands[command],
    spec = action ? parent.actions![action] : parent;
  if (spec.actions)
    return `${spec.description}\n\nUsage: hibana ${command} <command>\n\nCommands:\n${rows(Object.entries(spec.actions).map(([name, item]) => [name, item.description]))}\n\nRun hibana ${command} <command> --help for options and examples.`;
  const flags = [...(spec.flags || []), "help"];
  return `${spec.description}\n\nUsage: ${spec.usage} [options]\n\nOptions:\n${rows(
    flags.map((name) => {
      const option = options[name];
      return [
        `${option.short ? `-${option.short}, ` : ""}--${name}${option.value ? ` ${option.value}` : ""}`,
        option.description,
      ];
    }),
  )}${spec.examples ? `\n\nExamples:\n${spec.examples.map((example) => `  ${example}`).join("\n")}` : ""}${spec.notes ? `\n\n${spec.notes}` : ""}`;
}

function suggestion(input: string, choices: string[]) {
  // A small edit-distance suggestion; never execute a guessed command.
  function distance(a: string, b: string) {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++)
        next.push(
          Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])),
        );
      row = next;
    }
    return row[b.length];
  }
  const ranked = choices
    .map((choice): [string, number] => [choice, distance(input, choice)])
    .sort((a, b) => a[1] - b[1]);
  return ranked[0]?.[1] <= (input.length > 4 ? 2 : 1)
    ? ` Did you mean '${ranked[0][0]}'?`
    : "";
}

export function parseCommand(argv: string[]): ParsedCommand {
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0]))
    return { versionOnly: true };
  let context = "",
    parsed;
  try {
    try {
      parsed = parseArgs({ args: argv, options, allowPositionals: true });
    } catch (error) {
      if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
        const unknown = /Unknown option '([^']+)'/.exec(error.message)?.[1];
        if (unknown)
          throw new Error(
            `Unknown option '${unknown}'.${suggestion(
              unknown,
              Object.keys(options).map((name) => `--${name}`),
            )}`,
          );
      }
      throw error;
    }
    const values = parsed.values as CliOptions;
    let [command, ...args] = parsed.positionals;
    if (command === "help") {
      [command, ...args] = args;
      values.help = true;
    }
    if (!command) {
      if (Object.keys(values).some((name) => name !== "help"))
        throw new Error("Choose a command before specifying its options.");
      return { helpText: help() };
    }
    if (!Object.hasOwn(commands, command))
      throw new Error(
        `Unknown command '${command}'.${suggestion(command, Object.keys(commands))}`,
      );
    context = command;
    let spec = commands[command],
      action;
    if (spec.actions) {
      [action] = args;
      if (action) {
        if (!Object.hasOwn(spec.actions, action))
          throw new Error(
            `Unknown ${command} command '${action}'.${suggestion(action, Object.keys(spec.actions))}`,
          );
        spec = spec.actions[action];
        context += ` ${action}`;
      }
    }
    const allowed = new Set([...(spec.flags || []), "help"]);
    for (const [name, value] of Object.entries(values)) {
      if (!allowed.has(name))
        throw new Error(
          `Option '--${name}' is not supported by 'hibana ${context}'.`,
        );
      if (typeof value === "string" && !value.trim())
        throw new Error(
          `Option '--${name}' requires a non-empty ${options[name].value}.`,
        );
    }
    if (values.help || spec.actions) return { helpText: help(command, action) };
    const positional = action ? args.slice(1) : args;
    if (positional.length < (spec.min ?? 0) || positional.length > (spec.max ?? 0))
      throw new Error(`Usage: ${spec.usage} [options]`);
    if (spec.secretName && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(positional[0]))
      throw new Error(
        "Secret names must contain 1..64 uppercase letters, digits or underscores, starting with a letter or underscore.",
      );
    return { command, args, values };
  } catch (error) {
    error.message += `\nRun hibana${context ? ` ${context}` : ""} --help for usage.`;
    throw error;
  }
}
