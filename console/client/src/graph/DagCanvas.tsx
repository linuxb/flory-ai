import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, type Node, type NodeMouseHandler} from '@xyflow/react';
import {DEFAULT_LAYOUT, layout, type LayoutResult} from './layout.js';
import {toFlow, type FlowNode} from './toFlow.js';
import {VertexCard} from './VertexCard.js';
import {ScopeEnclosure} from './ScopeEnclosure.js';
import {CanvasControls} from './CanvasControls.js';
import type {ConsoleDagModel, ConsoleVertex} from '../engine.js';

const NODE_TYPES = {vertex: VertexCard, scope: ScopeEnclosure};

export interface DagCanvasProps {
    model: ConsoleDagModel;
    selectedVertexId: string | null;
    onSelect: (vertexId: string | null) => void;
}

export function DagCanvas(props: DagCanvasProps): React.JSX.Element {
    return (
        <ReactFlowProvider>
            <Canvas {...props} />
        </ReactFlowProvider>
    );
}

/** Status colour for the mini-map, read from the same variables the cards use. */
function miniMapColor(node: Node): string {
    if (node.type === 'scope') return 'transparent';
    const vertex = (node.data as {vertex: ConsoleVertex}).vertex;
    return `var(--status-${vertex.status})`;
}

function Canvas({model, selectedVertexId, onSelect}: DagCanvasProps): React.JSX.Element {
    const flow = useReactFlow();
    // React Flow measures a node after it mounts, and `fitView` before that measurement computes
    // a viewport from zero-sized nodes and silently does nothing. This is the library's own signal
    // that every node has been measured.
    const measured = useNodesInitialized();
    // The layout of the previous frame, which is what makes stability a guarantee: every vertex
    // already on screen keeps the exact `(layer, index)` it was given.
    const previous = useRef<LayoutResult | undefined>(undefined);
    const fitted = useRef<string | null>(null);
    const known = useRef(new Set<string>());
    const [pending, setPending] = useState<string[]>([]);

    const placed = useMemo(() => {
        const next = layout(model, DEFAULT_LAYOUT, previous.current);
        previous.current = next;
        return next;
    }, [model]);

    const graph = useMemo(() => toFlow(model, placed), [model, placed]);

    // Held in React Flow's own state, and fed back through `onNodesChange`, because that callback
    // is how the library returns a node's measured size. Passing a freshly built array on every
    // render instead drops every measurement, and `fitView` then computes a viewport from nodes it
    // believes are zero-sized — which looks exactly like `fitView` not being called at all.
    const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
    useEffect(() => {
        setNodes((current) => {
            const sizes = new Map(current.map((node) => [node.id, node.measured]));
            return graph.nodes.map((node) => ({...node, measured: sizes.get(node.id), selected: node.id === selectedVertexId}));
        });
    }, [graph.nodes, selectedVertexId, setNodes]);

    // Fitted once per run, and deliberately not once per snapshot. A resync replaces the model
    // but not the session: a reconnect during an incident must not throw away the pan an operator
    // spent the incident establishing. Opening a different run is the only thing that refits.
    useEffect(() => {
        if (!measured || fitted.current === model.run_id || !model.vertices.length) return;
        fitted.current = model.run_id;
        known.current = new Set(model.vertices.map((vertex) => vertex.vertex_id));
        setPending([]);
        // Capped at 1:1. A run is opened while it is still short — often one vertex — and an
        // uncapped fit magnifies that single card to fill the pane, so the operator's first sight
        // of the run is a wall of one node that then shrinks as work arrives.
        void flow.fitView({padding: 0.2, duration: 0, maxZoom: 1});
    }, [flow, measured, model.run_id, model.vertices]);

    useEffect(() => {
        if (fitted.current !== model.run_id) return;
        const fresh = model.vertices.filter((vertex) => !known.current.has(vertex.vertex_id)).map((vertex) => vertex.vertex_id);
        if (!fresh.length) return;
        for (const id of fresh) known.current.add(id);
        setPending((current) => [...current, ...fresh]);
    }, [model.run_id, model.vertices]);

    const follow = useCallback(() => {
        const target = pending[pending.length - 1];
        setPending([]);
        const spot = target ? placed.vertices.get(target) : undefined;
        if (!spot) return;
        // Pan to it and leave the zoom alone: the operator chose that zoom.
        void flow.setCenter(spot.x + DEFAULT_LAYOUT.nodeWidth / 2, spot.y + DEFAULT_LAYOUT.nodeHeight / 2, {duration: 320, zoom: flow.getZoom()});
    }, [flow, pending, placed]);

    const onNodeClick = useCallback<NodeMouseHandler>((_event, node) => onSelect(node.type === 'vertex' ? node.id : null), [onSelect]);

    return (
        <div className="dag-canvas">
            <ReactFlow
                nodes={nodes}
                edges={graph.edges}
                onNodesChange={onNodesChange}
                nodeTypes={NODE_TYPES}
                onNodeClick={onNodeClick}
                onPaneClick={() => onSelect(null)}
                nodesDraggable={false}
                nodesConnectable={false}
                edgesFocusable={false}
                elementsSelectable
                proOptions={{hideAttribution: false}}
                minZoom={0.15}
                maxZoom={1.75}
            >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
                <MiniMap pannable zoomable nodeColor={miniMapColor} nodeStrokeWidth={0} maskColor="var(--minimap-mask)" />
            </ReactFlow>
            <CanvasControls pending={pending} onFollow={follow} />
        </div>
    );
}
