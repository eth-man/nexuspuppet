'use client';

import { useState } from 'react';
import { Bookmark, Check, Share2, Trash2, X } from 'lucide-react';
import type { SavedQuery, SavedQueryKind } from '@nexuspuppet/contracts';
import {
  useCreateSavedQuery,
  useDeleteSavedQuery,
  useSavedQueries,
  useUpdateSavedQuery,
} from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Save the filter you are looking at, and open one you kept (ADR-0026).
 *
 * ONE COMPONENT FOR BOTH SURFACES. A node filter and a resource filter are
 * different shapes but the same concept, so `kind` selects which — the
 * alternative is two lists, two sharing controls and two answers to every
 * question about ownership.
 *
 * The list arrives ALREADY FILTERED by permission. A shared resource query is
 * absent entirely for somebody without `resources:read`, because a name
 * discloses what its author is watching — and nothing here re-checks that,
 * because `can()` in the UI hides what a user cannot use and is never the
 * control (CLAUDE.md).
 */

export function SavedQueries<TFilter>({
  kind,
  currentFilter,
  onApply,
  canSave,
}: {
  kind: SavedQueryKind;
  /** The filter as it stands, or null when there is nothing worth saving. */
  currentFilter: TFilter | null;
  onApply: (filter: unknown) => void;
  /** False when the current filter is empty — saving "everything" helps nobody. */
  canSave: boolean;
}) {
  const queries = useSavedQueries();
  const create = useCreateSavedQuery();
  const update = useUpdateSavedQuery();
  const remove = useDeleteSavedQuery();

  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [shareOnSave, setShareOnSave] = useState(false);

  const mine = (queries.data ?? []).filter((q) => q.kind === kind);

  const save = () => {
    if (name.trim() === '' || currentFilter === null) return;
    create.mutate(
      {
        kind,
        name: name.trim(),
        // PRIVATE BY DEFAULT (§1). Sharing is a deliberate tick, never the
        // absence of one — a default that shared would make that decision by
        // omission, and it changes who can see what somebody is watching.
        isShared: shareOnSave,
        filter: currentFilter,
      } as never,
      {
        onSuccess: () => {
          setNaming(false);
          setName('');
          setShareOnSave(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {mine.map((query) => (
        <SavedQueryChip
          key={query.id}
          query={query}
          onApply={() => onApply(query.filter)}
          onToggleShare={() => update.mutate({ id: query.id, body: { isShared: !query.isShared } })}
          onDelete={() => remove.mutate(query.id)}
        />
      ))}

      {naming ? (
        <span className="flex items-center gap-1">
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
              if (event.key === 'Escape') setNaming(false);
            }}
            placeholder="Name this query…"
            className="h-7 w-48 text-xs"
            aria-label="Name for the saved query"
          />
          <label className="flex items-center gap-1 text-2xs text-ink-muted">
            <input
              type="checkbox"
              checked={shareOnSave}
              onChange={(event) => setShareOnSave(event.target.checked)}
            />
            Share
          </label>
          <Button variant="ghost" size="sm" onClick={save} disabled={name.trim() === ''}>
            <Check aria-hidden />
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setNaming(false)} aria-label="Cancel">
            <X aria-hidden />
          </Button>
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setNaming(true)}
          disabled={!canSave}
          title={canSave ? 'Save this filter' : 'Set a filter first'}
        >
          <Bookmark aria-hidden />
          Save this filter
        </Button>
      )}
    </div>
  );
}

function SavedQueryChip({
  query,
  onApply,
  onToggleShare,
  onDelete,
}: {
  query: SavedQuery;
  onApply: () => void;
  onToggleShare: () => void;
  onDelete: () => void;
}) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs',
        query.isShared ? 'border-accent/40 bg-accent/5' : 'border-line',
      )}
    >
      <button type="button" onClick={onApply} className="font-medium hover:underline">
        {query.name}
      </button>

      {/* WHOSE IT IS, shown only when it is not yours. Two people may both have
          "Ubuntu boxes" — names are unique per owner, not globally, so without
          this the list has two identical chips (§6). */}
      {!query.isMine && <span className="text-ink-faint">· {query.ownerEmail}</span>}

      {query.isMine && (
        <>
          <button
            type="button"
            onClick={onToggleShare}
            title={query.isShared ? 'Shared — click to make private' : 'Private — click to share'}
            aria-label={query.isShared ? 'Make private' : 'Share'}
            className={cn('hover:text-ink', query.isShared ? 'text-accent' : 'text-ink-faint')}
          >
            <Share2 className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${query.name}`}
            className="text-ink-faint hover:text-critical"
          >
            <Trash2 className="size-3" aria-hidden />
          </button>
        </>
      )}
    </span>
  );
}
