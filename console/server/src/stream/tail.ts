import type {RunEventReader} from '../../../../engine/src/log/store.js';
import {advanceConsoleDag, emptyConsoleDag} from '../projection/projection.js';
import {DeltaBuffer} from './stream.js';
import type {ConsoleDagModel, ConsoleDelta} from '../projection/model.js';

/**
 * Follows one run by polling, and folds what it finds.
 *
 * Polling rather than `LISTEN`/`NOTIFY`, and that is not a placeholder. The repository's existing
 * handoff is already a poll — the Coordinator claims work with `FOR UPDATE SKIP LOCKED` — so this
 * is the house mechanism rather than a shortcut around one. Against `NOTIFY` specifically: a
 * trigger would fire on every event of every run whether anyone is watching or not; its queue is
 * bounded, so a stuck listener can make *committing transactions* fail, which is an unacceptable
 * thing for a read-only feature to be able to do; and it is not durable, so a poll has to back it
 * up regardless. {@link TailSource} is the seam to put it behind if measurement ever asks for it.
 *
 * One tailer serves every subscriber to a run. Ten operators watching one run cost one query loop.
 */

/** Delivers a run's newly committed events. One implementation; the seam exists for the next one. */
export interface TailSource {
    /** Events after `afterRunSeq`, in ascending order. */
    poll(runId: string, afterRunSeq: number): Promise<readonly import('../../../../engine/src/log/events.js').StoredEvent[]>;
}

/** Polls the event log directly, which is what the database already supports well. */
export class PollingTailSource implements TailSource {
    constructor(
        private readonly reader: RunEventReader,
        private readonly batchSize = 512,
    ) {}

    poll(runId: string, afterRunSeq: number) {
        return this.reader.readStreamAfter(runId, afterRunSeq, this.batchSize);
    }
}

/** What a subscriber is handed as the run advances. */
export type TailListener = (deltas: readonly ConsoleDelta[], model: ConsoleDagModel) => void;

export interface RunTailerOptions {
    /** How often to look while events are arriving. */
    activeIntervalMs?: number;
    /** How often to look once nothing has happened for a while. */
    idleIntervalMs?: number;
    /** Quiet polls before backing off to the idle interval. */
    idleAfterPolls?: number;
    /** How many recent deltas stay replayable for a reconnecting subscriber. */
    bufferSize?: number;
}

/**
 * One run's fold, kept current, shared by everyone watching it.
 *
 * The tailer owns the model and the recent deltas; subscribers own neither. That is what keeps a
 * second fold from appearing: a late subscriber is handed the model, not the events.
 */
export class RunTailer {
    readonly buffer: DeltaBuffer;
    private model: ConsoleDagModel;
    private readonly listeners = new Set<TailListener>();
    private timer: NodeJS.Timeout | null = null;
    private quietPolls = 0;
    private polling = false;
    private readonly active: number;
    private readonly idle: number;
    private readonly idleAfter: number;

    constructor(
        readonly runId: string,
        private readonly source: TailSource,
        options: RunTailerOptions = {},
    ) {
        this.model = emptyConsoleDag(runId);
        this.buffer = new DeltaBuffer(options.bufferSize ?? 512);
        this.active = options.activeIntervalMs ?? 250;
        this.idle = options.idleIntervalMs ?? 2000;
        this.idleAfter = options.idleAfterPolls ?? 10;
    }

    /** The current model. A subscriber reads this rather than folding anything itself. */
    get current(): ConsoleDagModel {
        return this.model;
    }

    /** Reads everything outstanding now, so a first subscriber does not wait for a tick. */
    async prime(): Promise<ConsoleDagModel> {
        await this.pollOnce();
        return this.model;
    }

    subscribe(listener: TailListener): () => void {
        this.listeners.add(listener);
        this.schedule(this.active);
        return () => {
            this.listeners.delete(listener);
            // Nobody is watching, so stop asking. The model stays, so the next subscriber resumes
            // from it rather than re-reading the whole run.
            if (!this.listeners.size) this.stop();
        };
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private schedule(delay: number): void {
        if (this.timer || !this.listeners.size) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick();
        }, delay);
        // A pending poll must never hold the process open on its own; the server's lifetime is the
        // listener's business, not the timer's.
        this.timer.unref?.();
    }

    private async tick(): Promise<void> {
        await this.pollOnce();
        this.schedule(this.quietPolls >= this.idleAfter ? this.idle : this.active);
    }

    private async pollOnce(): Promise<void> {
        // Overlapping polls would fold the same events twice, because the watermark only advances
        // when a fold completes.
        if (this.polling) return;
        this.polling = true;
        try {
            const events = await this.source.poll(this.runId, this.model.at_run_seq);
            if (!events.length) {
                this.quietPolls += 1;
                return;
            }
            this.quietPolls = 0;
            const step = advanceConsoleDag(this.model, events);
            this.model = step.model;
            if (!step.deltas.length) return;
            this.buffer.push(...step.deltas);
            for (const listener of this.listeners) listener(step.deltas, this.model);
        } finally {
            this.polling = false;
        }
    }
}

/** Holds one tailer per run, so subscribers to the same run share a poll loop. */
export class TailerRegistry {
    private readonly tailers = new Map<string, RunTailer>();

    constructor(
        private readonly source: TailSource,
        private readonly options: RunTailerOptions = {},
    ) {}

    for(runId: string): RunTailer {
        const existing = this.tailers.get(runId);
        if (existing) return existing;
        const tailer = new RunTailer(runId, this.source, this.options);
        this.tailers.set(runId, tailer);
        return tailer;
    }

    stopAll(): void {
        for (const tailer of this.tailers.values()) tailer.stop();
        this.tailers.clear();
    }
}
