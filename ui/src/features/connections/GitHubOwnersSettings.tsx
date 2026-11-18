import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { connectionInstructionsConfig, type ToolConnection } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { projectsApi } from "@/api/projects";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineBanner } from "@/components/InlineBanner";
import { repositoryOptionsKey } from "@/components/ProjectRepositoryInput";

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

/** Same normalization the server applies: lower-case logins, `*` for the default. */
export function parseGitHubOwners(value: string): { owners: string[]; invalid: string[] } {
  const owners: string[] = [];
  const invalid: string[] = [];
  for (const raw of value.split(/[\s,;]+/)) {
    const entry = raw.trim().replace(/^@/, "").toLowerCase();
    if (!entry) continue;
    if (entry !== "*" && !OWNER.test(entry)) invalid.push(raw.trim());
    else if (!owners.includes(entry)) owners.push(entry);
  }
  return { owners, invalid };
}

/** Which repository owners a GitHub connection handles when several GitHub accounts are connected. */
export function GitHubOwnersSettings({ connection, canConfigure }: { connection: ToolConnection; canConfigure: boolean }) {
  const id = useId();
  const client = useQueryClient();
  const connectionConfig = connectionInstructionsConfig(connection);
  const methodConfig = (connectionConfig.methodConfig ?? {}) as Record<string, unknown>;
  const saved = typeof methodConfig.githubOwners === "string" ? methodConfig.githubOwners : "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const parsed = parseGitHubOwners(value);
  const repositories = useQuery({
    queryKey: repositoryOptionsKey(connection.companyId),
    queryFn: () => projectsApi.repositoryOptions(connection.companyId),
    staleTime: 30_000,
  });
  const detected = useMemo(() => {
    const owners = new Set<string>();
    for (const repository of repositories.data?.repositories ?? []) {
      if (!repository.connectionIds?.includes(connection.id)) continue;
      const owner = repository.fullName.split("/")[0]?.toLowerCase();
      if (owner) owners.add(owner);
    }
    return [...owners].sort();
  }, [connection.id, repositories.data]);
  const mutation = useMutation({
    mutationFn: () => toolsApi.updateConnection(connection.id, {
      config: { ...connectionConfig, methodConfig: { ...methodConfig, githubOwners: parsed.owners.join(", ") } },
    }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["tools"] });
      setDraft(null);
    },
  });
  const changed = draft !== null && parseGitHubOwners(draft).owners.join(",") !== parseGitHubOwners(saved).owners.join(",");
  return <section className="space-y-3" aria-label="Responsible GitHub owners">
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">Responsible GitHub owners</label>
      <p className="text-xs text-muted-foreground">
        When more than one GitHub account is connected, Paperclip sends each repository operation to the connection
        that lists the repository's owner (a user or organization). Operations for an owner no connection lists fail
        with an error instead of using another account. Add <code>*</code> to make this connection the default for
        operations that name no owner. When empty, Paperclip uses the owners this connection's GitHub access lists.
      </p>
    </div>
    <Input
      id={id}
      value={value}
      maxLength={2000}
      disabled={!canConfigure || mutation.isPending}
      placeholder="byhashdong, my-organization"
      onChange={(event) => setDraft(event.target.value)}
    />
    {detected.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Owners this connection can access: {detected.join(", ")}</span>
      {canConfigure && <Button variant="ghost" size="xs" disabled={mutation.isPending} onClick={() => setDraft(detected.join(", "))}>
        Use detected owners
      </Button>}
    </div>}
    {parsed.invalid.length > 0 && <InlineBanner tone="warning">
      Not valid GitHub owners: {parsed.invalid.join(", ")}
    </InlineBanner>}
    {mutation.error && <div role="alert"><InlineBanner tone="danger">{describeError(mutation.error).body}</InlineBanner></div>}
    {changed && <div className="flex items-center justify-between">
      <Button variant="ghost" disabled={mutation.isPending} onClick={() => { setDraft(null); mutation.reset(); }}>Cancel</Button>
      <Button disabled={!canConfigure || mutation.isPending || parsed.invalid.length > 0} onClick={() => mutation.mutate()}>
        {mutation.isPending ? "Saving…" : "Save owners"}
      </Button>
    </div>}
  </section>;
}
