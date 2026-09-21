import {readdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

/** Reads every framework source file so the test can enforce its dependency boundary. */
async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, {withFileTypes: true});
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
        }),
    );
    return nested.flat();
}

describe('engine framework boundary', () => {
    it('does not import test mocks or name the e-commerce semantics owned by test/mocks', async () => {
        const files = await sourceFiles(resolve(process.cwd(), 'engine/src'));
        const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')));
        for (const content of contents) {
            expect(content).not.toMatch(/from ['"][^'"]*(domain|test\/mocks)\//);
            expect(content).not.toMatch(/\b(inventory|sku|carrier|payment|ecommerce)\b/i);
        }
    });

    it('keeps the console projection pure, which its own directory now makes checkable', async () => {
        // Design document 11 section 3.2 says the fold performs no I/O, reads no clock and queries
        // no projection table. That used to be a claim a reviewer had to verify by reading one
        // file's imports; grouping the pure modules under `projection/` turns it into something a
        // test can state. `reader.ts` holds the pool, `tail.ts` polls, and `pg` is the database —
        // an import of any of them from here is the gate failing.
        const files = await sourceFiles(resolve(process.cwd(), 'console/server/src/projection'));
        expect(files.length).toBeGreaterThan(1);
        for (const file of files) {
            const content = await readFile(file, 'utf8');
            expect(content, file).not.toMatch(/from ['"]pg['"]/);
            expect(content, file).not.toMatch(/from ['"][^'"]*(reader|tail|server|main)\.js['"]/);
            expect(content, file).not.toMatch(/from ['"]node:/);
        }
    });

    it('is never imported by the console, only the other way round', async () => {
        // The console consumes the engine. An import in this direction would make the core depend
        // on an operator surface, and the first thing to break would be every consumer of
        // `EventStore` paying for a projection it does not use.
        const files = await sourceFiles(resolve(process.cwd(), 'engine/src'));
        const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')));
        for (const content of contents) expect(content).not.toMatch(/from ['"][^'"]*console\//);
    });
});
