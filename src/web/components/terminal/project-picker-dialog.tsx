import { useEffect, useRef, useState } from "react";
import { Folder, Loader2 } from "lucide-react";

import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

type ProjectPickerInfoResponse = {
  defaultPath: string;
};

type ProjectPickerSuggestion = {
  path: string;
  name: string;
  score: number;
};

type ProjectPickerSuggestionsResponse = {
  query: string;
  basePath: string | null;
  suggestions: ProjectPickerSuggestion[];
};

async function fetchProjectPickerInfo() {
  const response = await fetch("/api/projects/picker");
  if (!response.ok) {
    throw new Error(`project picker info request failed with ${response.status}`);
  }

  return (await response.json()) as ProjectPickerInfoResponse;
}

async function fetchProjectPickerSuggestions(query: string) {
  const response = await fetch(`/api/projects/picker/suggest?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    throw new Error(`project picker suggestions request failed with ${response.status}`);
  }

  return (await response.json()) as ProjectPickerSuggestionsResponse;
}

export interface ProjectPickerDialogProps {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  pending?: boolean;
  initialPath?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (path: string) => Promise<void> | void;
}

export function ProjectPickerDialog({
  open,
  title,
  description,
  submitLabel,
  pending = false,
  initialPath,
  onOpenChange,
  onSubmit,
}: ProjectPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ProjectPickerSuggestion[]>([]);
  const [basePath, setBasePath] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const requestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSuggestions([]);
      setBasePath(null);
      setLoadError(null);
      setHighlightedIndex(-1);
      setIsBootstrapping(false);
      setIsLoadingSuggestions(false);
      setIsSubmitting(false);
      return;
    }

    let cancelled = false;
    setIsBootstrapping(true);
    setLoadError(null);

    void fetchProjectPickerInfo()
      .then((info) => {
        if (cancelled) {
          return;
        }

        const seededPath = initialPath?.trim() ? initialPath.trim() : info.defaultPath;
        setQuery(seededPath);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [initialPath, open]);

  useEffect(() => {
    if (!open || !query.trim()) {
      setSuggestions([]);
      setBasePath(null);
      setHighlightedIndex(-1);
      return;
    }

    const requestId = ++requestIdRef.current;
    const timeout = window.setTimeout(() => {
      setIsLoadingSuggestions(true);

      void fetchProjectPickerSuggestions(query)
        .then((payload) => {
          if (requestId !== requestIdRef.current) {
            return;
          }

          setSuggestions(payload.suggestions);
          setBasePath(payload.basePath);
          setHighlightedIndex(payload.suggestions.length > 0 ? 0 : -1);
          setLoadError(null);
        })
        .catch((error) => {
          if (requestId !== requestIdRef.current) {
            return;
          }

          setSuggestions([]);
          setBasePath(null);
          setHighlightedIndex(-1);
          setLoadError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setIsLoadingSuggestions(false);
          }
        });
    }, 120);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [open, query]);

  useEffect(() => {
    if (!open || isBootstrapping) {
      return;
    }

    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(query.length, query.length);
    }, 0);
  }, [isBootstrapping, open, query]);

  const effectivePending = pending || isSubmitting;
  const highlightedSuggestion = highlightedIndex >= 0 ? suggestions[highlightedIndex] ?? null : null;

  const submitPath = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || effectivePending) {
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(trimmed);
    } catch {
      // Submission errors are surfaced by the caller.
    } finally {
      setIsSubmitting(false);
    }
  };

  const applySuggestionPath = (path: string, index: number) => {
    setQuery(path);
    setHighlightedIndex(index);
    inputRef.current?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-border/80 bg-card/95 p-0 shadow-2xl backdrop-blur-sm">
        <DialogHeader className="border-b border-border/70 px-5 pb-3 pt-5">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Absolute path</p>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  if (suggestions.length === 0) {
                    return;
                  }
                  event.preventDefault();
                  setHighlightedIndex((current) => (current + 1 >= suggestions.length ? 0 : current + 1));
                  return;
                }

                if (event.key === "ArrowUp") {
                  if (suggestions.length === 0) {
                    return;
                  }
                  event.preventDefault();
                  setHighlightedIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
                  return;
                }

                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitPath(highlightedSuggestion?.path ?? query);
                }
              }}
              placeholder="/absolute/path/to/project"
              disabled={effectivePending || isBootstrapping}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-muted-foreground">
              <span className="truncate">{basePath ? `Browsing ${basePath}` : "Type an absolute path to browse directories"}</span>
              {isBootstrapping || isLoadingSuggestions ? (
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  searching
                </span>
              ) : null}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-background/70 p-2">
            {loadError ? (
              <p className="px-2 py-6 font-mono text-xs text-destructive">{loadError}</p>
            ) : suggestions.length === 0 ? (
              <p className="px-2 py-6 font-mono text-xs text-muted-foreground">
                {query.trim() ? "No matching directories found." : "Enter an absolute path to start browsing."}
              </p>
            ) : (
              <div className="space-y-1">
                {suggestions.map((suggestion, index) => {
                  const highlighted = index === highlightedIndex;

                  return (
                    <button
                      key={suggestion.path}
                      type="button"
                      className={`flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left ${
                        highlighted ? "border-primary/40 bg-primary/10" : "border-transparent hover:border-border hover:bg-card/70"
                      }`}
                      onMouseEnter={() => {
                        setHighlightedIndex(index);
                      }}
                      onClick={() => {
                        applySuggestionPath(suggestion.path, index);
                      }}
                      disabled={effectivePending}
                    >
                      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card/80 text-muted-foreground">
                        <Folder className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-xs font-semibold text-foreground">{suggestion.name}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{suggestion.path}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-[11px] text-muted-foreground">
              Click a directory to fill the path, then use the select action to confirm it.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                }}
                disabled={effectivePending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  void submitPath(highlightedSuggestion?.path ?? query);
                }}
                disabled={effectivePending || !query.trim()}
              >
                {effectivePending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {submitLabel}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
