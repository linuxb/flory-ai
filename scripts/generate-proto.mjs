import {execFileSync} from 'node:child_process';
import {mkdtemp, readdir, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';

const check = process.argv.includes('--check');
const root = resolve(new URL('..', import.meta.url).pathname);
const goPlugins = [
    ['protoc-gen-go', 'google.golang.org/protobuf/cmd/protoc-gen-go'],
    ['protoc-gen-go-grpc', 'google.golang.org/grpc/cmd/protoc-gen-go-grpc'],
];

const typeScriptPlugin = {local: 'node_modules/.bin/protoc-gen-es', opt: ['target=ts', 'import_extension=.js']};

/**
 * The generation targets.
 *
 * The Flory contract is generated for both languages from one source, which is what keeps the two SDKs from drifting.
 * The vendored gRPC health protocol is TypeScript only: Go already has it from grpc-go, and generating a second copy
 * would give the Go side two conflicting definitions of one wire type.
 */
const TARGETS = [
    {input: 'idl/proto', outputs: ['gatewayd/internal/pb', 'sdk/typescript/gen'], go: 'gatewayd/internal/pb', typescript: 'sdk/typescript/gen'},
    {input: 'idl/proto-grpc-health', outputs: ['sdk/typescript/gen-health'], typescript: 'sdk/typescript/gen-health'},
];

/** Reports whether a filesystem path exists. */
async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Builds the protobuf plugins the gatewayd module pins in tools.go.
 *
 * They are compiled into gatewayd/bin rather than the user's GOPATH so a checkout regenerates identical stubs without
 * a global install step.
 */
async function ensureGoPlugins() {
    const binary = join(root, 'gatewayd', 'bin');
    const missing = [];
    for (const [name, pkg] of goPlugins) if (!(await exists(join(binary, name)))) missing.push(pkg);
    if (!missing.length) return;
    execFileSync('go', ['install', ...missing], {cwd: join(root, 'gatewayd'), env: {...process.env, GOBIN: binary}, stdio: 'inherit'});
}

/** Builds the buf template for one target, rooted at a destination prefix. */
function templateFor(target, prefix) {
    const plugins = [];
    if (target.go) {
        plugins.push({local: 'gatewayd/bin/protoc-gen-go', out: join(prefix, target.go), opt: 'paths=source_relative'});
        plugins.push({local: 'gatewayd/bin/protoc-gen-go-grpc', out: join(prefix, target.go), opt: 'paths=source_relative'});
    }
    if (target.typescript) plugins.push({...typeScriptPlugin, out: join(prefix, target.typescript)});
    return {version: 'v2', inputs: [{directory: target.input}], plugins};
}

function generate(target, prefix) {
    execFileSync(join(root, 'node_modules', '.bin', 'buf'), ['generate', '--template', JSON.stringify(templateFor(target, prefix))], {cwd: root, stdio: 'inherit'});
}

/** Recursively lists files under a directory, relative to it, sorted. */
async function listFiles(directory, prefix = '') {
    if (!(await exists(directory))) return [];
    const entries = await readdir(directory, {withFileTypes: true});
    const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? listFiles(join(directory, entry.name), join(prefix, entry.name)) : [join(prefix, entry.name)])));
    return nested.flat().sort();
}

/** Compares two generated trees and returns the paths that differ. */
async function diffTrees(expected, actual) {
    const [expectedFiles, actualFiles] = await Promise.all([listFiles(expected), listFiles(actual)]);
    const union = [...new Set([...expectedFiles, ...actualFiles])].sort();
    const differences = [];
    for (const file of union) {
        const [left, right] = await Promise.all([readFile(join(expected, file), 'utf8').catch(() => null), readFile(join(actual, file), 'utf8').catch(() => null)]);
        if (left !== right) differences.push(file);
    }
    return differences;
}

await ensureGoPlugins();

if (!check) {
    for (const target of TARGETS) {
        for (const output of target.outputs) await rm(join(root, output), {recursive: true, force: true});
        generate(target, '.');
    }
} else {
    const staging = await mkdtemp(join(tmpdir(), 'flory-proto-'));
    try {
        const prefix = relative(root, staging);
        const stale = [];
        for (const target of TARGETS) {
            generate(target, prefix);
            for (const output of target.outputs) stale.push(...(await diffTrees(join(root, output), join(staging, output))));
        }
        if (stale.length) throw new Error(`generated protobuf stubs are stale; run npm run generate:\n${stale.join('\n')}`);
    } finally {
        await rm(staging, {recursive: true, force: true});
    }
}
