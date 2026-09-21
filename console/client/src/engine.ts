/**
 * The only file allowed to reach into the server's types.
 *
 * Everything else imports from here, so there is one place to review and one place to grep. These
 * are re-exports of the projection's own declarations rather than a mirror of them: a field
 * renamed on the server breaks this build, which is the entire point of the arrangement and only
 * works while `@server/projection/model.ts` stays a type leaf with no runtime imports.
 */
export type {
    ConsoleBracket,
    ConsoleCallCost,
    ConsoleCounterfactual,
    ConsoleDagModel,
    ConsoleDelta,
    ConsoleProposal,
    ConsoleReplan,
    ConsoleRouterOutcome,
    ConsoleRunSummary,
    ConsoleScope,
    ConsoleSnapshot,
    ConsoleSpend,
    ConsoleStreamEvent,
    ConsoleTiming,
    ConsoleTxn,
    ConsoleVertex,
} from '@server/projection/model.js';

export type {PayloadDetail, RetentionUnavailable} from '@server/projection/detail.js';
