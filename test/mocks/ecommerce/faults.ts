/** An outcome the harness forces in place of the actor's real behaviour. */
export type InjectedOutcome = 'retryable-failure' | 'permanent-failure' | 'unknown';

/**
 * The deterministic fault schedule, keyed by `(seed, tool, attempt_no)`.
 *
 * It belongs to the test world rather than to any tool service: a service under test must not know it is being made to
 * fail, and the same schedule has to reach all four services so one scenario can fail across them.
 */
export class FaultSchedule {
    private seed = 'default';
    private faults: Record<string, InjectedOutcome> = {};

    /** Installs a schedule and the seed its keys are relative to. */
    reset(seed = 'default', faults: Record<string, InjectedOutcome> = {}): void {
        this.seed = seed;
        this.faults = {...faults};
    }

    /** Returns the outcome to force for this attempt, or undefined to let the actor run. */
    injected(tool: string, attemptNo: number): InjectedOutcome | undefined {
        return this.faults[`${this.seed}:${tool}:${attemptNo}`];
    }
}
