import type {SubDagProposal} from '../../../engine/src/check-rules.js';

/** A test-only inventory actor with an oracle-visible signed-delta ledger. */
export class MockInventoryService {
    private readonly onHand = new Map<string, number>();
    private readonly holds = new Map<string, {sku: string; quantity: number}>();
    readonly ledger: Array<{operation: string; key: string; sku: string; quantity: number}> = [];

    constructor(initial: Record<string, number>) {
        for (const [sku, quantity] of Object.entries(initial)) this.onHand.set(sku, quantity);
    }

    /** Returns currently available stock after open holds. */
    check(sku: string): number {
        const held = [...this.holds.values()].filter((hold) => hold.sku === sku).reduce((total, hold) => total + hold.quantity, 0);
        return (this.onHand.get(sku) ?? 0) - held;
    }

    /** Creates one idempotent reservation. */
    reserve(key: string, sku: string, quantity: number): void {
        if (this.holds.has(key)) return;
        if (this.check(sku) < quantity) throw new Error(`insufficient mock stock for ${sku}`);
        this.holds.set(key, {sku, quantity});
        this.ledger.push({operation: 'reserve', key, sku, quantity});
    }

    /** Confirms only the delta owned by the named reservation. */
    confirm(key: string): void {
        const hold = this.holds.get(key);
        if (!hold) return;
        this.onHand.set(hold.sku, (this.onHand.get(hold.sku) ?? 0) - hold.quantity);
        this.holds.delete(key);
        this.ledger.push({operation: 'confirm', key, sku: hold.sku, quantity: -hold.quantity});
    }

    /** Releases only the delta owned by the named reservation. */
    release(key: string): void {
        const hold = this.holds.get(key);
        if (!hold) return;
        this.holds.delete(key);
        this.ledger.push({operation: 'release', key, sku: hold.sku, quantity: -hold.quantity});
    }

    /** Returns the number of open holds for oracle assertions. */
    openHoldCount(): number {
        return this.holds.size;
    }
}

/** A test-only payment actor with idempotent authorization and capture. */
export class MockPaymentService {
    private readonly authorizations = new Map<string, number>();
    readonly charges = new Map<string, number>();

    /** Creates one authorization keyed by order. */
    authorize(orderId: string, amount: number): void {
        if (!this.authorizations.has(orderId)) this.authorizations.set(orderId, amount);
    }

    /** Captures an authorization exactly once. */
    capture(orderId: string): void {
        if (this.charges.has(orderId)) return;
        const amount = this.authorizations.get(orderId);
        if (amount === undefined) throw new Error(`missing mock authorization for ${orderId}`);
        this.charges.set(orderId, amount);
    }

    /** Voids an uncaptured authorization idempotently. */
    void(orderId: string): void {
        if (!this.charges.has(orderId)) this.authorizations.delete(orderId);
    }
}

/** A test-only logistics actor with quotes and duplicate-safe bookings. */
export class MockLogisticsService {
    readonly bookings = new Map<string, {carrier: string; postcode: string}>();

    /** Returns a deterministic quote used by the scripted scenario. */
    quote(carrier: string, postcode: string): number {
        return carrier.length * 10 + postcode.length;
    }

    /** Books one shipment per order. */
    book(orderId: string, carrier: string, postcode: string): void {
        if (!this.bookings.has(orderId)) this.bookings.set(orderId, {carrier, postcode});
    }
}

/** A test-only channel actor with buffered drafts and idempotent publication. */
export class MockChannelService {
    private readonly drafts = new Map<string, {sku: string; price: number}>();
    readonly published = new Set<string>();

    /** Buffers one listing draft. */
    draft(listingId: string, sku: string, price: number): void {
        this.drafts.set(listingId, {sku, price});
    }

    /** Publishes a previously buffered listing exactly once. */
    publish(listingId: string): void {
        if (!this.drafts.has(listingId)) throw new Error(`missing mock listing draft ${listingId}`);
        this.published.add(listingId);
    }
}

/** Aggregates all actor views while keeping their ledgers available to test oracles. */
export class MockCommerceWorld {
    readonly inventory = new MockInventoryService({'SKU-1': 100});
    readonly payment = new MockPaymentService();
    readonly logistics = new MockLogisticsService();
    readonly channel = new MockChannelService();
}

/** Builds a two-scope DAG with parallel reads/tries, a confirmation barrier, and two sequential pivots. */
export function createComplexCommerceDag(): SubDagProposal {
    return {
        scopes: [
            {id: 'scope-payment', members: ['reserve', 'authorize', 'capture', 'confirm']},
            {id: 'scope-shipping', members: ['draft', 'book', 'publish']},
        ],
        vertices: [
            {id: 'stock', kind: 'tool', tool: 'inventory.check', parents: []},
            {id: 'quote', kind: 'tool', tool: 'logistics.quote', parents: []},
            {id: 'reserve', kind: 'tool', tool: 'inventory.reserve', scopeId: 'scope-payment', parents: ['stock']},
            {id: 'authorize', kind: 'tool', tool: 'payment.authorize', scopeId: 'scope-payment', parents: []},
            {id: 'payment-ready', kind: 'confirmation-barrier', parents: ['reserve', 'authorize']},
            {id: 'capture', kind: 'tool', tool: 'payment.capture', scopeId: 'scope-payment', parents: ['payment-ready']},
            {id: 'confirm', kind: 'tool', tool: 'inventory.confirm', scopeId: 'scope-payment', confirmedOutput: true, parents: ['capture']},
            {id: 'draft', kind: 'tool', tool: 'channel.draft', scopeId: 'scope-shipping', parents: ['confirm']},
            {id: 'book', kind: 'tool', tool: 'logistics.book', scopeId: 'scope-shipping', parents: ['draft', 'quote']},
            {id: 'publish', kind: 'tool', tool: 'channel.publish', scopeId: 'scope-shipping', parents: ['book']},
        ],
    };
}
