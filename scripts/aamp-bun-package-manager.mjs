import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveBunPackageManagerInvocation(command, args, inherited = process.env) {
  const environment = { ...inherited };
  const prefix = resolve(
    environment.NPM_CONFIG_PREFIX
      || environment.npm_config_prefix
      || join(homedir(), ".aamp", "npm-global"),
  );
  const cache = environment.NPM_CONFIG_CACHE
    || environment.npm_config_cache
    || join(homedir(), ".bun", "install", "cache");
  const registry = environment.NPM_CONFIG_REGISTRY
    || environment.npm_config_registry
    || "https://registry.npmjs.org/";
  configureBunEnvironment(environment, prefix, cache, registry);

  if (command === "npx") {
    const translated = translateNpxArguments(args, environment);
    return { file: process.execPath, args: ["x", ...translated], env: environment };
  }

  const [subcommand, ...remaining] = args;
  if (subcommand === "-v" || subcommand === "--version" || subcommand === "-version") {
    return { stdout: `${globalThis.Bun?.version || ""}\n`, env: environment };
  }
  if (subcommand === "config") {
    const [action, key, value] = remaining;
    if (action === "set" && key === "registry") {
      environment.BUN_CONFIG_REGISTRY = value || registry;
      return { stdout: "", env: environment };
    }
    if (action === "get" && key === "registry") {
      return { stdout: `${environment.BUN_CONFIG_REGISTRY}\n`, env: environment };
    }
    throw new Error(`Unsupported npm config command: ${remaining.join(" ")}`);
  }
  if (subcommand === "root" || subcommand === "prefix") {
    const global = remaining.includes("-g") || remaining.includes("--global");
    if (!global) throw new Error(`Only global npm ${subcommand} is supported by the Bun compatibility shim`);
    return {
      stdout: `${subcommand === "root" ? environment.BUN_INSTALL_GLOBAL_DIR : prefix}\n`,
      env: environment,
    };
  }
  if (subcommand === "view" || subcommand === "info") {
    const infoArgs = translateCommonArguments(remaining, environment, { prefix, cache, registry, includeCache: true, includeRegistry: true });
    return { file: process.execPath, args: ["info", ...infoArgs], env: environment };
  }
  if (subcommand === "install" || subcommand === "add") {
    const isGlobal = remaining.includes("--global") || remaining.includes("-g");
    const installArgs = translateCommonArguments(remaining, environment, {
      prefix,
      cache,
      registry,
      includeCache: true,
      includeRegistry: true,
      prefixMode: isGlobal ? "global" : "cwd",
    });
    return { file: process.execPath, args: ["add", ...installArgs], env: environment };
  }
  if (subcommand === "uninstall" || subcommand === "remove") {
    const isGlobal = remaining.includes("--global") || remaining.includes("-g");
    const removeArgs = translateCommonArguments(remaining, environment, {
      prefix,
      cache,
      registry,
      includeCache: true,
      includeRegistry: false,
      prefixMode: isGlobal ? "global" : "cwd",
    });
    return { file: process.execPath, args: ["remove", ...removeArgs], env: environment };
  }
  if (subcommand === "exec") {
    const separator = remaining.indexOf("--");
    const optionArgs = separator < 0 ? remaining : remaining.slice(0, separator);
    const commandArgs = separator < 0 ? [] : remaining.slice(separator + 1);
    const translated = translateNpxArguments(optionArgs, environment);
    return {
      file: process.execPath,
      args: ["x", ...translated, ...(commandArgs.length ? ["--", ...commandArgs] : [])],
      env: environment,
    };
  }
  throw new Error(`Unsupported npm command in Bun compatibility shim: ${subcommand || "(empty)"}`);
}

function configureBunEnvironment(environment, prefix, cache, registry) {
  environment.BUN_INSTALL_GLOBAL_DIR = join(prefix, "lib", "node_modules");
  environment.BUN_INSTALL_BIN = join(prefix, "bin");
  environment.BUN_INSTALL_CACHE_DIR = cache;
  environment.BUN_CONFIG_REGISTRY = registry;
}

function translateCommonArguments(args, environment, options) {
  const translated = [];
  let prefix = options.prefix;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--registry", "--cache", "--prefix", "--loglevel"].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--registry") environment.BUN_CONFIG_REGISTRY = value;
      if (arg === "--cache") environment.BUN_INSTALL_CACHE_DIR = value;
      if (arg === "--prefix") {
        if (options.prefixMode === "global") {
          prefix = resolve(value);
          configureBunEnvironment(environment, prefix, environment.BUN_INSTALL_CACHE_DIR, environment.BUN_CONFIG_REGISTRY);
        } else if (options.prefixMode === "cwd") {
          translated.push("--cwd", resolve(value));
        }
      }
      if (options.includeRegistry && arg === "--registry") translated.push(`--registry=${value}`);
      if (options.includeCache && arg === "--cache") translated.push(`--cache-dir=${value}`);
      index += 1;
      continue;
    }
    if (arg.startsWith("--registry=")) {
      environment.BUN_CONFIG_REGISTRY = arg.slice("--registry=".length);
      if (options.includeRegistry) translated.push(arg);
      continue;
    }
    if (arg.startsWith("--cache=")) {
      environment.BUN_INSTALL_CACHE_DIR = arg.slice("--cache=".length);
      if (options.includeCache) translated.push(`--cache-dir=${environment.BUN_INSTALL_CACHE_DIR}`);
      continue;
    }
    if (arg.startsWith("--prefix=")) {
      const requestedPrefix = resolve(arg.slice("--prefix=".length));
      if (options.prefixMode === "global") {
        prefix = requestedPrefix;
        configureBunEnvironment(environment, prefix, environment.BUN_INSTALL_CACHE_DIR, environment.BUN_CONFIG_REGISTRY);
      } else if (options.prefixMode === "cwd") {
        translated.push("--cwd", requestedPrefix);
      }
      continue;
    }
    if (["--yes", "-y", "--no-audit", "--no-fund", "--no-save"].includes(arg)) continue;
    if (["--global", "-g", "--force", "--json", "--silent", "--production"].includes(arg)) {
      translated.push(arg);
      continue;
    }
    translated.push(arg);
  }
  return translated;
}

function translateNpxArguments(args, environment) {
  const translated = [];
  const commandArgs = [];
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      afterSeparator = true;
      continue;
    }
    if (afterSeparator) {
      commandArgs.push(arg);
      continue;
    }
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "--registry" || arg === "--cache") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--registry") environment.BUN_CONFIG_REGISTRY = value;
      if (arg === "--cache") environment.BUN_INSTALL_CACHE_DIR = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--registry=")) {
      environment.BUN_CONFIG_REGISTRY = arg.slice("--registry=".length);
      continue;
    }
    if (arg.startsWith("--cache=")) {
      environment.BUN_INSTALL_CACHE_DIR = arg.slice("--cache=".length);
      continue;
    }
    if (arg === "--package" || arg === "-p") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a package name`);
      translated.push("--package", value);
      index += 1;
      continue;
    }
    translated.push(arg);
  }
  return [...translated, ...(commandArgs.length ? ["--", ...commandArgs] : [])];
}

async function main(argv) {
  const command = argv.shift();
  if (command !== "npm" && command !== "npx") throw new Error("Expected npm or npx mode");
  const invocation = resolveBunPackageManagerInvocation(command, argv);
  if (Object.hasOwn(invocation, "stdout")) {
    process.stdout.write(invocation.stdout);
    return 0;
  }
  const child = spawn(invocation.file, invocation.args, {
    env: invocation.env,
    stdio: "inherit",
    shell: false,
  });
  return await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else resolvePromise(code ?? 1);
    });
  });
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
