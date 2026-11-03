import type { SourceStatus, TargetInfo } from "../sources/index.js";

function renderTarget(path: string, target: TargetInfo): string[] {
  if (target.error) {
    return [`  - Target ref \`${target.ref}\`: ${target.error}. Analyse the working copy and mention this.`];
  }

  const lines: string[] = [];
  const fetchNote = target.fetchError ? ` (fetch failed, using the last known state: ${target.fetchError})` : "";
  lines.push(`  - Target ref (tested version): \`${target.resolved}\` @ ${target.commit}${fetchNote}`);

  if (!target.ahead && !target.behind) {
    lines.push("  - The working copy is at the target ref: read files directly.");
  } else {
    lines.push(
      `  - **The working copy differs from the target ref** (${target.ahead} commit(s) ahead, ${target.behind} behind). ` +
        `Analyse the target ref, not the working copy: \`git -C ${path} show ${target.resolved}:<file>\`, ` +
        `\`git -C ${path} grep <pattern> ${target.resolved}\`, \`git -C ${path} log ${target.resolved} -- <file>\`. ` +
        "Mention if the working copy already contains relevant changes.",
    );
  }
  return lines;
}

function renderStatus(status: SourceStatus): string {
  const { source } = status;
  const description = source.description ? ` — ${source.description}` : "";
  const header = (path: string, kind: string) => `- **${source.name}** [${source.role}] \`${path}\` (${kind})${description}`;

  switch (status.mode) {
    case "local": {
      const lines = [header(status.path, "local working copy")];
      if (status.notGit) lines.push("  - Not a git repository: read files directly.");
      if (status.gitError) lines.push(`  - Could not read git state (${status.gitError}): read files directly.`);
      if (status.git) {
        const dirty = status.git.dirtyFiles ? `, ${status.git.dirtyFiles} uncommitted change(s)` : "";
        lines.push(`  - Checked out: \`${status.git.branch}\` @ ${status.git.head}${dirty}`);
        if (status.git.target) lines.push(...renderTarget(status.path, status.git.target));
      }
      return lines.join("\n");
    }

    case "mirror": {
      const lines = [header(status.path, "read-only mirror")];
      const ref = source.ref ? `\`${source.ref}\`` : "the default branch";
      if (status.pending) {
        lines.push(
          `  - Still syncing ${ref} (a first clone can take a few minutes). Check whether the path exists; if not, ` +
            "continue without it and tell the user to run the prompt again later.",
        );
      } else if (status.error) {
        lines.push(`  - **Not available**: ${status.error.replace(/\.+$/, "")}. Continue without it and mention this.`);
      } else {
        lines.push(`  - Mirror of ${ref} @ ${status.commit}, synced ${status.syncedAt?.toISOString()}.`);
      }
      lines.push(
        "  - Never modify this directory. For Phase 3, ask the user to clone the repository into a working copy " +
          `(\`git clone ${source.remote!.cloneUrl}\`) and implement the fix there.`,
      );
      return lines.join("\n");
    }

    case "missing":
      return `- **${source.name}** [${source.role}]${description} — **not available**: ${status.reason}. Skip it and mention this.`;
  }
}

export function renderSources(statuses: SourceStatus[]): string {
  return statuses.map(renderStatus).join("\n");
}
