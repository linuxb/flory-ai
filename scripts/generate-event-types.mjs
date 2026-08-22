import {readFile, writeFile} from 'node:fs/promises';

const check = process.argv.includes('--check');
const schema = JSON.parse(await readFile(new URL('../idl/event-log.schema.json', import.meta.url)));
const eventTypes = schema.allOf[0].if.properties.event_type.not.enum;
const ts =
    [
        '// Generated from idl/event-log.schema.json. Do not edit.',
        'export const EVENT_TYPES = [',
        ...eventTypes.map((eventType) => `    '${eventType}',`),
        '] as const;',
        'export type EventType = (typeof EVENT_TYPES)[number];',
        "export type FoldMode = 'recorded' | 'model-live' | 'reads-live';",
        'export interface ForkSubstitution {',
        '    stream_seq: number;',
        '    pin_version: string;',
        '}',
        'export interface ForkRequest {',
        '    source_run_id: string;',
        '    at_stream_seq: number;',
        '    substitutions: ForkSubstitution[];',
        '    fold_mode: FoldMode;',
        '    evaluator_pin: string;',
        '    projector_version: string;',
        '    harness_state_version: string;',
        '}',
    ].join('\n') + '\n';
const go =
    [
        '// Code generated from idl/event-log.schema.json; DO NOT EDIT.',
        'package generated',
        '',
        'type FoldMode string',
        '',
        'const (',
        '\tFoldModeRecorded  FoldMode = "recorded"',
        '\tFoldModeModelLive FoldMode = "model-live"',
        '\tFoldModeReadsLive FoldMode = "reads-live"',
        ')',
        '',
        'type ForkSubstitution struct {',
        '\tStreamSeq  int64  `json:"stream_seq"`',
        '\tPinVersion string `json:"pin_version"`',
        '}',
        '',
        'type ForkRequest struct {',
        '\tSourceRunID         string             `json:"source_run_id"`',
        '\tAtStreamSeq         int64              `json:"at_stream_seq"`',
        '\tSubstitutions       []ForkSubstitution `json:"substitutions"`',
        '\tFoldMode            FoldMode           `json:"fold_mode"`',
        '\tEvaluatorPin        string             `json:"evaluator_pin"`',
        '\tProjectorVersion    string             `json:"projector_version"`',
        '\tHarnessStateVersion string             `json:"harness_state_version"`',
        '}',
    ].join('\n') + '\n';
const outputs = [
    [new URL('../engine/src/generated/event-log.ts', import.meta.url), ts],
    [new URL('../coordinator/internal/eventlog/generated/event_log.go', import.meta.url), go],
];
let mismatch = false;
for (const [target, value] of outputs) {
    try {
        if ((await readFile(target, 'utf8')) !== value) mismatch = true;
    } catch {
        mismatch = true;
    }
    if (!check) await writeFile(target, value);
}
if (check && mismatch) throw new Error('generated event types are stale; run npm run generate');
