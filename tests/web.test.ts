import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIndex } from '../src/bookmarks-db.js';
import { createWebServer } from '../src/web.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURES = [
    {
        id: '1', tweetId: '1',
        url: 'https://x.com/alice/status/1',
        text: 'Machine learning is transforming healthcare and AI research',
        authorHandle: 'alice', authorName: 'Alice Smith',
        postedAt: 'Mon Jan 06 12:00:00 +0000 2025',
        bookmarkedAt: '2025-01-07T08:00:00Z',
        syncedAt: '2025-01-07T08:00:00Z',
        language: 'en', mediaObjects: [], links: ['https://example.com'],
        tags: [], ingestedVia: 'graphql',
    },
    {
        id: '2', tweetId: '2',
        url: 'https://x.com/bob/status/2',
        text: 'Rust is a great systems programming language for safety',
        authorHandle: 'bob', authorName: 'Bob Jones',
        postedAt: 'Tue Feb 04 14:30:00 +0000 2025',
        bookmarkedAt: '2025-02-05T10:00:00Z',
        syncedAt: '2025-02-05T10:00:00Z',
        language: 'en', mediaObjects: [], links: [],
        tags: [], ingestedVia: 'graphql',
    },
    {
        id: '3', tweetId: '3',
        url: 'https://x.com/alice/status/3',
        text: 'Deep learning models need massive compute infrastructure and optimization techniques',
        authorHandle: 'alice', authorName: 'Alice Smith',
        postedAt: 'Wed Mar 05 09:15:00 +0000 2025',
        bookmarkedAt: '2025-03-06T07:00:00Z',
        syncedAt: '2025-03-06T07:00:00Z',
        language: 'en',
        media: ['https://img.example.com/1.jpg'],
        mediaObjects: [],
        links: [], tags: [], ingestedVia: 'graphql',
    },
];

// ── Test helper ───────────────────────────────────────────────────────────────

async function withWebServer(
    records: unknown[],
    fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ft-web-test-'));
    const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(path.join(dir, 'bookmarks.jsonl'), jsonl);

    const savedDir = process.env.FT_DATA_DIR;
    process.env.FT_DATA_DIR = dir;

    let close: (() => Promise<void>) | undefined;
    try {
        await buildIndex({ force: true });
        const server = await createWebServer(0); // port 0 = OS picks a free port
        close = server.close;
        await fn(`http://127.0.0.1:${server.port}`);
    } finally {
        await close?.();
        if (savedDir !== undefined) process.env.FT_DATA_DIR = savedDir;
        else delete process.env.FT_DATA_DIR;
        rmSync(dir, { recursive: true, force: true });
    }
}

// ── HTML shell ────────────────────────────────────────────────────────────────

test('GET / returns HTML shell', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /text\/html/);
        const body = await res.text();
        assert.match(body, /<!DOCTYPE html>/i);
        assert.match(body, /Field Theory/);
        assert.match(body, /alpinejs/);
        assert.match(body, /chart\.js/);
    });
});

// ── /api/overview ─────────────────────────────────────────────────────────────

test('GET /api/overview returns VizData JSON', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/overview`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /application\/json/);

        const data = await res.json() as Record<string, unknown>;
        assert.equal(data.total, 3);
        assert.equal(data.uniqueAuthors, 2);
        assert.ok(Array.isArray(data.topAuthors), 'topAuthors should be an array');
        assert.ok(Array.isArray(data.monthlyActivity), 'monthlyActivity should be an array');
        assert.ok(Array.isArray(data.dayOfWeekActivity), 'dayOfWeekActivity should be an array');
        assert.ok(Array.isArray(data.hourActivity), 'hourActivity should be an array');
        assert.ok(Array.isArray(data.languages), 'languages should be an array');
        assert.ok(typeof (data.dateRange as Record<string, unknown>)?.earliest === 'string');
        assert.ok(typeof (data.dateRange as Record<string, unknown>)?.latest === 'string');
        assert.ok(typeof (data.mediaStats as Record<string, unknown>)?.total === 'number');
    });
});

test('GET /api/overview top authors reflect bookmark counts', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const data = await fetch(`${base}/api/overview`).then((r) => r.json()) as Record<string, unknown>;
        const topAuthors = data.topAuthors as { handle: string; count: number }[];
        const alice = topAuthors.find((a) => a.handle === 'alice');
        const bob = topAuthors.find((a) => a.handle === 'bob');
        assert.ok(alice, 'alice should appear in topAuthors');
        assert.equal(alice!.count, 2);
        assert.ok(bob, 'bob should appear in topAuthors');
        assert.equal(bob!.count, 1);
    });
});

// ── /api/bookmarks ────────────────────────────────────────────────────────────

test('GET /api/bookmarks returns all bookmarks', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/bookmarks`);
        assert.equal(res.status, 200);
        const items = await res.json() as unknown[];
        assert.equal(items.length, 3);
    });
});

test('GET /api/bookmarks?limit=1 returns exactly 1 item', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/bookmarks?limit=1`);
        const items = await res.json() as unknown[];
        assert.equal(items.length, 1);
    });
});

test('GET /api/bookmarks?limit=999 is capped at the result set size', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/bookmarks?limit=999`);
        const items = await res.json() as unknown[];
        assert.equal(items.length, 3); // only 3 in DB
    });
});

test('GET /api/bookmarks?author=alice returns only alice bookmarks', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/bookmarks?author=alice`);
        const items = await res.json() as { authorHandle: string }[];
        assert.ok(items.length > 0);
        for (const item of items) {
            assert.equal(item.authorHandle, 'alice');
        }
    });
});

test('GET /api/bookmarks?q= full-text search filters results', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/bookmarks?q=Rust`);
        const items = await res.json() as { authorHandle: string }[];
        assert.equal(items.length, 1);
        assert.equal(items[0].authorHandle, 'bob');
    });
});

test('GET /api/bookmarks?sort=asc returns oldest first', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const items = await fetch(`${base}/api/bookmarks?sort=asc`).then((r) => r.json()) as { id: string }[];
        assert.equal(items[0].id, '1');
    });
});

test('GET /api/bookmarks?sort=desc returns newest first', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const items = await fetch(`${base}/api/bookmarks?sort=desc`).then((r) => r.json()) as { id: string }[];
        assert.equal(items[0].id, '3');
    });
});

test('GET /api/bookmarks?offset=2 returns last bookmark', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const items = await fetch(`${base}/api/bookmarks?sort=asc&offset=2`).then((r) => r.json()) as unknown[];
        assert.equal(items.length, 1);
    });
});

// ── /api/count ────────────────────────────────────────────────────────────────

test('GET /api/count returns total count', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/count`);
        assert.equal(res.status, 200);
        const data = await res.json() as { count: number };
        assert.equal(data.count, 3);
    });
});

test('GET /api/count?author=alice returns filtered count', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const data = await fetch(`${base}/api/count?author=alice`).then((r) => r.json()) as { count: number };
        assert.equal(data.count, 2);
    });
});

// ── /api/bookmarks/:id ────────────────────────────────────────────────────────

test('GET /api/bookmarks/:id returns a single bookmark', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/bookmarks/1`);
        assert.equal(res.status, 200);
        const item = await res.json() as { id: string; authorHandle: string };
        assert.equal(item.id, '1');
        assert.equal(item.authorHandle, 'alice');
    });
});

test('GET /api/bookmarks/:id returns 404 for unknown id', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/bookmarks/does-not-exist`);
        assert.equal(res.status, 404);
        const data = await res.json() as { error: string };
        assert.ok(data.error);
    });
});

// ── Error handling ────────────────────────────────────────────────────────────

test('POST / returns 405 method not allowed', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/`, { method: 'POST' });
        assert.equal(res.status, 405);
    });
});

test('GET /unknown-route returns 404', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/unknown-route`);
        assert.equal(res.status, 404);
    });
});

test('GET /api/unknown returns 404', async () => {
    await withWebServer(FIXTURES, async (base) => {
        const res = await fetch(`${base}/api/unknown`);
        assert.equal(res.status, 404);
    });
});
