import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_DATABASE_PATH = "./data/virtual-engineer.db";

/**
 * Orchestrator-managed known_hosts file used when no trusted file is configured.
 * It lives next to the database so first-seen host keys persist across restarts.
 */
export function managedKnownHostsPath(): string {
  const databasePath = process.env["DATABASE_PATH"]?.trim() || DEFAULT_DATABASE_PATH;
  return join(resolve(dirname(databasePath)), "ssh", "known_hosts");
}

export interface SshHostKeyPolicy {
  strictHostKeyChecking: "yes" | "accept-new";
  knownHostsPath: string;
}

/**
 * Resolve host-key verification for an SSH connection. A configured known_hosts
 * file is enforced strictly; otherwise trust-on-first-use records the server key
 * in the managed file and rejects later key changes.
 */
export function resolveSshHostKeyPolicy(configuredKnownHostsPath?: string | null): SshHostKeyPolicy {
  const configured = configuredKnownHostsPath?.trim();
  if (configured) return { strictHostKeyChecking: "yes", knownHostsPath: configured };
  const knownHostsPath = managedKnownHostsPath();
  mkdirSync(dirname(knownHostsPath), { recursive: true, mode: 0o700 });
  return { strictHostKeyChecking: "accept-new", knownHostsPath };
}

/** SSH `-o` argv for the resolved host-key policy. */
export function sshHostKeyArgs(configuredKnownHostsPath?: string | null): string[] {
  const policy = resolveSshHostKeyPolicy(configuredKnownHostsPath);
  return [
    "-o", `StrictHostKeyChecking=${policy.strictHostKeyChecking}`,
    "-o", `UserKnownHostsFile=${policy.knownHostsPath}`,
  ];
}
