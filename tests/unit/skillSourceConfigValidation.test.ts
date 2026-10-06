import { describe, expect, it } from "vitest";
import { skillSourceDiscoverySchema, skillSourceSchema } from "../../src/admin/adminProjectsShared.js";
import { gerritConfigSchema, gerritDescriptor } from "../../src/plugins/descriptors/gerrit.js";

describe("SSH configuration validation", () => {
  it("keeps known_hosts optional for SSH skill sources in save and discovery", () => {
    expect(skillSourceSchema.safeParse({ source: "host.example:repo", installAll: true }).success).toBe(true);
    expect(skillSourceDiscoverySchema.safeParse({ source: "ssh://host.example/repo" }).success).toBe(true);
  });

  it("keeps known_hosts optional for Gerrit configuration", () => {
    expect(gerritDescriptor.requiredFields.find((field) => field.key === "sshKnownHostsPath")?.required).toBe(false);
    expect(gerritConfigSchema.safeParse({ sshHost: "gerrit.example", sshUser: "git" }).success).toBe(true);
  });
});
