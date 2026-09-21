import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

const MAX_LINE_LENGTH = 200;
const SOURCE_DIRECTORIES = ['console', 'db', 'engine', 'scripts', 'sdk', 'test'];
const STYLE_FILES = ['idl/event-log.schema.json'];
const TYPE_SCRIPT_EXTENSIONS = new Set(['.cts', '.mts', '.ts', '.tsx', '.mjs']);
// Generated protobuf stubs are exempt: protoc-gen-es owns their layout.
const EXCLUDED_DIRECTORIES = new Set(['sdk/typescript/gen', 'sdk/typescript/gen-health']);
// Installed and built output, wherever it sits. The console client keeps its own install, so a
// source directory can now contain one of these at any depth.
const EXCLUDED_NAMES = new Set(['node_modules', 'dist']);

async function listSourceFiles(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    const paths = await Promise.all(
        entries.map((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                return EXCLUDED_DIRECTORIES.has(path) || EXCLUDED_NAMES.has(entry.name) ? [] : listSourceFiles(path);
            }
            return TYPE_SCRIPT_EXTENSIONS.has(path.slice(path.lastIndexOf('.'))) ? [path] : [];
        }),
    );
    return paths.flat();
}

async function findLongLines(path) {
    const lines = (await readFile(path, 'utf8')).split('\n');
    return lines.flatMap((line, index) => (line.length > MAX_LINE_LENGTH ? [`${path}:${index + 1}: ${line.length} columns`] : []));
}

const sourceFiles = (await Promise.all(SOURCE_DIRECTORIES.map(listSourceFiles))).flat();
const checkedFiles = [...sourceFiles, ...STYLE_FILES];
const violations = (await Promise.all(checkedFiles.map(findLongLines))).flat();
if (violations.length > 0) {
    throw new Error(`Checked source lines must be at most ${MAX_LINE_LENGTH} columns:\n` + violations.join('\n'));
}
