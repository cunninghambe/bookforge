"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Amendment A16: the home Books page grouped by series. Each series heading
// carries a quiet rename affordance; under each series a calm "New book" form
// appends a book; at the bottom a "New series" form creates a series (which
// copies the seed style rules and creates its first book). Book titles are
// renameable inline. After every mutation the server component re-renders via
// router.refresh(), so the grouped data stays the source of truth.

interface Book {
  id: number;
  title: string;
}
interface SeriesGroup {
  id: number;
  title: string;
  books: Book[];
}

export function BooksManager({ series }: { series: SeriesGroup[] }) {
  const router = useRouter();
  const [creatingSeries, setCreatingSeries] = useState(false);

  return (
    <div>
      <ul className="mt-4 space-y-8" data-testid="book-list">
        {series.map((s) => (
          <SeriesSection key={s.id} series={s} onChanged={() => router.refresh()} />
        ))}
      </ul>

      <div className="mt-10 border-t border-edge-soft pt-4">
        {!creatingSeries ? (
          <button
            data-testid="new-series-toggle"
            onClick={() => setCreatingSeries(true)}
            className="text-sm text-muted hover:underline"
          >
            + New series
          </button>
        ) : (
          <NewSeriesForm
            onCancel={() => setCreatingSeries(false)}
            onCreated={() => {
              setCreatingSeries(false);
              router.refresh();
            }}
          />
        )}
      </div>
    </div>
  );
}

function SeriesSection({
  series,
  onChanged,
}: {
  series: SeriesGroup;
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(series.title);
  const [busy, setBusy] = useState(false);

  async function saveTitle() {
    const next = title.trim();
    if (!next || next === series.title) {
      setRenaming(false);
      setTitle(series.title);
      return;
    }
    setBusy(true);
    await fetch(`/api/series/${series.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    setBusy(false);
    setRenaming(false);
    onChanged();
  }

  return (
    <li data-testid="series-group" data-series-id={series.id}>
      <div className="flex flex-wrap items-baseline gap-2 border-b border-edge-soft pb-1">
        {renaming ? (
          <div className="flex items-center gap-2">
            <input
              aria-label="Series title"
              data-testid="series-rename-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded border border-edge px-2 py-1 text-sm text-ink"
            />
            <button
              data-testid="series-rename-save"
              disabled={busy}
              onClick={saveTitle}
              className="btn-secondary px-2 py-1 text-xs"
            >
              Save
            </button>
            <button
              onClick={() => {
                setTitle(series.title);
                setRenaming(false);
              }}
              className="btn-quiet px-2 py-1 text-xs"
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <h2
              data-testid="series-title"
              className="font-serif text-lg text-ink"
            >
              {series.title}
            </h2>
            <button
              data-testid="series-rename"
              onClick={() => setRenaming(true)}
              className="text-xs text-muted hover:underline"
            >
              Rename
            </button>
          </>
        )}
      </div>

      <ul className="mt-3 space-y-2" data-testid="series-books">
        {series.books.length === 0 && (
          <li className="text-sm text-faint">No books yet in this series.</li>
        )}
        {series.books.map((b) => (
          <BookRow key={b.id} book={b} onChanged={onChanged} />
        ))}
      </ul>

      <NewBookForm seriesId={series.id} onCreated={onChanged} />
    </li>
  );
}

function BookRow({ book, onChanged }: { book: Book; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(book.title);
  const [busy, setBusy] = useState(false);

  async function saveTitle() {
    const next = title.trim();
    if (!next || next === book.title) {
      setRenaming(false);
      setTitle(book.title);
      return;
    }
    setBusy(true);
    await fetch(`/api/projects/${book.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    setBusy(false);
    setRenaming(false);
    onChanged();
  }

  return (
    <li
      data-testid="book-row"
      data-project-id={book.id}
      className="flex flex-wrap items-center gap-3"
    >
      {renaming ? (
        <div className="flex items-center gap-2">
          <input
            aria-label="Book title"
            data-testid="book-rename-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded border border-edge px-2 py-1 text-sm text-ink"
          />
          <button
            data-testid="book-rename-save"
            disabled={busy}
            onClick={saveTitle}
            className="btn-secondary px-2 py-1 text-xs"
          >
            Save
          </button>
          <button
            onClick={() => {
              setTitle(book.title);
              setRenaming(false);
            }}
            className="btn-quiet px-2 py-1 text-xs"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <Link
            href={`/book/${book.id}`}
            data-testid="book-link"
            className="text-lg text-ink hover:underline"
          >
            {book.title}
          </Link>
          <button
            data-testid="book-rename"
            onClick={() => setRenaming(true)}
            className="text-xs text-muted hover:underline"
          >
            Rename
          </button>
        </>
      )}
    </li>
  );
}

function NewBookForm({
  seriesId,
  onCreated,
}: {
  seriesId: number;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = title.trim();
    if (!next) return;
    setBusy(true);
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next, seriesId }),
    });
    setBusy(false);
    setTitle("");
    onCreated();
  }

  return (
    <form
      onSubmit={submit}
      data-testid="new-book-form"
      className="mt-3 flex flex-wrap items-center gap-2"
    >
      <input
        aria-label="New book title"
        data-testid="new-book-title"
        placeholder="New book title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="min-w-[16rem] rounded border border-edge px-2 py-1 text-sm text-ink"
      />
      <button
        type="submit"
        data-testid="new-book-submit"
        disabled={busy || title.trim().length === 0}
        className="btn-secondary px-3 py-1 text-sm"
      >
        New book
      </button>
    </form>
  );
}

function NewSeriesForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = title.trim();
    if (!next) return;
    setBusy(true);
    await fetch("/api/series", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    setBusy(false);
    setTitle("");
    onCreated();
  }

  return (
    <form
      onSubmit={submit}
      data-testid="new-series-form"
      className="flex flex-wrap items-center gap-2"
    >
      <input
        aria-label="New series title"
        data-testid="new-series-title"
        placeholder="New series title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="min-w-[16rem] rounded border border-edge px-2 py-1 text-sm text-ink"
      />
      <button
        type="submit"
        data-testid="new-series-submit"
        disabled={busy || title.trim().length === 0}
        className="btn-primary px-3 py-1 text-sm"
      >
        Create series
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="btn-quiet px-2 py-1 text-sm"
      >
        Cancel
      </button>
    </form>
  );
}
