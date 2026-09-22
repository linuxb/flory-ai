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

    it('does not let this suite run the client package, which it cannot install', async () => {
        // Two installs, two jobs, and only one of them is the client's. Vitest's default include
        // sweeps `console/client/src/test` into this suite, which passed for as long as a
        // developer's machine happened to have both `node_modules` trees — and failed the moment a
        // client test imported a client-only package, in the job that installs the root and
        // nothing else. Asserted here so the exclusion is a stated boundary rather than a line
        // someone tidies away.
        const config = await readFile(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');
        expect(config).toMatch(/exclude:.*'console\/client\/\*\*'/);
    });

    it('keeps the type leaf the browser imports free of anything with a runtime', async () => {
        // The client typechecks with only its own `node_modules`, and `tsc` follows an
        // `import type` into the imported file and typechecks that too. So one bare specifier
        // anywhere in this closure breaks a build that installs neither `ajv` nor Node's types.
        //
        // It did. `detail.ts` imported `StoredEvent` from the engine's event module, which loads a
        // JSON schema with `node:fs` and validates it with `ajv`, and the console-client job
        // failed on five consecutive pushes before anyone looked at it.
        const root = resolve(process.cwd(), 'console/server/src/projection/model.ts');
        const seen = new Set<string>();
        const offences: string[] = [];
        const visit = async (file: string): Promise<void> => {
            if (seen.has(file)) return;
            seen.add(file);
            const content = await readFile(file, 'utf8');
            for (const match of content.matchAll(/from ['"]([^'"]+)['"]/g)) {
                const specifier = match[1]!;
                if (!specifier.startsWith('.')) {
                    offences.push(`${file.slice(process.cwd().length + 1)} imports ${specifier}`);
                    continue;
                }
                await visit(resolve(file, '..', specifier.replace(/\.js$/, '.ts')));
            }
        };
        await visit(root);

        expect(offences).toEqual([]);
        // And the closure is small enough to state, so growing it is a deliberate act.
        expect([...seen].map((file) => file.slice(process.cwd().length + 1)).sort()).toEqual(['console/server/src/projection/model.ts', 'engine/src/admission/check-rules.ts']);
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
