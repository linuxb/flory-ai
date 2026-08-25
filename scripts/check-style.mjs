import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

const MAX_LINE_LENGTH = 200;
const SOURCE_DIRECTORIES = ['db', 'engine', 'scripts', 'sdk', 'test'];
const STYLE_FILES = ['idl/event-log.schema.json'];
const TYPE_SCRIPT_EXTENSIONS = new Set(['.cts', '.mts', '.ts', '.mjs']);
// Generated protobuf stubs are exempt: protoc-gen-es owns their layout.
const EXCLUDED_DIRECTORIES = new Set(['sdk/typescript/gen']);

async function listSourceFiles(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    const paths = await Promise.all(
        entries.map((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                return EXCLUDED_DIRECTORIES.has(path) ? [] : listSourceFiles(path);
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
