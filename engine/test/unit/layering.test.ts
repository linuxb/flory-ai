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
});
