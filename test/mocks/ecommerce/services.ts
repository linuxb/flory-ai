import type {SubDagProposal} from '../../../engine/src/check-rules.js';

/** A test-only inventory actor with an oracle-visible signed-delta ledger. */
export class MockInventoryService {
    private readonly onHand = new Map<string, number>();
    private readonly holds = new Map<string, {sku: string; quantity: number}>();
    private readonly received = new Set<string>();
    readonly ledger: Array<{operation: string; key: string; sku: string; quantity: number}> = [];

    constructor(initial: Record<string, number>) {
        for (const [sku, quantity] of Object.entries(initial)) this.onHand.set(sku, quantity);
    }

    /** Returns currently available stock after open holds. */
    check(sku: string): number {
        const held = [...this.holds.values()].filter((hold) => hold.sku === sku).reduce((total, hold) => total + hold.quantity, 0);
        return (this.onHand.get(sku) ?? 0) - held;
    }

    /** Lands wholesale stock in the warehouse, idempotently per purchase order. */
    receive(purchaseOrderId: string, sku: string, quantity: number): number {
        if (this.received.has(purchaseOrderId)) return this.onHand.get(sku) ?? 0;
        this.received.add(purchaseOrderId);
        this.onHand.set(sku, (this.onHand.get(sku) ?? 0) + quantity);
        this.ledger.push({operation: 'receive', key: purchaseOrderId, sku, quantity});
        return this.onHand.get(sku) ?? 0;
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

/** One supplier's standing terms for one product, as a B2B catalogue would publish them. */
export interface SupplierTerms {
    supplier_id: string;
    sku: string;
    category: string;
    unit_cost: number;
    moq: number;
    lead_time_days: number;
}

/**
 * A test-only wholesale catalogue the retailer sources from.
 *
 * Deterministic and read-only: sourcing is where a retailer gathers facts, and every side effect in
 * this world belongs to the actors below it. Keeping it effect-free is what lets a rule template
 * decide on its output at a savepoint without opening a transaction.
 */
export class MockSupplierService {
    private readonly terms: readonly SupplierTerms[] = [
        {supplier_id: 'SUP-ANHUI', sku: 'SKU-ESP-01', category: 'portable-espresso', unit_cost: 34, moq: 50, lead_time_days: 21},
        {supplier_id: 'SUP-SHENZHEN', sku: 'SKU-ESP-02', category: 'portable-espresso', unit_cost: 41, moq: 20, lead_time_days: 9},
        {supplier_id: 'SUP-VIC', sku: 'SKU-ESP-03', category: 'portable-espresso', unit_cost: 58, moq: 10, lead_time_days: 3},
    ];

    /** Lists the catalogue for one category, cheapest first. */
    search(category: string): SupplierTerms[] {
        return this.terms.filter((entry) => entry.category === category).sort((first, second) => first.unit_cost - second.unit_cost);
    }

    /**
     * Returns one supplier's terms for a quantity, and whether it will actually sell at it.
     *
     * A quantity below the minimum order is answered, not refused: it is a fact about the supplier,
     * and a quote tool that threw on it would turn ordinary commercial information into a tool
     * failure the workflow has to recover from.
     */
    quote(supplierId: string, quantity: number): SupplierTerms & {total_cost: number; quotable: boolean; reason: string} {
        const entry = this.terms.find((candidate) => candidate.supplier_id === supplierId);
        if (!entry) throw new Error(`unknown mock supplier ${supplierId}`);
        const quotable = quantity >= entry.moq;
        return {
            ...entry,
            total_cost: entry.unit_cost * quantity,
            quotable,
            reason: quotable ? 'terms available at this quantity' : `minimum order is ${entry.moq}`,
        };
    }
}

/** A test-only demand signal, the read a retailer prices and sizes an order against. */
export class MockMarketService {
    private readonly signals: Record<string, {trend: string; sell_price: number; competitor_count: number; monthly_units: number}> = {
        'portable-espresso': {trend: 'surging', sell_price: 89, competitor_count: 4, monthly_units: 1800},
        'wired-earbuds': {trend: 'declining', sell_price: 12, competitor_count: 57, monthly_units: 300},
    };

    /** Returns the demand signal for a category, or throws when the platform tracks none. */
    demand(category: string): {trend: string; sell_price: number; competitor_count: number; monthly_units: number} {
        const signal = this.signals[category];
        if (!signal) throw new Error(`no mock demand signal for ${category}`);
        return signal;
    }
}

/** Aggregates all actor views while keeping their ledgers available to test oracles. */
export class MockCommerceWorld {
    readonly inventory = new MockInventoryService({'SKU-1': 100, 'SKU-ESP-01': 0, 'SKU-ESP-02': 0, 'SKU-ESP-03': 6});
    readonly payment = new MockPaymentService();
    readonly logistics = new MockLogisticsService();
    readonly channel = new MockChannelService();
    readonly supplier = new MockSupplierService();
    readonly market = new MockMarketService();
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
