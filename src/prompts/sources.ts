import type { SourceStatus, TargetInfo } from "../sources/index.js";

function renderTarget(target: TargetInfo): string[] {
  if (target.error) return [`  - target \`${target.ref}\`: ${target.error}, using the working copy`];

  const fetchNote = target.fetchError ? " (fetch failed, last known state)" : "";
  if (!target.ahead && !target.behind) return [`  - at target \`${target.resolved}\`${fetchNote}`];
  return [
    `  - **differs from target \`${target.resolved}\`** @ ${target.commit}${fetchNote} (${target.ahead} ahead, ${target.behind} behind): ` +
      `analyse the target via \`git show ${target.resolved}:<file>\` / \`git grep <pattern> ${target.resolved}\``,
  ];
}

function renderStatus(status: SourceStatus): string {
  const { source } = status;
  const description = source.description ? ` — ${source.description}` : "";
  const header = (path: string, kind: string) => `- **${source.name}** (${source.role}, ${kind}) \`${path}\`${description}`;

  switch (status.mode) {
    case "local": {
      const lines = [header(status.path, "local")];
      if (status.gitError) lines.push(`  - git state unavailable: ${status.gitError}`);
      if (status.git) {
        const dirty = status.git.dirtyFiles ? `, ${status.git.dirtyFiles} uncommitted` : "";
        lines.push(`  - on \`${status.git.branch}\`${dirty}`);
        if (status.git.target) lines.push(...renderTarget(status.git.target));
      }
      return lines.join("\n");
    }

    case "mirror": {
      const lines = [header(status.path, "read-only mirror")];
      const ref = source.ref ? `\`${source.ref}\`` : "default branch";
      if (status.pending) lines.push(`  - still syncing ${ref}; skip it if the path does not exist yet and say so`);
      else if (status.error) lines.push(`  - **unavailable**: ${status.error.replace(/\.+$/, "")}; skip it and say so`);
      else lines.push(`  - ${ref} @ ${status.commit}`);
      return lines.join("\n");
    }

    case "missing":
      return `- **${source.name}** (${source.role}) — **unavailable**: ${status.reason}; skip it and say so`;
  }
}

export function renderSources(statuses: SourceStatus[]): string {
  return statuses.map(renderStatus).join("\n");
}
