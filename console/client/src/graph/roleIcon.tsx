import type {ConsoleVertex} from '../types/engine.js';

/** Inline glyphs rather than an icon package, for four roles that will not grow. */
export function RoleIcon({role}: {role: ConsoleVertex['role']}): React.JSX.Element {
    const path = {
        planner: 'M3 3h10v2H3zM3 7h7v2H3zM3 11h10v2H3z',
        tool: 'M11 2a4 4 0 0 0-3.5 5.9L2 13.4 3.6 15l5.5-5.5A4 4 0 1 0 11 2z',
        router: 'M2 8h4l2-4 2 8 2-4h2',
        'confirmation-barrier': 'M2 4h12v2H2zM2 10h12v2H2z',
        unknown: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z',
    }[role];
    const stroke = role === 'router' ? 'currentColor' : 'none';
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path d={path} fill={stroke === 'none' ? 'currentColor' : 'none'} stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
